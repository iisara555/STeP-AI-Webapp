import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createGateway } from '../src/gateway/http.ts';
import { RunService } from '../src/gateway/runs.ts';
import { RuntimeManager } from '../src/workspace/manager.ts';
import { heldDriver } from './support/held-driver.ts';

test('stale cancellation cannot cancel a later run in the same conversation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'step-stale-cancel-'));
  const runtime = heldDriver();
  const manager = new RuntimeManager({ workspacesPerUser: 10, dataRoot: dir, driver: runtime.driver });
  const audit = () => {};
  const runs = new RunService(manager, audit);
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
  const server = createGateway({
    manager,
    runs,
    audit,
    authenticate: async () => ({ userId: 'alice', email: 'alice@example.test', admin: false }),
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = (path: string, body?: unknown) =>
    fetch(url + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        authorization: 'Bearer alice',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const until = async (condition: () => Promise<boolean>) => {
    const deadline = Date.now() + 3000;
    while (!(await condition())) {
      if (Date.now() > deadline) throw new Error('timed out');
      await new Promise((done) => setTimeout(done, 10));
    }
  };
  try {
    const workspace = await (await call('/api/workspaces', { name: 'race' })).json();
    const path = `/api/workspaces/${workspace.id}`;
    const first = await (await call(`${path}/runs`, { text: 'first' })).json();
    const stale = call(`${path}/runs/${first.id}/cancel`, {});
    await ready;
    runtime.answer(first.sessionId, 'first finished');
    await until(async () => runs.get('alice', workspace.id, first.id).status === 'done');
    const response = await call(`${path}/runs`, { text: 'second', sessionId: first.sessionId });
    assert.equal(response.status, 202);
    const second = await response.json();
    await until(async () =>
      (await manager.messages('alice', workspace.id, first.sessionId)).some((m) => m.text === 'second'),
    );
    release();
    assert.equal((await stale).status, 409);
    assert.deepEqual(runtime.cancels, [], 'stale request must not reach the later run');
    assert.equal(runs.get('alice', workspace.id, second.id).status, 'running');
  } finally {
    release();
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
    await manager.shutdown();
    await rm(dir, { recursive: true, force: true });
  }
});

test('stale cancel cannot overtake a delayed next dispatch; another session progresses', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'step-stale-order-'));
  const runtime = heldDriver();
  const manager = new RuntimeManager({ workspacesPerUser: 10, dataRoot: dir, driver: runtime.driver });
  const runs = new RunService(manager, () => {});
  let releaseCancel!: () => void;
  let cancelEntered!: () => void;
  let releaseAsk!: () => void;
  let askEntered!: () => void;
  const cancelGate = new Promise<void>((resolve) => (releaseCancel = resolve));
  const cancelReady = new Promise<void>((resolve) => (cancelEntered = resolve));
  const askGate = new Promise<void>((resolve) => (releaseAsk = resolve));
  const askReady = new Promise<void>((resolve) => (askEntered = resolve));
  const until = async (condition: () => boolean | Promise<boolean>) => {
    const deadline = Date.now() + 3000;
    while (!(await condition())) {
      if (Date.now() > deadline) throw new Error('timed out');
      await new Promise((done) => setTimeout(done, 10));
    }
  };
  try {
    const workspace = await manager.create('alice', { name: 'order' });
    const first = await runs.start('alice', workspace.id, { text: 'first' });
    const stale = runs.cancel('alice', workspace.id, first.id, async (send) => {
      cancelEntered();
      await cancelGate;
      return send();
    });
    const staleResult = stale.then(
      () => 'sent',
      (error) => error.code,
    );
    await cancelReady;
    runtime.answer(first.sessionId, 'done');
    await until(() => runs.get('alice', workspace.id, first.id).status === 'done');
    const second = await runs.start(
      'alice',
      workspace.id,
      { text: 'second', sessionId: first.sessionId },
      undefined,
      async (send) => {
        askEntered();
        await askGate;
        return send();
      },
    );
    await askReady;
    const other = await runs.start('alice', workspace.id, { text: 'independent' });
    await runs.cancel('alice', workspace.id, other.id);
    await until(() => runs.get('alice', workspace.id, other.id).status === 'cancelled');
    releaseCancel();
    assert.equal(await staleResult, 'RUN_NOT_ACTIVE');
    releaseAsk();
    await until(async () =>
      (await manager.messages('alice', workspace.id, second.sessionId)).some((m) => m.text === 'second'),
    );
    assert.deepEqual(runtime.cancels, [other.sessionId]);
    assert.equal(runs.get('alice', workspace.id, second.id).status, 'running');
    runtime.answer(second.sessionId, 'done');
    await until(() => runs.get('alice', workspace.id, second.id).status === 'done');
  } finally {
    releaseCancel();
    releaseAsk();
    await manager.shutdown();
    await rm(dir, { recursive: true, force: true });
  }
});
