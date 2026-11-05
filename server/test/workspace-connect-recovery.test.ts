import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { identityExpired } from '../src/gateway/auth.ts';
import { InvitationStore } from '../src/gateway/invitation-store.ts';
import { RuntimeManager } from '../src/workspace/manager.ts';
import { heldDriver } from './support/held-driver.ts';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}

for (const cleanupFails of [false, true]) {
  for (const waiterExpires of [false, true]) {
    test(`shared connect denial: cleanupFails=${cleanupFails}, waiterExpires=${waiterExpires}`, async () => {
      const dir = await mkdtemp(join(tmpdir(), 'step-connect-recovery-'));
      const runtime = heldDriver();
      const entered = deferred();
      const release = deferred();
      const checked = deferred();
      let now = 100_000;
      let spawns = 0;
      let connects = 0;
      let stops = 0;
      let failStop = cleanupFails;
      const start = runtime.driver.start;
      runtime.driver.start = async (spec) => {
        spawns++;
        const handle = await start(spec);
        const call = handle.call;
        handle.call = ((method: any, params: any) => {
          if (method === 'connect') connects++;
          return call(method, params);
        }) as typeof call;
        const stop = handle.stop;
        handle.stop = async () => {
          stops++;
          if (failStop) throw new Error('synthetic cleanup failure');
          await stop();
        };
        return handle;
      };
      const manager = new RuntimeManager({
        dataRoot: dir,
        driver: runtime.driver,
        maxRunning: 1,
        grant: async () => {
          entered.resolve();
          await release.promise;
          return { baseUrl: 'https://example.com', token: 'synthetic', model: 'synthetic' };
        },
      });
      const admit = (expiry: number, signal?: () => void) => (send: () => void) => {
        if (
          identityExpired(
            { userId: 'alice', email: 'alice@step.example', admin: false, tokenExpiresAt: expiry },
            now,
          )
        )
          throw new Error('UNAUTHENTICATED');
        signal?.();
        send();
      };
      try {
        const workspace = await manager.create('alice', { name: 'shared connect' });
        const leader = assert.rejects(
          manager.start('alice', workspace.id, admit(100)),
          cleanupFails ? /RUNTIME_START_FAILED/ : /UNAUTHENTICATED/,
        );
        await entered.promise;
        const waiter = manager.start(
          'alice',
          workspace.id,
          admit(waiterExpires ? 100 : 1000, checked.resolve),
        );
        // Attach immediately even for the expected success case.
        const outcome = waiter.then(
          (value) => ({ value, error: undefined }),
          (error) => ({ value: undefined, error }),
        );
        await checked.promise;
        now = 161_000;
        release.resolve();
        await leader;
        const result = await outcome;
        if (waiterExpires) assert.match(String(result.error), /UNAUTHENTICATED/);
        else if (cleanupFails) assert.match(String(result.error), /RUNTIME_START_FAILED/);
        else {
          assert.ifError(result.error);
          assert.equal(result.value?.state, 'running');
        }
        assert.equal(spawns, !cleanupFails && !waiterExpires ? 2 : 1);
        assert.equal(connects, !cleanupFails && !waiterExpires ? 1 : 0);
        assert.equal(stops, 1);
        if (cleanupFails) {
          assert.equal((await manager.get('alice', workspace.id)).error, 'RUNTIME_START_CLEANUP_FAILED');
          await assert.rejects(manager.start('alice', workspace.id, admit(1000)), /RUNTIME_NOT_RUNNING/);
          const other = await manager.create('alice', { name: 'capacity' });
          await assert.rejects(manager.start('alice', other.id, admit(1000)), /RUNTIME_CAPACITY/);
        }
      } finally {
        release.resolve();
        failStop = false;
        await manager.shutdown();
        await rm(dir, { recursive: true, force: true });
      }
    });
  }
}

test('real SQLite COMMIT failure after connect enqueue observes later rejection and cleans up', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'step-connect-commit-'));
  const store = new InvitationStore(join(dir, 'invites.sqlite'), ['step.example'], new Set());
  // Test-only access: deferred foreign keys fail at real COMMIT, after send has returned.
  const db = (store as unknown as { db: DatabaseSync }).db;
  db.exec(`PRAGMA foreign_keys = ON;
    CREATE TABLE parent (id INTEGER PRIMARY KEY);
    CREATE TABLE child (parent_id INTEGER REFERENCES parent(id) DEFERRABLE INITIALLY DEFERRED);`);
  const runtime = heldDriver();
  const start = runtime.driver.start;
  let connects = 0;
  let stops = 0;
  let commitFailure: unknown;
  const rejectionDelivered = deferred();
  const cleanupEntered = deferred();
  const releaseCleanup = deferred();
  const grantEntered = deferred();
  const releaseGrant = deferred();
  const waiterChecked = deferred();
  runtime.driver.start = async (spec) => {
    const handle = await start(spec);
    const call = handle.call;
    handle.call = ((method: any, params: any) => {
      if (method !== 'connect') return call(method, params);
      connects++;
      db.exec('INSERT INTO child VALUES (999)');
      return new Promise((_, reject) => {
        setImmediate(() => {
          reject(new Error('synthetic disconnect after failed commit'));
          rejectionDelivered.resolve();
        });
      });
    }) as typeof call;
    const stop = handle.stop;
    handle.stop = async () => {
      stops++;
      cleanupEntered.resolve();
      await releaseCleanup.promise;
      await stop();
    };
    return handle;
  };
  const manager = new RuntimeManager({
    dataRoot: dir,
    driver: runtime.driver,
    maxRunning: 1,
    grant: async () => {
      grantEntered.resolve();
      await releaseGrant.promise;
      return { baseUrl: 'https://example.com', token: 'synthetic', model: 'synthetic' };
    },
  });
  try {
    const workspace = await manager.create('alice', { name: 'commit failure' });
    const leader = assert.rejects(
      manager.start('alice', workspace.id, (send) => {
        try {
          store.dispatch('alice@step.example', send);
        } catch (error) {
          commitFailure = error;
          throw error;
        }
      }),
      (error) => error === commitFailure,
    );
    await grantEntered.promise;
    const waiter = assert.rejects(
      manager.start('alice', workspace.id, (send) => {
        waiterChecked.resolve();
        send();
      }),
      (error) => error === commitFailure,
    );
    await waiterChecked.promise;
    releaseGrant.resolve();
    await cleanupEntered.promise;
    const other = await manager.create('alice', { name: 'capacity during cleanup' });
    await assert.rejects(manager.start('alice', other.id), /RUNTIME_CAPACITY/);
    releaseCleanup.resolve();
    await Promise.all([leader, waiter]);
    assert.match(String(commitFailure), /FOREIGN KEY constraint failed/);
    assert.equal(connects, 1);
    assert.equal(stops, 1);
    assert.equal(manager.stats().running, 0);
    assert.equal(db.prepare('SELECT count(*) AS n FROM child').get()?.n, 0);
    assert.equal((await manager.get('alice', workspace.id)).error, 'RUNTIME_START_FAILED');
    await rejectionDelivered.promise;
    // Let Node report any unhandled rejection; node:test treats it as a test failure.
    await new Promise((resolve) => setImmediate(resolve));
    store.dispatch('alice@step.example', () => {});
  } finally {
    releaseCleanup.resolve();
    await manager.shutdown();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

for (const timesOut of [false, true]) {
  test(`connect ${timesOut ? 'timeout' : 'rejection'} remains a shared startup failure`, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'step-connect-failure-'));
    const runtime = heldDriver();
    const start = runtime.driver.start;
    const entered = deferred();
    const release = deferred();
    const checked = deferred();
    let spawns = 0;
    let connects = 0;
    runtime.driver.start = async (spec) => {
      spawns++;
      const handle = await start(spec);
      const call = handle.call;
      handle.call = ((method: any, params: any) => {
        if (method !== 'connect') return call(method, params);
        connects++;
        return timesOut ? new Promise(() => {}) : Promise.reject(new Error('synthetic connect failure'));
      }) as typeof call;
      return handle;
    };
    const manager = new RuntimeManager({
      dataRoot: dir,
      driver: runtime.driver,
      connectTimeoutMs: 10,
      grant: async () => {
        entered.resolve();
        await release.promise;
        return { baseUrl: 'https://example.com', token: 'synthetic', model: 'synthetic' };
      },
    });
    try {
      const workspace = await manager.create('alice', { name: 'connect failure' });
      const leader = assert.rejects(
        manager.start('alice', workspace.id, (send) => send()),
        /RUNTIME_START_FAILED/,
      );
      await entered.promise;
      const waiter = assert.rejects(
        manager.start('alice', workspace.id, (send) => {
          checked.resolve();
          send();
        }),
        /RUNTIME_START_FAILED/,
      );
      await checked.promise;
      release.resolve();
      await Promise.all([leader, waiter]);
      assert.equal(spawns, 1);
      assert.equal(connects, 1);
      assert.equal((await manager.get('alice', workspace.id)).error, 'RUNTIME_START_FAILED');
    } finally {
      release.resolve();
      await manager.shutdown();
      await rm(dir, { recursive: true, force: true });
    }
  });
}
