import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
        call: async () => {
          throw new Error('unused');
        },
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
    assert.equal((await ctx.manager.get('alice', ctx.id)).state, 'running');
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
