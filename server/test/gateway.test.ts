import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AuditEntry } from '../src/gateway/audit.ts';
import type { Authenticator, Identity } from '../src/gateway/auth.ts';
import { createGateway } from '../src/gateway/http.ts';
import { QuotaStore } from '../src/gateway/quota-store.ts';
import { skillLibrary, type SkillLibrary } from '../src/gateway/skills.ts';
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
  quotaStore?: QuotaStore,
  skills?: SkillLibrary,
) {
  const dataRoot = await mkdtemp(join(tmpdir(), 'step-gateway-'));
  const runtime = heldDriver();
  const manager = new RuntimeManager({ dataRoot, driver: runtime.driver });
  const audit: AuditEntry[] = [];
  const record = (entry: AuditEntry) => void audit.push(entry);
  const server = createGateway({
    manager,
    runs: new RunService(manager, record, quotas, Date.now, quotaStore),
    authenticate,
    audit: record,
    origin: ORIGIN,
    quotas,
    heartbeatMs: 60_000,
    skills,
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
    await rm(dataRoot, { recursive: true, force: true });
  }
}

const post = (body: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(body) });

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

test('runs per day stay counted after the Gateway restarts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'step-quota-'));
  const path = join(dir, 'gateway-quotas.sqlite');
  const quotas = { workspacesPerUser: 1, activeRunsPerUser: 2, runsPerUserPerDay: 2 };
  const startOne = async (call: (who: string, path: string, init?: RequestInit) => Promise<Response>) => {
    const listed = await (await call('alice', '/api/workspaces')).json();
    const workspace =
      listed[0] ?? (await (await call('alice', '/api/workspaces', post({ name: 'หนึ่ง' }))).json());
    return call('alice', `/api/workspaces/${workspace.id}/runs`, post({ text: 'ถาม' }));
  };
  try {
    let store = new QuotaStore(path);
    await withGateway(
      async ({ call }) => {
        assert.equal((await startOne(call)).status, 202);
        assert.equal((await startOne(call)).status, 202);
      },
      quotas,
      store,
    );
    store.close();

    // A fresh Gateway on the same file: Alice has used today's two runs, Bob has not.
    store = new QuotaStore(path);
    await withGateway(
      async ({ call }) => {
        const again = await startOne(call);
        assert.deepEqual([again.status, await again.json()], [429, { code: 'QUOTA_DAILY_RUNS' }]);
        const bob = await (await call('bob', '/api/workspaces', post({ name: 'ของบ๊อบ' }))).json();
        assert.equal(
          (await call('bob', `/api/workspaces/${bob.id}/runs`, post({ text: 'ถาม' }))).status,
          202,
        );
      },
      quotas,
      store,
    );
    store.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the quota store counts each user and day on its own and refuses at the limit', () => {
  const store = new QuotaStore(':memory:');
  assert.equal(store.reserve('a', '2026-11-23', 2), true);
  assert.equal(store.reserve('a', '2026-11-23', 2), true);
  assert.equal(store.reserve('a', '2026-11-23', 2), false);
  assert.equal(store.used('a', '2026-11-23'), 2);
  assert.equal(store.reserve('b', '2026-11-23', 2), true);
  assert.equal(store.reserve('a', '2026-11-24', 2), true);
  // Rows older than the kept window are removed when a later day is counted.
  assert.equal(store.reserve('a', '2027-01-15', 2), true);
  assert.equal(store.used('a', '2026-11-23'), 0);
  store.close();
});

test('the Skills page lists the pinned harness Skills staff may use, and a run can name one', async () => {
  const library = skillLibrary();
  const listed = await library.list();
  const keys = listed.map((skill) => skill.skill_key);
  assert.ok(keys.includes('hr-policy-lookup'));
  assert.ok(listed.length >= 40, 'the pilot Skills of the pinned harness');
  for (const skill of listed) {
    assert.equal(skill.instructions, '', 'the list leaves instructions out');
    assert.ok(!['ai-admin', 'developer'].includes(String(skill.metadata.owner)), skill.skill_key);
    assert.notEqual(skill.metadata.stage, 'draft', skill.skill_key);
    assert.ok(!('paths' in skill.metadata), 'no harness paths reach the browser');
  }
  // A draft Skill of this pin (needs Desktop's browser anyway): neither listed nor readable.
  assert.ok(!keys.includes('browser-form-assistant'));
  assert.equal(await library.read('browser-form-assistant'), undefined);

  await withGateway(
    async ({ call }) => {
      const list = await (await call('alice', '/api/skills')).json();
      assert.equal(list.length, listed.length);
      const one = await (await call('alice', '/api/skills/hr-policy-lookup')).json();
      assert.match(one.instructions, /^---/);
      assert.equal((await call('alice', '/api/skills/not-a-skill')).status, 404);
      assert.equal((await call('alice', '/api/skills/..%2Fsecret')).status, 404);
    },
    DEFAULT_QUOTAS,
    undefined,
    library,
  );

  await withGateway(
    async ({ call, runtime }) => {
      const workspace = await (await call('alice', '/api/workspaces', post({ name: 'งาน' }))).json();
      const runs = `/api/workspaces/${workspace.id}/runs`;
      for (const skill of ['not-a-skill', 'browser-form-assistant', 'step-router']) {
        const refused = await call('alice', runs, post({ text: 'ช่วยหน่อย', skill }));
        assert.deepEqual([refused.status, await refused.json()], [404, { code: 'SKILL_NOT_FOUND' }], skill);
      }
      assert.equal(
        (await call('alice', runs, post({ text: 'ลาได้กี่วัน', skill: 'hr-policy-lookup' }))).status,
        202,
      );
      await until(async () => (runtime.asks.length ? true : undefined));
      assert.equal(runtime.asks[0].skill, 'hr-policy-lookup');
      assert.equal((await call('alice', runs, post({ text: 'อีกเรื่อง' }))).status, 202);
      await until(async () => (runtime.asks.length === 2 ? true : undefined));
      assert.equal(runtime.asks[1].skill, undefined);
    },
    DEFAULT_QUOTAS,
    undefined,
    library,
  );
});

test('without a Skill library the Gateway lists none and refuses a named Skill', async () => {
  await withGateway(async ({ call }) => {
    assert.deepEqual(await (await call('alice', '/api/skills')).json(), []);
    const workspace = await (await call('alice', '/api/workspaces', post({ name: 'งาน' }))).json();
    const refused = await call(
      'alice',
      `/api/workspaces/${workspace.id}/runs`,
      post({ text: 'x', skill: 'hr-policy-lookup' }),
    );
    assert.equal(refused.status, 404);
  });
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
