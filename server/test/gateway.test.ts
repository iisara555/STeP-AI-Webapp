import { provisionTestQuota } from './support/quota.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AuditEntry } from '../src/gateway/audit.ts';
import type { Authenticator, Identity } from '../src/gateway/auth.ts';
import { createGateway } from '../src/gateway/http.ts';
import { QuotaStore } from '../src/gateway/quota-store.ts';
import { DEFAULT_QUOTAS, RunService, type Quotas } from '../src/gateway/runs.ts';
import type {
  AskResult,
  ConversationMessage,
  RuntimeDriver,
  RuntimeEvent,
} from '../src/workspace/contract.ts';
import { RuntimeManager } from '../src/workspace/manager.ts';
import { heldDriver } from './support/held-driver.ts';

const ORIGIN = 'https://step.example';
const PEOPLE: Record<string, Identity> = {
  alice: { userId: 'alice', email: 'alice@step.example', admin: false },
  bob: { userId: 'bob', email: 'bob@step.example', admin: false },
  root: { userId: 'root', email: 'root@step.example', admin: true },
};
const authenticate: Authenticator = async (header) => PEOPLE[header?.replace(/^Bearer /, '') ?? ''] ?? null;

async function withGateway(
  fn: (g: {
    url: string;
    call: (who: string, path: string, init?: RequestInit) => Promise<Response>;
    runtime: ReturnType<typeof heldDriver>;
    audit: AuditEntry[];
  }) => Promise<void>,
  quotas: Quotas = DEFAULT_QUOTAS,
  durableQuota = false,
) {
  const dataRoot = await mkdtemp(join(tmpdir(), 'step-gateway-'));
  provisionTestQuota(dataRoot, quotas.workspacesPerUser);
  const runtime = heldDriver();
  const manager = new RuntimeManager({
    workspacesPerUser: quotas.workspacesPerUser,
    dataRoot,
    driver: runtime.driver,
  });
  const audit: AuditEntry[] = [];
  const record = (entry: AuditEntry) => void audit.push(entry);
  const store = durableQuota ? new QuotaStore(join(dataRoot, 'quota.sqlite')) : undefined;
  const server = createGateway({
    manager,
    runs: new RunService(manager, record, quotas, Date.now, store),
    authenticate,
    audit: record,
    origin: ORIGIN,
    quotas,
    heartbeatMs: 60_000,
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = (who: string, path: string, init: RequestInit = {}) =>
    fetch(url + path, {
      ...init,
      headers: {
        authorization: `Bearer ${who}`,
        ...(init.body ? { 'content-type': 'application/json' } : {}),
        ...(init.headers as Record<string, string>),
      },
    });
  try {
    await fn({ url, call, runtime, audit });
  } finally {
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
    await manager.shutdown();
    store?.close();
    await rm(dataRoot, { recursive: true, force: true });
  }
}

const post = (body: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(body) });

test('concurrent HTTP requests cannot exceed the durable daily run quota', async () => {
  await withGateway(
    async ({ call }) => {
      const workspace = await (await call('alice', '/api/workspaces', post({ name: 'quota' }))).json();
      const responses = await Promise.all(
        Array.from({ length: 12 }, () =>
          call('alice', `/api/workspaces/${workspace.id}/runs`, post({ text: 'synthetic' })),
        ),
      );
      assert.equal(responses.filter((response) => response.status === 202).length, 2);
      for (const response of responses.filter((response) => response.status !== 202)) {
        assert.equal(response.status, 429);
        assert.deepEqual(await response.json(), { code: 'QUOTA_DAILY_RUNS' });
      }
      const conversations = await (
        await call('alice', `/api/workspaces/${workspace.id}/conversations`)
      ).json();
      assert.equal(conversations.length, 2, 'rejected admissions must not create conversations');
    },
    { workspacesPerUser: 2, activeRunsPerUser: 20, runsPerUserPerDay: 2 },
    true,
  );
});

test('gateway restart retains daily admissions under concurrent HTTP requests', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'step-gateway-restart-'));
  const quotas = { workspacesPerUser: 2, activeRunsPerUser: 20, runsPerUserPerDay: 3 };
  let server: ReturnType<typeof createGateway> | undefined;
  let manager: RuntimeManager | undefined;
  let store: QuotaStore | undefined;
  async function start() {
    manager = new RuntimeManager({
      workspacesPerUser: quotas.workspacesPerUser,
      dataRoot,
      driver: heldDriver().driver,
    });
    store = new QuotaStore(join(dataRoot, 'quota.sqlite'));
    const audit = () => {};
    server = createGateway({
      manager,
      runs: new RunService(manager, audit, quotas, Date.now, store),
      authenticate,
      audit,
      quotas,
    });
    await new Promise<void>((done) => server!.listen(0, '127.0.0.1', done));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return (path: string, init: RequestInit = {}) =>
      fetch(url + path, {
        ...init,
        headers: {
          authorization: 'Bearer alice',
          ...(init.body ? { 'content-type': 'application/json' } : {}),
        },
      });
  }
  async function stop() {
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((done) => server!.close(() => done()));
      server = undefined;
    }
    await manager?.shutdown();
    manager = undefined;
    store?.close();
    store = undefined;
  }
  try {
    // Provision once: restarting the gateway must only reopen the existing policy.
    provisionTestQuota(dataRoot, quotas.workspacesPerUser);
    let call = await start();
    const workspace = await (await call('/api/workspaces', post({ name: 'restart' }))).json();
    const path = `/api/workspaces/${workspace.id}/runs`;
    assert.equal((await call(path, post({ text: 'before restart' }))).status, 202);
    await stop();
    call = await start();
    const results = await Promise.all(
      Array.from({ length: 10 }, () => call(path, post({ text: 'after restart' }))),
    );
    assert.equal(results.filter((response) => response.status === 202).length, 2);
    for (const response of results.filter((response) => response.status !== 202)) {
      assert.equal(response.status, 429);
      assert.deepEqual(await response.json(), { code: 'QUOTA_DAILY_RUNS' });
    }
  } finally {
    await stop();
    await rm(dataRoot, { recursive: true, force: true });
  }
});

/** Reads server-sent events until `enough` says so, then closes the connection like a closed browser tab. */
async function readEvents(
  response: Response,
  controller: AbortController,
  enough: (events: { id: number; type: string; data: any }[]) => boolean,
) {
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);
  const events: { id: number; type: string; data: any }[] = [];
  const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  while (!enough(events)) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    let end: number;
    while ((end = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const field = (name: string) => new RegExp(`^${name}: (.*)$`, 'm').exec(block)?.[1];
      if (field('event'))
        events.push({ id: Number(field('id')), type: field('event')!, data: JSON.parse(field('data')!) });
    }
  }
  controller.abort();
  await reader.cancel().catch(() => {});
  return events;
}

async function until<T>(check: () => Promise<T | undefined>, ms = 3_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value !== undefined) return value;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((done) => setTimeout(done, 20));
  }
}

test('without an invited identity, or from another site, nothing but the liveness check answers', async () => {
  await withGateway(async ({ url, call }) => {
    assert.equal((await fetch(url + '/healthz')).status, 200);
    const anonymous = await fetch(url + '/api/workspaces');
    assert.equal(anonymous.status, 401);
    assert.deepEqual(await anonymous.json(), { code: 'UNAUTHENTICATED' });
    assert.equal((await call('mallory', '/api/workspaces')).status, 401);
    const foreign = await call('alice', '/api/workspaces', { headers: { origin: 'https://evil.example' } });
    assert.equal(foreign.status, 403);
    assert.equal(foreign.headers.get('access-control-allow-origin'), null);
    const ours = await call('alice', '/api/workspaces', { headers: { origin: ORIGIN } });
    assert.equal(ours.status, 200);
    assert.equal(ours.headers.get('access-control-allow-origin'), ORIGIN);
    const preflight = await fetch(url + '/api/workspaces', {
      method: 'OPTIONS',
      headers: { origin: ORIGIN },
    });
    assert.equal(preflight.status, 204);
    assert.match(preflight.headers.get('access-control-allow-headers') ?? '', /Last-Event-ID/);
  });
});

test('a run keeps going after the browser closes; a returning client catches up, then reads the answer', async () => {
  await withGateway(async ({ call, runtime }) => {
    const workspace = await (await call('alice', '/api/workspaces', post({ name: 'งานสัมมนา' }))).json();
    const started = await call(
      'alice',
      `/api/workspaces/${workspace.id}/runs`,
      post({ text: 'ติดต่อฝ่ายบุคคลช่องทางไหน' }),
    );
    assert.equal(started.status, 202);
    const run = await started.json();
    assert.equal(run.status, 'running');
    assert.match(run.sessionId, /^c\d+$/);

    const first = new AbortController();
    const response = await call('alice', `/api/workspaces/${workspace.id}/events`, { signal: first.signal });
    const promised = readEvents(response, first, (events) => events.some((e) => e.type === 'delta'));
    runtime.say(run.sessionId, 'ส่วนแรก ');
    const seen = await promised;
    assert.deepEqual(
      seen.map((e) => [e.type, e.data.status ?? e.data.text]),
      [
        ['run', 'running'],
        ['delta', 'ส่วนแรก '],
      ],
    );

    // The tab is closed. The runtime finishes with no one listening.
    runtime.answer(run.sessionId, 'ติดต่อผ่านระบบ HR');
    const done = await until(async () => {
      const current = await (await call('alice', `/api/workspaces/${workspace.id}/runs/${run.id}`)).json();
      return current.status === 'running' ? undefined : current;
    });
    assert.equal(done.status, 'done');

    // Coming back with the last id seen replays only what was missed.
    const again = new AbortController();
    const replay = await readEvents(
      await call('alice', `/api/workspaces/${workspace.id}/events`, {
        signal: again.signal,
        headers: { 'last-event-id': String(seen.at(-1)!.id) },
      }),
      again,
      (events) => events.some((e) => e.type === 'run'),
    );
    assert.deepEqual(
      replay.map((e) => e.type),
      ['delta', 'run'],
    );
    assert.equal(replay[1].data.status, 'done');
    assert.equal(replay[1].data.answer, 'ติดต่อผ่านระบบ HR');
    assert.deepEqual(replay[1].data.sources, ['hr-service-channels']);

    const messages = await (
      await call('alice', `/api/workspaces/${workspace.id}/conversations/${run.sessionId}/messages`)
    ).json();
    assert.deepEqual(
      messages.map((m: ConversationMessage) => m.role),
      ['user', 'assistant'],
    );

    // An empty conversation can be made first, as the web app does before the first question.
    const empty = await call('alice', `/api/workspaces/${workspace.id}/conversations`, { method: 'POST' });
    assert.equal(empty.status, 200);
    assert.match((await empty.json()).sessionId, /^c\d+$/);
    assert.equal(
      (await call('bob', `/api/workspaces/${workspace.id}/conversations`, { method: 'POST' })).status,
      404,
    );

    // A later question continues the same conversation.
    const followUp = await (
      await call(
        'alice',
        `/api/workspaces/${workspace.id}/runs`,
        post({ text: 'ต่ออีกข้อ', sessionId: run.sessionId }),
      )
    ).json();
    assert.equal(followUp.sessionId, run.sessionId);
  });
});

test('a running run can be cancelled from a new connection, and only once', async () => {
  await withGateway(async ({ call, runtime }) => {
    const workspace = await (await call('alice', '/api/workspaces', post({ name: 'งานยาว' }))).json();
    const run = await (
      await call('alice', `/api/workspaces/${workspace.id}/runs`, post({ text: 'ร่าง TOR ยาว' }))
    ).json();
    const cancel = await call('alice', `/api/workspaces/${workspace.id}/runs/${run.id}/cancel`, {
      method: 'POST',
    });
    assert.equal(cancel.status, 200);
    assert.deepEqual(runtime.cancels, [run.sessionId]);
    const ended = await until(async () => {
      const current = await (await call('alice', `/api/workspaces/${workspace.id}/runs/${run.id}`)).json();
      return current.status === 'running' ? undefined : current;
    });
    assert.deepEqual([ended.status, ended.code], ['cancelled', 'CANCELLED']);
    const twice = await call('alice', `/api/workspaces/${workspace.id}/runs/${run.id}/cancel`, {
      method: 'POST',
    });
    assert.equal(twice.status, 409);
    assert.deepEqual(await twice.json(), { code: 'RUN_NOT_ACTIVE' });
  });
});

test('another user cannot see, follow or cancel someone else’s Workspace or run', async () => {
  await withGateway(async ({ call }) => {
    const mine = await (await call('alice', '/api/workspaces', post({ name: 'ของอลิซ' }))).json();
    const run = await (
      await call('alice', `/api/workspaces/${mine.id}/runs`, post({ text: 'คำถามส่วนตัว' }))
    ).json();
    const theirs = await (await call('bob', '/api/workspaces', post({ name: 'ของบ๊อบ' }))).json();
    assert.deepEqual(
      (await (await call('bob', '/api/workspaces')).json()).map((w: { id: string }) => w.id),
      [theirs.id],
    );
    for (const [method, path] of [
      ['GET', `/api/workspaces/${mine.id}`],
      ['POST', `/api/workspaces/${mine.id}/start`],
      ['POST', `/api/workspaces/${mine.id}/stop`],
      ['GET', `/api/workspaces/${mine.id}/conversations`],
      ['GET', `/api/workspaces/${mine.id}/conversations/${run.sessionId}/messages`],
      ['GET', `/api/workspaces/${mine.id}/runs`],
      ['GET', `/api/workspaces/${mine.id}/runs/${run.id}`],
      ['POST', `/api/workspaces/${mine.id}/runs/${run.id}/cancel`],
      ['GET', `/api/workspaces/${mine.id}/events`],
      // Naming the run under one's own Workspace does not reach it either.
      ['GET', `/api/workspaces/${theirs.id}/runs/${run.id}`],
      ['POST', `/api/workspaces/${theirs.id}/runs/${run.id}/cancel`],
    ]) {
      const response = await call('bob', path, { method });
      assert.equal(response.status, 404, `${method} ${path}`);
    }
    const sent = await call('bob', `/api/workspaces/${mine.id}/runs`, post({ text: 'แทรก' }));
    assert.equal(sent.status, 404);
    assert.equal(
      (await (await call('alice', `/api/workspaces/${mine.id}/runs/${run.id}`)).json()).status,
      'running',
    );
  });
});

test('quotas limit Workspaces, runs at once and runs per day for each user', async () => {
  await withGateway(
    async ({ call, runtime }) => {
      const workspace = await (await call('alice', '/api/workspaces', post({ name: 'หนึ่ง' }))).json();
      const second = await call('alice', '/api/workspaces', post({ name: 'สอง' }));
      assert.deepEqual([second.status, await second.json()], [429, { code: 'QUOTA_WORKSPACES' }]);
      assert.equal((await call('bob', '/api/workspaces', post({ name: 'ของบ๊อบ' }))).status, 200);

      const runs = `/api/workspaces/${workspace.id}/runs`;
      const a = await (await call('alice', runs, post({ text: 'หนึ่ง' }))).json();
      const sameConversation = await call('alice', runs, post({ text: 'ซ้อน', sessionId: a.sessionId }));
      assert.deepEqual(
        [sameConversation.status, await sameConversation.json()],
        [409, { code: 'RUN_ALREADY_ACTIVE' }],
      );
      const b = await (await call('alice', runs, post({ text: 'สอง' }))).json();
      const third = await call('alice', runs, post({ text: 'สาม' }));
      assert.deepEqual([third.status, await third.json()], [429, { code: 'QUOTA_ACTIVE_RUNS' }]);

      runtime.answer(a.sessionId, 'ก');
      runtime.answer(b.sessionId, 'ข');
      await until(async () => {
        const list = await (await call('alice', runs)).json();
        return list.every((run: { status: string }) => run.status !== 'running') ? true : undefined;
      });
      const overDaily = await call('alice', runs, post({ text: 'สี่' }));
      assert.deepEqual([overDaily.status, await overDaily.json()], [429, { code: 'QUOTA_DAILY_RUNS' }]);
    },
    { workspacesPerUser: 1, activeRunsPerUser: 2, runsPerUserPerDay: 2 },
  );
});

test('administrators see counts only; the audit trail keeps who/what/outcome without content', async () => {
  await withGateway(async ({ call, runtime, audit }) => {
    const workspace = await (await call('alice', '/api/workspaces', post({ name: 'ชื่องานลับ' }))).json();
    const run = await (
      await call('alice', `/api/workspaces/${workspace.id}/runs`, post({ text: 'ข้อความส่วนตัวมาก' }))
    ).json();
    runtime.answer(run.sessionId, 'คำตอบส่วนตัวมาก');
    await until(async () =>
      (await (await call('alice', `/api/workspaces/${workspace.id}/runs/${run.id}`)).json()).status === 'done'
        ? true
        : undefined,
    );

    assert.deepEqual([(await call('alice', '/api/admin/health')).status], [403]);
    const health = await call('root', '/api/admin/health');
    assert.equal(health.status, 200);
    const text = await health.text();
    const body = JSON.parse(text);
    assert.equal(body.runtimes.running, 1);
    assert.equal(body.runs.active, 0);
    assert.deepEqual(body.runs.today, { started: 1, done: 1, failed: 0, cancelled: 0 });
    // Administrators do not get Workspace content, names or owners by being administrators.
    for (const secret of ['ชื่องานลับ', 'ข้อความส่วนตัวมาก', 'คำตอบส่วนตัวมาก', 'alice', workspace.id])
      assert.ok(!text.includes(secret), secret);
    // Nor can they open the Workspace.
    assert.equal((await call('root', `/api/workspaces/${workspace.id}`)).status, 404);

    assert.deepEqual(
      audit.map((entry) => `${entry.action}:${entry.outcome}`),
      ['workspace.create:created', 'run.start:accepted', 'run.finish:done'],
    );
    const trail = JSON.stringify(audit);
    for (const secret of ['ชื่องานลับ', 'ข้อความส่วนตัวมาก', 'คำตอบส่วนตัวมาก'])
      assert.ok(!trail.includes(secret), secret);
  });
});

test('requests are validated before they reach a runtime', async () => {
  await withGateway(async ({ url, call }) => {
    const workspace = await (await call('alice', '/api/workspaces', post({ name: 'ตรวจ' }))).json();
    const runs = `/api/workspaces/${workspace.id}/runs`;
    const cases: [RequestInit, number, string][] = [
      [{ method: 'POST', body: '{', headers: { 'content-type': 'application/json' } }, 400, 'INVALID_JSON'],
      [
        { method: 'POST', body: JSON.stringify({ text: 'x' }), headers: { 'content-type': 'text/plain' } },
        400,
        'INVALID_JSON',
      ],
      [post({ text: '   ' }), 400, 'INVALID_INPUT'],
      [post({ text: 'x'.repeat(70_000) }), 413, 'BODY_TOO_LARGE'],
    ];
    for (const [init, status, code] of cases) {
      const response = await call('alice', runs, init);
      assert.deepEqual([response.status, await response.json()], [status, { code }]);
    }
    assert.equal((await call('alice', '/api/workspaces/../../etc/passwd')).status, 404);
    assert.equal((await call('alice', '/api/workspaces/ws_123')).status, 404);
    assert.equal((await call('alice', '/api/workspaces', post({ name: '' }))).status, 400);
    const badCursor = await call('alice', `/api/workspaces/${workspace.id}/events`, {
      headers: { 'last-event-id': '-1' },
    });
    assert.equal(badCursor.status, 400);
    assert.equal((await fetch(url + '/healthz', { method: 'POST' })).status, 401);
  });
});

test('admin invitations grant and revoke access, persist across store reopen, and never grant workspace ownership', async () => {
  const { InvitationStore } = await import('../src/gateway/invitation-store.ts');
  const dir = await mkdtemp(join(tmpdir(), 'step-invites-'));
  const path = join(dir, 'invites.sqlite');
  let store = new InvitationStore(path, ['step.example'], new Set(['root@step.example']));
  const runtime = heldDriver();
  const manager = new RuntimeManager({
    workspacesPerUser: 10,
    dataRoot: provisionTestQuota(dir, 10),
    driver: runtime.driver,
  });
  const record = () => {};
  const base = new Set(['root@step.example', 'bob@step.example', 'alice@step.example']);
  store.change('root@step.example', 'alice@step.example', false, base);
  const auth: Authenticator = async (header) => {
    const who = PEOPLE[header?.replace(/^Bearer /, '') ?? ''];
    return who && store.invited(base).has(who.email) ? who : null;
  };
  const server = createGateway({
    manager,
    runs: new RunService(manager, record),
    audit: record,
    authenticate: auth,
    invitations: new Proxy(store, {
      get: (_target, key) => {
        const value = Reflect.get(store, key);
        return typeof value === 'function' ? value.bind(store) : value;
      },
    }),
    baseInvitations: () => base,
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = (person: string, path: string, init: RequestInit = {}) =>
    fetch(url + path, {
      ...init,
      headers: {
        authorization: `Bearer ${person}`,
        ...(init.body ? { 'content-type': 'application/json' } : {}),
      },
    });
  try {
    assert.equal((await call('alice', '/api/me')).status, 401);
    assert.equal(
      (await call('root', '/api/admin/invitations', post({ email: 'x@evil.example' }))).status,
      400,
    );
    assert.equal(
      (await call('root', '/api/admin/invitations', post({ email: 'x@step.example', admin: true }))).status,
      400,
    );
    assert.equal(
      (await call('root', '/api/admin/invitations/revoke', post({ email: 'root@step.example' }))).status,
      403,
    );
    assert.equal(
      (await call('root', '/api/admin/invitations/revoke', post({ email: 'bob@step.example' }))).status,
      200,
    );
    assert.equal((await call('bob', '/api/me')).status, 401);
    assert.equal(
      (await call('root', '/api/admin/invitations', post({ email: 'bob@step.example' }))).status,
      200,
    );
    assert.equal(
      (await call('bob', '/api/admin/invitations', post({ email: 'alice@step.example' }))).status,
      403,
    );
    assert.equal(
      (await call('root', '/api/admin/invitations', post({ email: 'Alice@step.example' }))).status,
      200,
    );
    assert.equal((await call('alice', '/api/me')).status, 200);
    assert.equal((await call('bob', '/api/admin/invitations')).status, 403);
    assert.deepEqual(await (await call('root', '/api/admin/invitations')).json(), {
      emails: ['alice@step.example', 'bob@step.example', 'root@step.example'],
    });
    const workspace = await (await call('alice', '/api/workspaces', post({ name: 'private' }))).json();
    assert.equal((await call('root', `/api/workspaces/${workspace.id}`)).status, 404);
    store.close();
    store = new InvitationStore(path, ['step.example'], new Set(['root@step.example']));
    assert.equal((await call('alice', '/api/me')).status, 200);
    assert.equal(
      (await call('root', '/api/admin/invitations/revoke', post({ email: 'alice@step.example' }))).status,
      200,
    );
    assert.equal((await call('alice', '/api/me')).status, 401);
    store.close();
    store = new InvitationStore(path, ['step.example'], new Set(['root@step.example']));
    assert.equal((await call('alice', '/api/me')).status, 401);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
    await manager.shutdown();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('removing an operator invitation cannot be overridden by a managed grant', async () => {
  const { InvitationStore } = await import('../src/gateway/invitation-store.ts');
  const store = new InvitationStore(':memory:', ['step.example'], new Set(['root@step.example']));
  try {
    const base = new Set(['root@step.example', 'bob@step.example']);
    store.change('root@step.example', 'bob@step.example', true, base);
    base.delete('bob@step.example');
    assert.equal(store.invited(base).has('bob@step.example'), false);
    assert.throws(() => store.change('root@step.example', 'bob@step.example', true, base), /FORBIDDEN/);
    base.add('bob@step.example');
    assert.equal(store.invited(base).has('bob@step.example'), true);
  } finally {
    store.close();
  }
});

test('an open event stream stops before delivering an event after revocation', async () => {
  let allowed = true;
  let emit!: (event: { id: number; type: string; data: unknown }) => void;
  let stopped = false;
  const server = createGateway({
    manager: { workspacesPerUser: 10 } as RuntimeManager,
    runs: {
      follow: async (_u: string, _w: string, _a: number, cb: typeof emit) => {
        emit = cb;
        return () => {
          stopped = true;
        };
      },
    } as unknown as RunService,
    authenticate: async () => (allowed ? PEOPLE.alice : null),
    audit: () => {},
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  try {
    const response = await fetch(
      `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/workspaces/ws_${'a'.repeat(32)}/events`,
    );
    const reader = response.body!.getReader();
    await reader.read();
    allowed = false;
    emit({ id: 1, type: 'message', data: 'private-after-revocation' });
    const result = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('stream did not close')), 1000)),
    ]);
    assert.equal(result.done, true, `received ${new TextDecoder().decode(result.value)}`);
    assert.equal(stopped, true);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  }
});

test('an in-flight private response is withheld after revocation', async () => {
  let allowed = true;
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const server = createGateway({
    manager: {
      workspacesPerUser: 10,
      list: async () => {
        entered();
        await gate;
        return [{ name: 'private' }];
      },
    } as unknown as RuntimeManager,
    runs: {} as RunService,
    authenticate: async () => (allowed ? PEOPLE.alice : null),
    audit: () => {},
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  try {
    const response = fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/workspaces`);
    await started;
    allowed = false;
    release();
    const result = await response;
    assert.equal(result.status, 401);
    assert.doesNotMatch(await result.text(), /private/);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  }
});

test('release failures preserve setup errors and durable quota is authoritative', async () => {
  for (const commitBeforeFailure of [false, true]) {
    const root = await mkdtemp(join(tmpdir(), 'step-release-'));
    class FaultyStore extends QuotaStore {
      override release(actor: string, day: string) {
        if (commitBeforeFailure) super.release(actor, day);
        throw new Error('synthetic release failure');
      }
    }
    const store = new FaultyStore(join(root, 'quota.sqlite'));
    const observer = new QuotaStore(join(root, 'quota.sqlite'));
    const manager = {
      get: async () => ({}),
      subscribe: async () => () => {},
      newConversation: async () => ({ sessionId: 'synthetic' }),
      ask: async () => new Promise<AskResult>(() => {}),
    } as unknown as RuntimeManager;
    const audit: AuditEntry[] = [];
    const service = new RunService(
      manager,
      (entry) => audit.push(entry),
      { ...DEFAULT_QUOTAS, runsPerUserPerDay: 1 },
      Date.now,
      store,
    );
    const original = new Error('synthetic authorization failure');
    try {
      await assert.rejects(
        service.start('alice', 'workspace', { text: 'x' }, async () => {
          throw original;
        }),
        (error) => error === original,
      );
      assert.ok(audit.some((entry) => entry.action === 'quota.release' && entry.outcome === 'failed'));
      if (commitBeforeFailure) {
        assert.equal((await service.start('alice', 'workspace', { text: 'retry' })).status, 'running');
        assert.equal(observer.reserve('alice', new Date().toISOString().slice(0, 10), 1), false);
      } else {
        await assert.rejects(service.start('alice', 'workspace', { text: 'retry' }), {
          code: 'QUOTA_DAILY_RUNS',
        });
        assert.equal(observer.reserve('alice', new Date().toISOString().slice(0, 10), 1), false);
        observer.release('alice', new Date().toISOString().slice(0, 10));
        assert.equal((await service.start('alice', 'workspace', { text: 'retry' })).status, 'running');
      }
    } finally {
      observer.close();
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  }
});

test('revocation during run preparation prevents admission and dispatch', async () => {
  let allowed = true,
    release!: () => void,
    entered!: () => void,
    asks = 0,
    conversations = 0;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const waiting = new Promise<void>((r) => {
    entered = r;
  });
  const manager = {
    workspacesPerUser: 10,
    get: async () => {
      entered();
      await gate;
    },
    subscribe: async () => () => {},
    newConversation: async () => {
      conversations++;
      return { sessionId: 'synthetic' };
    },
    ask: async () => {
      asks++;
      return { status: 'review' };
    },
  } as unknown as RuntimeManager;
  const quotaStore = new QuotaStore(':memory:');
  const quotas = { ...DEFAULT_QUOTAS, runsPerUserPerDay: 1 };
  const runs = new RunService(manager, () => {}, quotas, Date.now, quotaStore);
  const server = createGateway({
    manager,
    runs,
    authenticate: async () => (allowed ? PEOPLE.alice : null),
    audit: () => {},
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  try {
    const result = fetch(
      `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/workspaces/ws_${'a'.repeat(32)}/runs`,
      { ...post({ text: 'synthetic' }), headers: { 'content-type': 'application/json' } },
    );
    await waiting;
    allowed = false;
    release();
    assert.equal((await result).status, 401);
    assert.equal(asks, 0);
    assert.equal(conversations, 0, 'revoked preparation must not create a conversation');
    assert.equal(runs.stats().today.started, 0);
    allowed = true;
    const retry = await fetch(
      `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/workspaces/ws_${'a'.repeat(32)}/runs`,
      { ...post({ text: 'retry' }), headers: { 'content-type': 'application/json' } },
    );
    assert.equal(retry.status, 202, 'failed preparation returns its durable reservation');
  } finally {
    release();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    quotaStore.close();
  }
});

test('revocation during subscription or conversation creation blocks later preparation and dispatch', async () => {
  for (const stage of ['subscribe', 'conversation'] as const) {
    let allowed = true,
      release!: () => void,
      entered!: () => void,
      conversations = 0,
      asks = 0;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const pause = async () => {
      entered();
      await gate;
    };
    const manager = {
      get: async () => ({}),
      subscribe: async () => {
        if (stage === 'subscribe') await pause();
        return () => {};
      },
      newConversation: async () => {
        conversations++;
        if (stage === 'conversation') await pause();
        return { sessionId: 'synthetic' };
      },
      ask: async () => {
        asks++;
        return new Promise<AskResult>(() => {});
      },
    } as unknown as RuntimeManager;
    const store = new QuotaStore(':memory:');
    const runs = new RunService(
      manager,
      () => {},
      { ...DEFAULT_QUOTAS, runsPerUserPerDay: 1 },
      Date.now,
      store,
    );
    const denied = new Error('revoked');
    const authorize = async () => {
      if (!allowed) throw denied;
    };
    try {
      const pending = runs.start('alice', 'workspace', { text: 'x' }, authorize);
      await waiting;
      allowed = false;
      release();
      await assert.rejects(pending, (error) => error === denied);
      assert.equal(conversations, stage === 'subscribe' ? 0 : 1);
      assert.equal(asks, 0);
      assert.equal(runs.stats().today.started, 0);
      allowed = true;
      assert.equal((await runs.start('alice', 'workspace', { text: 'retry' }, authorize)).status, 'running');
    } finally {
      release();
      store.close();
    }
  }
});

test('failed preparation crossing UTC midnight releases its original day only', async () => {
  for (const durable of [false, true]) {
    let time = Date.parse('2026-11-04T23:59:59Z'),
      release!: () => void,
      entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const manager = {
      get: async () => ({}),
      subscribe: async () => () => {},
      newConversation: async () => ({ sessionId: 'synthetic' }),
      ask: async () => new Promise<AskResult>(() => {}),
    } as unknown as RuntimeManager;
    const store = durable ? new QuotaStore(':memory:') : undefined;
    const runs = new RunService(
      manager,
      () => {},
      { ...DEFAULT_QUOTAS, runsPerUserPerDay: 1 },
      () => time,
      store,
    );
    const denied = new Error('revoked');
    try {
      const old = runs.start('alice', 'workspace', { text: 'old' }, async () => {
        entered();
        await gate;
        throw denied;
      });
      await waiting;
      time = Date.parse('2026-11-05T00:00:01Z');
      assert.equal((await runs.start('alice', 'workspace', { text: 'new' })).status, 'running');
      release();
      await assert.rejects(old, (error) => error === denied);
      await assert.rejects(runs.start('alice', 'workspace', { text: 'extra' }), { code: 'QUOTA_DAILY_RUNS' });
    } finally {
      release();
      store?.close();
    }
  }
});

test('oversized replay produces one reset rather than an endless reconnect loop', async () => {
  let emit!: (event: RuntimeEvent) => void;
  const manager = {
    get: async () => ({}),
    subscribe: async (_actor: string, _workspace: string, cb: typeof emit) => {
      emit = cb;
      return () => {};
    },
    ask: async () => new Promise<AskResult>(() => {}),
  } as unknown as RuntimeManager;
  const runs = new RunService(manager, () => {});
  const workspace = `ws_${'a'.repeat(32)}`;
  await runs.start('alice', workspace, { text: 'synthetic', sessionId: 'synthetic' });
  for (let i = 0; i < 128; i++) emit({ type: 'delta', sessionId: 'synthetic', text: 'x' });
  const events: { id: number; type: string }[] = [];
  const stop = await runs.follow('alice', workspace, 0, (event) => events.push(event));
  stop();
  assert.deepEqual(events, [{ id: 129, type: 'reset', data: {} }]);
});

test('SSE disconnects on event burst while authorization is stalled', async () => {
  let emit!: (event: { id: number; type: string; data: unknown }) => void;
  let stopped = false,
    block = false,
    release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const server = createGateway({
    manager: { workspacesPerUser: 10 } as RuntimeManager,
    runs: {
      follow: async (_u: string, _w: string, _a: number, cb: typeof emit) => {
        emit = cb;
        return () => {
          stopped = true;
        };
      },
    } as unknown as RunService,
    authenticate: async () => {
      if (block) await gate;
      return PEOPLE.alice;
    },
    audit: () => {},
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  try {
    const response = await fetch(
      `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/workspaces/ws_${'a'.repeat(32)}/events`,
    );
    await response.body!.getReader().read();
    block = true;
    for (let i = 0; i < 3000; i++) emit({ id: i, type: 'delta', data: 'synthetic' });
    assert.equal(stopped, true);
  } finally {
    release();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test('SSE disconnects when the response applies backpressure', async () => {
  const { InvitationStore } = await import('../src/gateway/invitation-store.ts');
  const store = new InvitationStore(':memory:', ['step.example'], new Set(['root@step.example']));
  let emit!: (event: { id: number; type: string; data: unknown }) => void;
  let stopped = false;
  const original = ServerResponse.prototype.write;
  const server = createGateway({
    manager: { workspacesPerUser: 10 } as RuntimeManager,
    runs: {
      follow: async (_u: string, _w: string, _a: number, cb: typeof emit) => {
        emit = cb;
        return () => {
          stopped = true;
        };
      },
    } as unknown as RunService,
    authenticate: async () => PEOPLE.alice,
    audit: () => {},
    invitations: store,
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  try {
    const response = await fetch(
      `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/workspaces/ws_${'a'.repeat(32)}/events`,
    );
    await response.body!.getReader().read();
    ServerResponse.prototype.write = function (this: ServerResponse, ...args: Parameters<typeof original>) {
      original.apply(this, args);
      return false;
    } as typeof original;
    emit({ id: 1, type: 'delta', data: 'synthetic' });
    await until(async () => (stopped ? true : undefined), 300);
    assert.equal(stopped, true);
    store.change(
      'root@step.example',
      'alice@step.example',
      false,
      new Set(['root@step.example', 'alice@step.example']),
    );
  } finally {
    store.close();
    ServerResponse.prototype.write = original;
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test('admin revocation during runtime startup prevents conversation creation', async () => {
  const { InvitationStore } = await import('../src/gateway/invitation-store.ts');
  const dir = await mkdtemp(join(tmpdir(), 'step-conversation-revoke-'));
  const base = new Set(['root@step.example', 'alice@step.example']);
  const first = new InvitationStore(
    join(dir, 'invites.sqlite'),
    ['step.example'],
    new Set(['root@step.example']),
  );
  const second = new InvitationStore(
    join(dir, 'invites.sqlite'),
    ['step.example'],
    new Set(['root@step.example']),
  );
  const runtime = heldDriver();
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const ready = new Promise<void>((resolve) => (entered = resolve));
  const start = runtime.driver.start.bind(runtime.driver);
  runtime.driver.start = async (...args) => {
    entered();
    await gate;
    return start(...args);
  };
  const manager = new RuntimeManager({
    workspacesPerUser: 10,
    dataRoot: provisionTestQuota(dir, 10),
    driver: runtime.driver,
  });
  const audit = () => {};
  const server = createGateway({
    manager,
    runs: new RunService(manager, audit),
    audit,
    invitations: first,
    baseInvitations: () => base,
    authenticate: async (header) => {
      const who = PEOPLE[header?.replace(/^Bearer /, '') ?? ''];
      return who && first.invited(base).has(who.email) ? who : null;
    },
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = (path: string, init: RequestInit = {}) =>
    fetch(url + path, {
      ...init,
      headers: {
        authorization: 'Bearer alice',
        ...(init.body ? { 'content-type': 'application/json' } : {}),
      },
    });
  try {
    const workspace = await (await call('/api/workspaces', post({ name: 'race' }))).json();
    const request = call(`/api/workspaces/${workspace.id}/conversations`, { method: 'POST' });
    await ready;
    second.change('root@step.example', 'alice@step.example', false, base);
    release();
    assert.equal((await request).status, 401);
    second.change('root@step.example', 'alice@step.example', true, base);
    const conversations = await (await call(`/api/workspaces/${workspace.id}/conversations`)).json();
    assert.deepEqual(conversations, []);
  } finally {
    release();
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
    await manager.shutdown();
    first.close();
    second.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('admin revocation during run preparation prevents implicit conversation creation', async () => {
  const { InvitationStore } = await import('../src/gateway/invitation-store.ts');
  const dir = await mkdtemp(join(tmpdir(), 'step-conversation-revoke-'));
  const base = new Set(['root@step.example', 'alice@step.example']);
  const first = new InvitationStore(
    join(dir, 'invites.sqlite'),
    ['step.example'],
    new Set(['root@step.example']),
  );
  const second = new InvitationStore(
    join(dir, 'invites.sqlite'),
    ['step.example'],
    new Set(['root@step.example']),
  );
  const runtime = heldDriver();
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const ready = new Promise<void>((resolve) => (entered = resolve));
  const start = runtime.driver.start.bind(runtime.driver);
  runtime.driver.start = async (...args) => {
    entered();
    await gate;
    return start(...args);
  };
  const manager = new RuntimeManager({
    workspacesPerUser: 10,
    dataRoot: provisionTestQuota(dir, 10),
    driver: runtime.driver,
  });
  const audit = () => {};
  const server = createGateway({
    manager,
    runs: new RunService(manager, audit),
    audit,
    invitations: first,
    baseInvitations: () => base,
    authenticate: async (header) => {
      const who = PEOPLE[header?.replace(/^Bearer /, '') ?? ''];
      return who && first.invited(base).has(who.email) ? who : null;
    },
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = (path: string, init: RequestInit = {}) =>
    fetch(url + path, {
      ...init,
      headers: {
        authorization: 'Bearer alice',
        ...(init.body ? { 'content-type': 'application/json' } : {}),
      },
    });
  try {
    const workspace = await (await call('/api/workspaces', post({ name: 'race' }))).json();
    const request = call(`/api/workspaces/${workspace.id}/runs`, post({ text: 'synthetic' }));
    await ready;
    second.change('root@step.example', 'alice@step.example', false, base);
    release();
    assert.equal((await request).status, 401);
    second.change('root@step.example', 'alice@step.example', true, base);
    const conversations = await (await call(`/api/workspaces/${workspace.id}/conversations`)).json();
    assert.deepEqual(conversations, []);
  } finally {
    release();
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
    await manager.shutdown();
    first.close();
    second.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('cross-process revoke before cancel dispatch prevents the runtime cancel', async () => {
  const { InvitationStore } = await import('../src/gateway/invitation-store.ts');
  const dir = await mkdtemp(join(tmpdir(), 'step-cancel-revoke-'));
  const db = join(dir, 'invites.sqlite');
  const base = new Set(['root@step.example', 'alice@step.example']);
  const store = new InvitationStore(db, ['step.example'], new Set(['root@step.example']));
  const runtime = heldDriver();
  const manager = new RuntimeManager({
    workspacesPerUser: 10,
    dataRoot: provisionTestQuota(dir, 10),
    driver: runtime.driver,
  });
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const ready = new Promise<void>((resolve) => (entered = resolve));
  const cancel = manager.cancel.bind(manager);
  manager.cancel = async (...args) => {
    entered();
    await gate;
    return cancel(...args);
  };
  const audit = () => {};
  const runs = new RunService(manager, audit);
  const server = createGateway({
    manager,
    runs,
    audit,
    invitations: store,
    baseInvitations: () => base,
    authenticate: async (header) => {
      const who = PEOPLE[header?.replace(/^Bearer /, '') ?? ''];
      return who && store.invited(base).has(who.email) ? who : null;
    },
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = (path: string, init: RequestInit = {}) =>
    fetch(url + path, {
      ...init,
      headers: {
        authorization: 'Bearer alice',
        ...(init.body ? { 'content-type': 'application/json' } : {}),
      },
    });
  try {
    const workspace = await (await call('/api/workspaces', post({ name: 'race' }))).json();
    const start = await call(`/api/workspaces/${workspace.id}/runs`, post({ text: 'synthetic' }));
    assert.equal(start.status, 202);
    const run = await start.json();
    const request = call(`/api/workspaces/${workspace.id}/runs/${run.id}/cancel`, { method: 'POST' });
    await ready;
    const moduleUrl = new URL('../src/gateway/invitation-store.ts', import.meta.url).href;
    const script = `import { InvitationStore } from ${JSON.stringify(moduleUrl)};
      const store = new InvitationStore(process.argv[1], ['step.example'], new Set(['root@step.example']));
      store.change('root@step.example', 'alice@step.example', false, new Set(['root@step.example', 'alice@step.example']));
      store.close();`;
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, db], {
      stdio: 'inherit',
    });
    const [code] = await once(child, 'exit');
    assert.equal(code, 0);
    release();
    assert.equal((await request).status, 401);
    assert.deepEqual(runtime.cancels, [], 'cancel must not reach the runtime after revocation commits');
    assert.equal(runs.get('alice', workspace.id, run.id).status, 'running');
  } finally {
    release();
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
    await manager.shutdown();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('admin revoke before runtime dispatch prevents the queued ask across invitation store connections', async () => {
  const { InvitationStore } = await import('../src/gateway/invitation-store.ts');
  const dir = await mkdtemp(join(tmpdir(), 'step-dispatch-revoke-'));
  const base = new Set(['root@step.example', 'alice@step.example']);
  const first = new InvitationStore(
    join(dir, 'invites.sqlite'),
    ['step.example'],
    new Set(['root@step.example']),
  );
  const second = new InvitationStore(
    join(dir, 'invites.sqlite'),
    ['step.example'],
    new Set(['root@step.example']),
  );
  const manager = new RuntimeManager({
    workspacesPerUser: 10,
    dataRoot: provisionTestQuota(dir, 10),
    driver: heldDriver().driver,
  });
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const ready = new Promise<void>((resolve) => (entered = resolve));
  const ask = manager.ask.bind(manager);
  manager.ask = async (...args) => {
    entered();
    await gate;
    return ask(...args);
  };
  const audit = () => {};
  const runs = new RunService(manager, audit);
  const server = createGateway({
    manager,
    runs,
    audit,
    authenticate: async (header) => {
      const who = PEOPLE[header?.replace(/^Bearer /, '') ?? ''];
      return who && first.invited(base).has(who.email) ? who : null;
    },
    invitations: first,
    baseInvitations: () => base,
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = (person: string, path: string, init: RequestInit = {}) =>
    fetch(url + path, {
      ...init,
      headers: {
        authorization: `Bearer ${person}`,
        ...(init.body ? { 'content-type': 'application/json' } : {}),
      },
    });
  try {
    const workspace = await (await call('alice', '/api/workspaces', post({ name: 'race' }))).json();
    const start = await call(
      'alice',
      `/api/workspaces/${workspace.id}/runs`,
      post({ text: 'must not dispatch' }),
    );
    assert.equal(start.status, 202);
    const run = await start.json();
    await ready;
    second.change('root@step.example', 'alice@step.example', false, base);
    release();
    const failed = await until(async () => {
      const current = runs.get('alice', workspace.id, run.id);
      return current.status === 'failed' ? current : undefined;
    });
    assert.equal(failed.code, 'UNAUTHENTICATED');
    assert.deepEqual(await manager.messages('alice', workspace.id, run.sessionId), []);
  } finally {
    release();
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
    await manager.shutdown();
    first.close();
    second.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('a revoke in another process waits until the synchronous runtime send completes', async () => {
  const { InvitationStore } = await import('../src/gateway/invitation-store.ts');
  const dir = await mkdtemp(join(tmpdir(), 'step-dispatch-lock-'));
  const db = join(dir, 'invites.sqlite');
  const store = new InvitationStore(db, ['step.example'], new Set(['root@step.example']));
  const marker = (name: string) => join(dir, name);
  const moduleUrl = new URL('../src/gateway/invitation-store.ts', import.meta.url).href;
  const script = `
    import { InvitationStore } from ${JSON.stringify(moduleUrl)};
    import { existsSync, writeFileSync } from 'node:fs';
    const [db, ready, go, attempted, done] = process.argv.slice(1);
    const store = new InvitationStore(db, ['step.example'], new Set(['root@step.example']));
    writeFileSync(ready, '');
    while (!existsSync(go)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    writeFileSync(attempted, '');
    store.change('root@step.example', 'alice@step.example', false, new Set(['root@step.example', 'alice@step.example']));
    writeFileSync(done, ''); store.close();
  `;
  const child = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      '--input-type=module',
      '-e',
      script,
      db,
      marker('ready'),
      marker('go'),
      marker('attempted'),
      marker('done'),
    ],
    { stdio: 'ignore' },
  );
  const exit = once(child, 'exit');
  try {
    await until(async () => (existsSync(marker('ready')) ? true : undefined));
    store.dispatch('alice@step.example', () => {
      writeFileSync(marker('go'), '');
      const deadline = Date.now() + 3000;
      while (!existsSync(marker('attempted')) && Date.now() < deadline)
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      assert.ok(existsSync(marker('attempted')));
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
      assert.equal(existsSync(marker('done')), false, 'revoke cannot commit before the send returns');
    });
    const [code] = await exit;
    assert.equal(code, 0);
    assert.ok(existsSync(marker('done')));
    assert.throws(
      () => store.dispatch('alice@step.example', () => assert.fail('sent after revoke')),
      /UNAUTHENTICATED/,
    );
  } finally {
    child.kill();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('private HTTP delivery rejects a cross-process revoke after the last authentication read', async () => {
  const { InvitationStore } = await import('../src/gateway/invitation-store.ts');
  const dir = await mkdtemp(join(tmpdir(), 'step-http-fence-'));
  const db = join(dir, 'invites.sqlite');
  const store = new InvitationStore(db, ['step.example'], new Set(['root@step.example']));
  const moduleUrl = new URL('../src/gateway/invitation-store.ts', import.meta.url).href;
  let count = 0;
  const server = createGateway({
    manager: { workspacesPerUser: 10 } as RuntimeManager,
    runs: {} as RunService,
    invitations: store,
    audit: () => {},
    authenticate: async () => {
      if (++count === 2) {
        const script = `import { InvitationStore } from ${JSON.stringify(moduleUrl)}; const s = new InvitationStore(process.argv[1], ['step.example'], new Set(['root@step.example'])); s.change('root@step.example', 'alice@step.example', false, new Set(['root@step.example','alice@step.example'])); s.close();`;
        const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, db], {
          stdio: 'ignore',
        });
        const [code] = await once(child, 'exit');
        assert.equal(code, 0);
      }
      return PEOPLE.alice; // Deliberately stale result, as if revoke followed the DB read.
    },
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  try {
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/me`);
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { code: 'UNAUTHENTICATED' });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('SSE suppresses an event when another process revokes after authentication read', async () => {
  const { InvitationStore } = await import('../src/gateway/invitation-store.ts');
  const dir = await mkdtemp(join(tmpdir(), 'step-sse-fence-'));
  const db = join(dir, 'invites.sqlite');
  const store = new InvitationStore(db, ['step.example'], new Set(['root@step.example']));
  const moduleUrl = new URL('../src/gateway/invitation-store.ts', import.meta.url).href;
  let count = 0;
  let emit!: (event: { id: number; type: string; data: unknown }) => void;
  let stopped = false;
  const server = createGateway({
    manager: { workspacesPerUser: 10 } as RuntimeManager,
    runs: {
      follow: async (_u: string, _w: string, _a: number, cb: typeof emit) => {
        emit = cb;
        return () => {
          stopped = true;
        };
      },
    } as unknown as RunService,
    invitations: store,
    audit: () => {},
    authenticate: async () => {
      if (++count === 3) {
        const script = `import { InvitationStore } from ${JSON.stringify(moduleUrl)}; const s = new InvitationStore(process.argv[1], ['step.example'], new Set(['root@step.example'])); s.change('root@step.example', 'alice@step.example', false, new Set(['root@step.example','alice@step.example'])); s.close();`;
        const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, db], {
          stdio: 'ignore',
        });
        const [code] = await once(child, 'exit');
        assert.equal(code, 0);
      }
      return PEOPLE.alice;
    },
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  try {
    const response = await fetch(
      `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/workspaces/ws_${'a'.repeat(32)}/events`,
    );
    const reader = response.body!.getReader();
    await reader.read();
    emit({ id: 1, type: 'delta', data: 'PRIVATE' });
    const next = await reader.read();
    assert.equal(next.done, true);
    assert.equal(stopped, true);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('cross-process revocation waits for synchronous HTTP enqueue and then completes', async () => {
  const { InvitationStore } = await import('../src/gateway/invitation-store.ts');
  const dir = await mkdtemp(join(tmpdir(), 'step-http-order-'));
  const db = join(dir, 'invites.sqlite');
  const store = new InvitationStore(db, ['step.example'], new Set(['root@step.example']));
  const marker = (name: string) => join(dir, name);
  const moduleUrl = new URL('../src/gateway/invitation-store.ts', import.meta.url).href;
  const script = `import { InvitationStore } from ${JSON.stringify(moduleUrl)};
    import { existsSync, writeFileSync } from 'node:fs';
    const [db, ready, go, attempted, done] = process.argv.slice(1);
    const s = new InvitationStore(db, ['step.example'], new Set(['root@step.example']));
    writeFileSync(ready, '');
    while (!existsSync(go)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    writeFileSync(attempted, '');
    s.change('root@step.example', 'alice@step.example', false, new Set(['root@step.example','alice@step.example']));
    writeFileSync(done, ''); s.close();`;
  const child = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      '--input-type=module',
      '-e',
      script,
      db,
      marker('ready'),
      marker('go'),
      marker('attempted'),
      marker('done'),
    ],
    { stdio: 'ignore' },
  );
  const exit = once(child, 'exit');
  const original = ServerResponse.prototype.end;
  let observed = false;
  const server = createGateway({
    manager: { workspacesPerUser: 10 } as RuntimeManager,
    runs: {} as RunService,
    invitations: store,
    authenticate: async () => PEOPLE.alice,
    audit: () => {},
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  try {
    await until(async () => (existsSync(marker('ready')) ? true : undefined));
    ServerResponse.prototype.end = function (this: ServerResponse, ...args: Parameters<typeof original>) {
      if (!observed) {
        observed = true;
        writeFileSync(marker('go'), '');
        const deadline = Date.now() + 3000;
        while (!existsSync(marker('attempted')) && Date.now() < deadline)
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
        assert.ok(existsSync(marker('attempted')));
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
        assert.equal(existsSync(marker('done')), false);
      }
      return original.apply(this, args);
    } as typeof original;
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/me`);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).email, 'alice@step.example');
    assert.equal((await exit)[0], 0);
    assert.ok(observed && existsSync(marker('done')));
    assert.throws(() => store.dispatch('alice@step.example', () => assert.fail()), /UNAUTHENTICATED/);
  } finally {
    ServerResponse.prototype.end = original;
    child.kill();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('HTTP delivery fails closed when the invitation fence is unavailable', async () => {
  const { InvitationStore } = await import('../src/gateway/invitation-store.ts');
  const store = new InvitationStore(':memory:', ['step.example'], new Set(['root@step.example']));
  store.close();
  const server = createGateway({
    manager: { workspacesPerUser: 10 } as RuntimeManager,
    runs: {} as RunService,
    invitations: store,
    authenticate: async () => PEOPLE.alice,
    audit: () => {},
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  try {
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/me`);
    assert.equal(response.status, 502);
    assert.doesNotMatch(await response.text(), /alice@step.example/);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});
