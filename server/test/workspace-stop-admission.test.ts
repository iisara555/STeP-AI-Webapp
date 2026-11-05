import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { RuntimeManager } from '../src/workspace/manager.ts';
import { processDriver } from '../src/workspace/process-driver.ts';
import { InvitationStore } from '../src/gateway/invitation-store.ts';
import type { RuntimeDriver } from '../src/workspace/contract.ts';

const gate = () => {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => (release = resolve));
  return { promise, release };
};

async function setup(stop: (admit: (signal: () => void) => void) => Promise<void>, supported = true) {
  const dir = await mkdtemp(join(tmpdir(), 'step-stop-admission-'));
  let trustedStops = 0;
  const driver: RuntimeDriver = {
    async start(spec) {
      return {
        health: async () => ({ ok: true, workspaceId: spec.workspaceId }),
        call: async () => ({ sessionId: 'session' }) as never,
        onExit: () => {},
        stop: async () => {
          trustedStops++;
        },
        ...(supported ? { stopWithAdmission: stop } : {}),
      };
    },
  };
  const manager = new RuntimeManager({ dataRoot: dir, driver });
  const workspace = await manager.create('alice', { name: 'synthetic' });
  await manager.start('alice', workspace.id);
  return {
    manager,
    id: workspace.id,
    trustedStops: () => trustedStops,
    cleanup: async () => {
      await manager.shutdown();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test('unsupported driver fails closed and remains available for trusted cleanup', async () => {
  const ctx = await setup(async () => {}, false);
  try {
    await assert.rejects(
      ctx.manager.stop('alice', ctx.id, (signal) => signal()),
      /ADMISSION_UNSUPPORTED/,
    );
    assert.equal((await ctx.manager.get('alice', ctx.id)).state, 'running');
    assert.equal(ctx.trustedStops(), 0);
  } finally {
    await ctx.cleanup();
  }
  assert.equal(ctx.trustedStops(), 1);
});

test('failed stop retains the handle and a subsequent stop retries', async () => {
  let attempts = 0;
  const ctx = await setup(async (admit) => {
    admit(() => {
      attempts++;
    });
    if (attempts === 1) throw new Error('stop failed');
  });
  try {
    await assert.rejects(
      ctx.manager.stop('alice', ctx.id, (signal) => signal()),
      /stop failed/,
    );
    assert.equal((await ctx.manager.get('alice', ctx.id)).state, 'failed');
    await assert.rejects(ctx.manager.start('alice', ctx.id), /RUNTIME_NOT_RUNNING/);
    assert.equal((await ctx.manager.stop('alice', ctx.id, (signal) => signal())).state, 'stopped');
    assert.equal(attempts, 2);
  } finally {
    await ctx.cleanup();
  }
});

test('concurrent stop retries after denied admission using its own authority', async () => {
  const entered = gate();
  const release = gate();
  let signals = 0;
  const ctx = await setup(async (admit) => {
    entered.release();
    await release.promise;
    admit(() => {
      signals++;
    });
  });
  try {
    const denied = ctx.manager.stop('alice', ctx.id, () => {
      throw new Error('denied');
    });
    await entered.promise;
    const allowed = ctx.manager.stop('alice', ctx.id, (signal) => signal());
    release.release();
    await assert.rejects(denied, /denied/);
    assert.equal((await allowed).state, 'stopped');
    assert.equal(signals, 1);
  } finally {
    release.release();
    await ctx.cleanup();
  }
});

test('start and call wait independently for a denied stop and reuse the running runtime', async () => {
  const entered = gate();
  const release = gate();
  const waiting = gate();
  let starts = 0;
  let signals = 0;
  const dir = await mkdtemp(join(tmpdir(), 'step-denied-start-'));
  const driver: RuntimeDriver = {
    async start(spec) {
      starts++;
      return {
        health: async () => ({ ok: true, workspaceId: spec.workspaceId }),
        call: async () => ({ sessionId: 'session' }) as never,
        onExit: () => {},
        stop: async () => {},
        async stopWithAdmission(admit) {
          entered.release();
          await release.promise;
          admit(() => signals++);
        },
      };
    },
  };
  const manager = new RuntimeManager({ dataRoot: dir, driver });
  const w = await manager.create('alice', { name: 'A' });
  try {
    await manager.start('alice', w.id);
    const denied = manager.stop('alice', w.id, () => {
      throw new Error('denied');
    });
    const deniedResult = assert.rejects(denied, /denied/);
    await entered.promise;
    // Observe the barrier, not a timer: both operations must actually wait before denial.
    const live = (manager as unknown as { live: Map<string, { stopping?: Promise<void> }> }).live;
    const entry = live.get(`alice/${w.id}`)!;
    let stopping = entry.stopping;
    let reads = 0;
    Object.defineProperty(entry, 'stopping', {
      configurable: true,
      get() {
        if (++reads === 4) waiting.release();
        return stopping;
      },
      set(value) {
        stopping = value;
      },
    });
    const start = manager.start('alice', w.id);
    const call = manager.newConversation('alice', w.id);
    const result = Promise.all([start, call]);
    await waiting.promise;
    release.release();
    await deniedResult;
    const [workspace, conversation] = await result;
    assert.equal(workspace.state, 'running');
    assert.equal(conversation.sessionId, 'session');
    assert.equal(signals, 0);
    assert.equal(starts, 1);
    assert.equal((await manager.health('alice', w.id)).ok, true);
  } finally {
    release.release();
    await manager.shutdown();
    await rm(dir, { recursive: true, force: true });
  }
});

for (const failure of ['authorization', 'driver-after-signal'] as const) {
  test(`waiting start handles ${failure} failure without masking the stop result`, async () => {
    const entered = gate();
    const release = gate();
    const waiting = gate();
    const error = new Error(failure);
    let starts = 0;
    let signals = 0;
    const dir = await mkdtemp(join(tmpdir(), 'step-stop-wait-'));
    const driver: RuntimeDriver = {
      async start(spec) {
        starts++;
        return {
          health: async () => ({ ok: true, workspaceId: spec.workspaceId }),
          call: async () => ({}) as never,
          onExit: () => {},
          stop: async () => {},
          async stopWithAdmission(admit) {
            admit(() => signals++);
            entered.release();
            await release.promise;
            throw error;
          },
        };
      },
    };
    const manager = new RuntimeManager({ dataRoot: dir, driver });
    const w = await manager.create('alice', { name: 'A' });
    try {
      await manager.start('alice', w.id);
      const stop = manager.stop(
        'alice',
        w.id,
        (signal) => signal(),
        async () => {
          if (failure === 'authorization') {
            entered.release();
            await release.promise;
            throw error;
          }
        },
      );
      const rejected = assert.rejects(stop, (actual) => actual === error);
      await entered.promise;
      const live = (manager as unknown as { live: Map<string, { stopping?: Promise<void> }> }).live;
      const entry = live.get(`alice/${w.id}`)!;
      let stopping = entry.stopping;
      let reads = 0;
      Object.defineProperty(entry, 'stopping', {
        configurable: true,
        get() {
          if (++reads === 2) waiting.release();
          return stopping;
        },
        set(value) {
          stopping = value;
        },
      });
      const start = manager.start('alice', w.id);
      const result =
        failure === 'authorization' ? start : assert.rejects(start, (actual) => actual === error);
      await waiting.promise;
      release.release();
      await rejected;
      const started = await result;
      if (failure === 'authorization') assert.equal((started as { state: string }).state, 'running');
      assert.equal(signals, failure === 'authorization' ? 0 : 1);
      assert.equal(starts, 1);
      assert.equal(
        (await manager.get('alice', w.id)).state,
        failure === 'authorization' ? 'running' : 'failed',
      );
    } finally {
      release.release();
      await manager.shutdown();
      await rm(dir, { recursive: true, force: true });
    }
  });
}

test('concurrent stop independently checks authority after a successful stop', async () => {
  const entered = gate();
  const release = gate();
  const ctx = await setup(async (admit) => {
    admit(() => {});
    entered.release();
    await release.promise;
  });
  try {
    const allowed = ctx.manager.stop('alice', ctx.id, (signal) => signal());
    await entered.promise;
    const denied = ctx.manager.stop('alice', ctx.id, () => {
      throw new Error('denied');
    });
    release.release();
    await allowed;
    await assert.rejects(denied, /denied/);
  } finally {
    release.release();
    await ctx.cleanup();
  }
});

test('the process driver does not disconnect on denied admission and can subsequently stop', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'step-stop-process-'));
  const manager = new RuntimeManager({ dataRoot: dir, driver: processDriver() });
  try {
    const w = await manager.create('alice', { name: 'synthetic' });
    await manager.start('alice', w.id);
    await assert.rejects(
      manager.stop('alice', w.id, () => {
        throw new Error('denied');
      }),
      /denied/,
    );
    assert.equal((await manager.health('alice', w.id)).ok, true);
    assert.equal((await manager.stop('alice', w.id, (signal) => signal())).state, 'stopped');
  } finally {
    await manager.shutdown();
    await rm(dir, { recursive: true, force: true });
  }
});

test('invitation lock is released while waiting for stop completion', async () => {
  const entered = gate();
  const release = gate();
  const ctx = await setup(async (admit) => {
    admit(() => {});
    entered.release();
    await release.promise;
  });
  const dir = await mkdtemp(join(tmpdir(), 'step-stop-lock-'));
  const base = new Set(['root@step.example', 'alice@step.example']);
  const first = new InvitationStore(join(dir, 'db.sqlite'), ['step.example'], new Set(['root@step.example']));
  const second = new InvitationStore(
    join(dir, 'db.sqlite'),
    ['step.example'],
    new Set(['root@step.example']),
  );
  try {
    const stopping = ctx.manager.stop('alice', ctx.id, (signal) =>
      first.dispatch('alice@step.example', signal),
    );
    await entered.promise;
    second.change('root@step.example', 'alice@step.example', false, base);
    assert.equal(first.invited(base).has('alice@step.example'), false);
    release.release();
    await stopping;
  } finally {
    release.release();
    await ctx.cleanup();
    first.close();
    second.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('SQLite commit failure after process signal fails closed until exit and then recovers', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'step-stop-commit-'));
  const path = join(dir, 'db.sqlite');
  const store = new InvitationStore(path, ['step.example'], new Set());
  const db = (store as unknown as { db: DatabaseSync }).db;
  db.exec('PRAGMA busy_timeout=0');
  const reader = new DatabaseSync(path);
  const manager = new RuntimeManager({ dataRoot: dir, driver: processDriver() });
  try {
    const w = await manager.create('alice', { name: 'synthetic' });
    await manager.start('alice', w.id);
    reader.exec('BEGIN; SELECT * FROM invitations');
    await assert.rejects(
      manager.stop('alice', w.id, (signal) =>
        store.dispatch('alice@step.example', () => {
          db.exec("INSERT INTO invitations VALUES ('other@step.example', 1)");
          signal();
        }),
      ),
      /locked|busy/i,
    );
    assert.equal((await manager.get('alice', w.id)).state, 'failed');
    assert.equal((await manager.health('alice', w.id)).ok, false);
    // A retry must not report a disconnected child as running.
    const recovered = await manager.start('alice', w.id).catch(() => undefined);
    if (recovered) assert.equal((await manager.health('alice', w.id)).ok, true);
    reader.exec('ROLLBACK');
    await manager.stop('alice', w.id);
    assert.equal((await manager.start('alice', w.id)).state, 'running');
    assert.equal((await manager.health('alice', w.id)).ok, true);
  } finally {
    try {
      reader.exec('ROLLBACK');
    } catch {}
    await manager.shutdown();
    reader.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('unsupported admission does not poison concurrent starts or calls', async () => {
  const entered = gate();
  const release = gate();
  const ctx = await setup(async () => {}, false);
  try {
    const stop = ctx.manager.stop(
      'alice',
      ctx.id,
      () => {},
      async () => {
        entered.release();
        await release.promise;
      },
    );
    const rejected = assert.rejects(stop, /ADMISSION_UNSUPPORTED/);
    await entered.promise;
    const start = ctx.manager.start('alice', ctx.id);
    const call = ctx.manager.newConversation('alice', ctx.id);
    // Ensure start reached the pending stop before releasing authorization.
    const entry = (ctx.manager as unknown as { live: Map<string, { stopping?: Promise<void> }> }).live.get(
      `alice/${ctx.id}`,
    )!;
    const waiting = gate();
    let stopping = entry.stopping;
    let reads = 0;
    Object.defineProperty(entry, 'stopping', {
      configurable: true,
      get() {
        if (++reads === 4) waiting.release();
        return stopping;
      },
      set(value) {
        stopping = value;
      },
    });
    await waiting.promise;
    release.release();
    await rejected;
    assert.equal((await start).state, 'running');
    assert.equal((await call).sessionId, 'session');
    assert.equal((await ctx.manager.health('alice', ctx.id)).ok, true);
    assert.equal(ctx.trustedStops(), 0);
  } finally {
    release.release();
    await ctx.cleanup();
  }
});
