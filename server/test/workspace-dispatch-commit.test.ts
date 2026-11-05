import { provisionTestQuota } from './support/quota.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { InvitationStore } from '../src/gateway/invitation-store.ts';
import { RuntimeManager } from '../src/workspace/manager.ts';
import { heldDriver } from './support/held-driver.ts';

for (const method of ['messages', 'newConversation', 'ask', 'cancel'] as const) {
  for (const commitFails of [true, false]) {
    test(`${method}: delayed runtime rejection with COMMIT failure=${commitFails}`, async () => {
      const dir = await mkdtemp(join(tmpdir(), 'step-dispatch-commit-'));
      const store = new InvitationStore(join(dir, 'invites.sqlite'), ['step.example'], new Set());
      const db = (store as unknown as { db: DatabaseSync }).db;
      db.exec(`PRAGMA foreign_keys = ON;
        CREATE TABLE parent (id INTEGER PRIMARY KEY);
        CREATE TABLE child (parent_id INTEGER REFERENCES parent(id) DEFERRABLE INITIALLY DEFERRED);`);
      const runtime = heldDriver();
      const start = runtime.driver.start;
      const runtimeError = new Error('synthetic delayed runtime rejection');
      let rejectRuntime!: (error: Error) => void;
      let reached!: () => void;
      const sent = new Promise<void>((resolve) => {
        reached = resolve;
      });
      let enqueues = 0;
      let commitError: unknown;
      runtime.driver.start = async (spec) => {
        const handle = await start(spec);
        const call = handle.call;
        handle.call = ((name: any, params: any) => {
          if (name !== method) return call(name, params);
          enqueues++;
          if (commitFails) db.exec('INSERT INTO child VALUES (999)');
          return new Promise((_, reject) => {
            rejectRuntime = reject;
            reached();
          });
        }) as typeof call;
        return handle;
      };
      const manager = new RuntimeManager({
        dataRoot: provisionTestQuota(dir, 10),
        workspacesPerUser: 10,
        driver: runtime.driver,
      });
      const dispatch = <T>(send: () => T): T => {
        try {
          return store.dispatch('alice@step.example', send);
        } catch (error) {
          commitError = error;
          throw error;
        }
      };
      try {
        const workspace = await manager.create('alice', { name: 'dispatch commit' });
        await manager.start('alice', workspace.id);
        const pending =
          method === 'messages'
            ? manager.messages('alice', workspace.id, 'synthetic', {
                admit: dispatch,
                authorize: async () => {},
              })
            : method === 'newConversation'
              ? manager.newConversation('alice', workspace.id, dispatch)
              : method === 'ask'
                ? manager.ask('alice', workspace.id, { text: 'synthetic' }, undefined, dispatch)
                : manager.cancel('alice', workspace.id, 'synthetic', dispatch);
        const outcome = pending.then(
          () => assert.fail('expected rejection'),
          (error: unknown) => error,
        );
        await sent;
        if (commitFails) {
          assert.equal(await outcome, commitError, 'preserve the original COMMIT error');
          assert.match(String(commitError), /FOREIGN KEY constraint failed/);
          assert.equal(manager.stats().busy, 1, 'enqueued work remains tracked after admission fails');
        }
        // Reject only after the failed admission has unwound; node:test detects unhandled rejections.
        rejectRuntime(runtimeError);
        await new Promise((resolve) => setImmediate(resolve));
        await new Promise((resolve) => setImmediate(resolve));
        if (!commitFails) assert.equal(await outcome, runtimeError, 'preserve the runtime error');
        assert.equal(enqueues, 1);
        assert.equal(db.prepare('SELECT count(*) AS n FROM child').get()?.n, 0);
        assert.equal(manager.stats().running, 1);
        assert.equal(manager.stats().busy, 0);
        store.dispatch('alice@step.example', () => {});
      } finally {
        await manager.shutdown();
        store.close();
        await rm(dir, { recursive: true, force: true });
      }
    });
  }
}

test('failed ask COMMIT retains busy and same-session run until runtime settlement', async () => {
  const { RunService } = await import('../src/gateway/runs.ts');
  const dir = await mkdtemp(join(tmpdir(), 'step-successor-'));
  const store = new InvitationStore(join(dir, 'invites.sqlite'), ['step.example'], new Set());
  const db = (store as unknown as { db: DatabaseSync }).db;
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE parent (id INTEGER PRIMARY KEY);
    CREATE TABLE child (id INTEGER REFERENCES parent(id) DEFERRABLE INITIALLY DEFERRED);`);
  const runtime = heldDriver();
  const manager = new RuntimeManager({
    dataRoot: provisionTestQuota(dir, 10),
    workspacesPerUser: 10,
    driver: runtime.driver,
    idleMs: 1,
  });
  const runs = new RunService(manager, () => {});
  let sent!: () => void;
  const enqueued = new Promise<void>((resolve) => {
    sent = resolve;
  });
  try {
    const workspace = await manager.create('alice', { name: 'successor' });
    const { sessionId } = await manager.newConversation('alice', workspace.id);
    const run = await runs.start('alice', workspace.id, { text: 'first', sessionId }, undefined, (send) =>
      store.dispatch('alice@step.example', () => {
        const pending = send();
        db.exec('INSERT INTO child VALUES (999)');
        sent();
        return pending;
      }),
    );
    await enqueued;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(manager.stats().busy, 1);
    assert.equal(runs.get('alice', workspace.id, run.id).status, 'running');
    assert.equal(runs.get('alice', workspace.id, run.id).code, 'ERR_SQLITE_ERROR');
    assert.deepEqual(await manager.sweepIdle(), []);
    await assert.rejects(
      runs.start('alice', workspace.id, { text: 'overlap', sessionId }),
      /RUN_ALREADY_ACTIVE/,
    );
    runtime.answer(sessionId, 'first answer');
    for (let i = 0; i < 100 && runs.stats().active; i++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(runs.get('alice', workspace.id, run.id).status, 'failed');
    assert.equal(manager.stats().busy, 0);
    const successor = await runs.start('alice', workspace.id, { text: 'successor', sessionId });
    runtime.answer(sessionId, 'second answer');
    for (let i = 0; i < 100 && runs.stats().active; i++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(runs.get('alice', workspace.id, successor.id).status, 'done');
  } finally {
    await manager.shutdown();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

for (const runtimeFails of [true, false]) {
  test(`completion bookkeeping error preserves runtime failure=${runtimeFails}`, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'step-completion-error-'));
    const runtime = heldDriver();
    const start = runtime.driver.start;
    const original = new Error('ORIGINAL_RUNTIME_ERROR');
    const bookkeeping = new Error('BOOKKEEPING_ERROR');
    let completing = false;
    runtime.driver.start = async (spec) => {
      const handle = await start(spec);
      const call = handle.call;
      handle.call = ((method: any, input: any) => {
        if (method !== 'ask') return call(method, input);
        completing = true;
        return runtimeFails
          ? Promise.reject(original)
          : Promise.resolve({ sessionId: 'synthetic', status: 'review', sources: [] });
      }) as typeof call;
      return handle;
    };
    const manager = new RuntimeManager({
      dataRoot: provisionTestQuota(dir, 10),
      workspacesPerUser: 10,
      driver: runtime.driver,
    });
    try {
      const workspace = await manager.create('alice', { name: 'completion' });
      await assert.rejects(
        manager.ask('alice', workspace.id, { text: 'synthetic' }, undefined, undefined, {
          authorize: async () => {},
          admit: (publish) => {
            publish();
            if (completing) throw bookkeeping;
          },
        }),
        (error) => error === (runtimeFails ? original : bookkeeping),
      );
      for (let i = 0; i < 100 && manager.stats().busy; i++)
        await new Promise((resolve) => setTimeout(resolve, 5));
      assert.equal(manager.stats().busy, 0);
    } finally {
      await manager.shutdown();
      await rm(dir, { recursive: true, force: true });
    }
  });
}
