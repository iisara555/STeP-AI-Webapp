// The web app's Cloud Workspace host against a real Gateway (ADR 0001 phase 3b): the screens' own calls —
// snapshot, session.create, run.start, run.read, session.read, run.cancel — with a held synthetic runtime.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChatMessage, Conversation, Run, Snapshot } from '../packages/harness-core/src/contracts.ts';
import type { Authenticator } from '../server/src/gateway/auth.ts';
import { createGateway } from '../server/src/gateway/http.ts';
import { RunService } from '../server/src/gateway/runs.ts';
import { RuntimeManager } from '../server/src/workspace/manager.ts';
import { heldDriver } from '../server/test/support/held-driver.ts';
import { CLOUD_TENANT, credentialClaims, gatewayHost } from '../web/src/gateway.ts';

async function withGateway(
  fn: (g: {
    baseUrl: string;
    runtime: ReturnType<typeof heldDriver>;
    host: (who?: string, onUnauthorized?: () => void) => ReturnType<typeof gatewayHost>;
  }) => Promise<void>,
) {
  const dataRoot = await mkdtemp(join(tmpdir(), 'step-web-gateway-'));
  const runtime = heldDriver();
  const manager = new RuntimeManager({ dataRoot, driver: runtime.driver });
  const authenticate: Authenticator = async (header) =>
    header === 'Bearer alice' ? { userId: 'alice', email: 'alice@step.example', admin: false } : null;
  const audit = () => {};
  const server = createGateway({ manager, runs: new RunService(manager, audit), authenticate, audit });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await fn({
      baseUrl,
      runtime,
      host: (who = 'alice', onUnauthorized) =>
        gatewayHost({
          baseUrl,
          clientId: 'synthetic',
          credential: () => who,
          onUnauthorized,
          reconnectMs: 20,
        }),
    });
  } finally {
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
    await manager.shutdown();
    await rm(dataRoot, { recursive: true, force: true });
  }
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

test('the existing screens work through the Gateway: tasks, streaming, answers and reopening after a reload', async () => {
  await withGateway(async ({ host: make, runtime }) => {
    const host = make();
    const empty = await host.call<Snapshot>('snapshot');
    assert.equal(empty.user.id, 'alice');
    assert.deepEqual(
      empty.tenants.map((t) => t.id),
      [CLOUD_TENANT],
    );
    assert.deepEqual([empty.workspaces, empty.sessions, empty.skills], [[], [], []]);

    // A task from the home screen goes to the first Workspace, made on demand.
    const task = await host.call<Conversation>('session.create', {
      tenant: CLOUD_TENANT,
      workspace: null,
      visibility: 'private',
      title: 'ติดต่อ HR',
    });
    assert.match(task.id, /^ws_[0-9a-f]{32}\.c\d+$/);
    assert.equal(task.workspace_id, null);
    const project = await host.call<{ id: string }>('workspace.create', {
      tenant: CLOUD_TENANT,
      name: 'โครงการ A',
    });

    const plan = await host.call<{ providerConsent: string; documents: unknown[] }>('context.plan', {
      message: 'ติดต่อฝ่ายบุคคลช่องทางไหน',
      documentIds: [],
      useMemory: true,
    });
    assert.deepEqual(plan.documents, []);
    const started = await host.call<Run>('run.start', {
      tenant: CLOUD_TENANT,
      session: task.id,
      kind: 'chat',
      message: 'ติดต่อฝ่ายบุคคลช่องทางไหน',
      providerConsent: plan.providerConsent,
    });
    assert.equal(started.status, 'running');
    assert.equal(started.session_id, task.id);
    assert.equal(started.actor_id, 'alice', 'the chat lets only the run’s owner stop it');

    // The answer streams into run.read's partial text, as the chat already shows it.
    const sessionId = task.id.split('.')[1];
    runtime.say(sessionId, 'ติดต่อ');
    await until(async () =>
      (await host.call<Run>('run.read', { id: started.id })).partial === 'ติดต่อ' ? true : undefined,
    );
    runtime.answer(sessionId, 'ติดต่อผ่านระบบ HR');
    const done = await until(async () => {
      const run = await host.call<Run>('run.read', { id: started.id });
      return run.status === 'running' ? undefined : run;
    });
    assert.equal(done.status, 'completed');
    assert.deepEqual(done.result, {
      text: 'ติดต่อผ่านระบบ HR',
      sources: [
        { id: 'hr-service-channels', title: 'hr-service-channels', location: '', kind: 'organization' },
      ],
    });

    const read = await host.call<{ session: Conversation; messages: ChatMessage[]; runs: Run[] }>(
      'session.read',
      {
        id: task.id,
      },
    );
    assert.deepEqual(
      read.messages.map((m) => [m.role, m.body]),
      [
        ['user', 'ติดต่อฝ่ายบุคคลช่องทางไหน'],
        ['assistant', 'ติดต่อผ่านระบบ HR'],
      ],
    );
    assert.deepEqual(
      read.runs.map((r) => r.status),
      ['completed'],
    );

    const after = await host.call<Snapshot>('snapshot');
    assert.deepEqual(
      after.workspaces.map((w) => [w.id, w.name]),
      [[project.id, 'โครงการ A']],
      'the home Workspace is not listed in the switcher',
    );
    assert.deepEqual(
      after.sessions.map((s) => [s.id, s.workspace_id, s.visibility]),
      [[task.id, null, 'private']],
    );

    // A second question, then the tab reloads while the AI is still working.
    const second = await host.call<Run>('run.start', {
      session: task.id,
      message: 'ลาพักผ่อนได้กี่วัน',
      providerConsent: 'x',
    });
    const reloaded = make();
    const reopened = await reloaded.call<{ runs: Run[] }>('session.read', { id: task.id });
    const running = reopened.runs.find((r) => r.status === 'running');
    assert.equal(running?.id, second.id, 'the reopened task finds the run still working');
    runtime.answer(sessionId, '10 วันทำการ');
    const finished = await until(async () => {
      const run = await reloaded.call<Run>('run.read', { id: second.id });
      return run.status === 'running' ? undefined : run;
    });
    assert.equal((finished.result as { text: string }).text, '10 วันทำการ');
  });
});

test('a run can be cancelled from the chat, and missing features say so instead of failing silently', async () => {
  await withGateway(async ({ host: make }) => {
    const host = make();
    const task = await host.call<Conversation>('session.create', { workspace: null, title: 'งานยาว' });
    const run = await host.call<Run>('run.start', {
      session: task.id,
      message: 'ร่าง TOR',
      providerConsent: 'x',
    });
    await host.call('run.cancel', { id: run.id });
    const ended = await until(async () => {
      const current = await host.call<Run>('run.read', { id: run.id });
      return current.status === 'running' ? undefined : current;
    });
    assert.deepEqual([ended.status, ended.error_code], ['cancelled', 'CANCELLED']);

    for (const action of [
      'memory.save',
      'document.create',
      'receipt.history',
      'google.state',
      'session.draft',
    ])
      await assert.rejects(() => host.call(action, {}), { code: 'CLOUD_NOT_AVAILABLE' }, action);
    await assert.rejects(() => host.call('session.read', { id: '../../etc' }), { code: 'ACCESS_DENIED' });
    await assert.rejects(() => host.call('run.read', { id: 'run_unknown' }), { code: 'ACCESS_DENIED' });
  });
});

test('a credential the Gateway refuses signs the tab out', async () => {
  await withGateway(async ({ host: make }) => {
    let signedOut = 0;
    const host = make('mallory', () => signedOut++);
    await assert.rejects(() => host.call('snapshot'), { code: 'UNAUTHENTICATED' });
    assert.equal(signedOut, 1);
    const nobody = gatewayHost({ baseUrl: 'http://127.0.0.1:9', clientId: 'x', credential: () => null });
    await assert.rejects(() => nobody.call('snapshot'), { code: 'UNAUTHENTICATED' });
  });
});

test('the ID token is only read for who and until when; malformed ones are rejected', () => {
  const body = Buffer.from(
    JSON.stringify({ sub: '123', email: 'a@step.example', exp: 2_000_000_000 }),
  ).toString('base64url');
  assert.deepEqual(credentialClaims(`h.${body}.s`), {
    sub: '123',
    email: 'a@step.example',
    exp: 2_000_000_000,
  });
  for (const bad of ['', 'only-one-part', 'h.%%%.s', `h.${Buffer.from('{"sub":1}').toString('base64url')}.s`])
    assert.equal(credentialClaims(bad), null, bad);
});
