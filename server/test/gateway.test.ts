import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
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
  const runtime = heldDriver();
  const manager = new RuntimeManager({ dataRoot, driver: runtime.driver });
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
    manager = new RuntimeManager({ dataRoot, driver: heldDriver().driver });
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
    server!.closeAllConnections();
    await new Promise<void>((done) => server!.close(() => done()));
    await manager!.shutdown();
    store!.close();
  }
  try {
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
  const manager = new RuntimeManager({ dataRoot: dir, driver: runtime.driver });
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
    manager: {} as RuntimeManager,
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

test('revocation during run preparation prevents admission and dispatch', async () => {
  let allowed = true,
    release!: () => void,
    entered!: () => void,
    asks = 0;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const waiting = new Promise<void>((r) => {
    entered = r;
  });
  const manager = {
    get: async () => {
      entered();
      await gate;
    },
    subscribe: async () => () => {},
    newConversation: async () => ({ sessionId: 'synthetic' }),
    ask: async () => {
      asks++;
      return { status: 'review' };
    },
  } as unknown as RuntimeManager;
  const runs = new RunService(manager, () => {});
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
    assert.equal(runs.stats().today.started, 0);
  } finally {
    release();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
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
    manager: {} as RuntimeManager,
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
  let emit!: (event: { id: number; type: string; data: unknown }) => void;
  let stopped = false;
  const original = ServerResponse.prototype.write;
  const server = createGateway({
    manager: {} as RuntimeManager,
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
  } finally {
    ServerResponse.prototype.write = original;
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});
