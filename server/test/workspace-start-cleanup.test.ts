import { provisionTestQuota } from './support/quota.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RuntimeManager } from '../src/workspace/manager.ts';
import {
  RuntimeStartCleanupError,
  type RuntimeDriver,
  type RuntimeHandle,
} from '../src/workspace/contract.ts';

test('failed startup cleanup retains capacity until shutdown retries successfully', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'step-start-cleanup-'));
  let starts = 0;
  let stops = 0;
  let failGrant = true;
  const driver: RuntimeDriver = {
    async start(spec) {
      starts++;
      return {
        health: async () => ({ ok: true, workspaceId: spec.workspaceId }),
        call: async () => ({ sessionId: 'session' }) as never,
        onExit: () => {},
        stop: async () => {
          stops++;
          if (stops < 3) throw new Error('cleanup-secret');
        },
      };
    },
  };
  const manager = new RuntimeManager({
    workspacesPerUser: 10,
    dataRoot: provisionTestQuota(dir, 10),
    driver,
    maxRunning: 1,
    grant: () => {
      if (failGrant) throw new Error('grant-secret');
      return undefined;
    },
  });
  const first = await manager.create('alice', { name: 'first' });
  const second = await manager.create('alice', { name: 'second' });
  try {
    await assert.rejects(manager.start('alice', first.id), /^WorkspaceError: RUNTIME_START_FAILED$/);
    const view = await manager.get('alice', first.id);
    assert.equal(view.state, 'failed');
    assert.equal(view.error, 'RUNTIME_START_CLEANUP_FAILED');
    assert.equal((await manager.health('alice', first.id)).ok, false);
    await assert.rejects(manager.start('alice', first.id), /RUNTIME_NOT_RUNNING/);
    await assert.rejects(manager.start('alice', second.id), /RUNTIME_CAPACITY/);
    assert.equal(starts, 1);
    await assert.rejects(manager.shutdown(), /^WorkspaceError: RUNTIME_STOP_FAILED$/);
    await assert.rejects(manager.start('alice', second.id), /RUNTIME_MANAGER_SHUTTING_DOWN/);
    await manager.shutdown();
    assert.equal(stops, 3);
    assert.equal((await manager.get('alice', first.id)).state, 'stopped');
    await assert.rejects(manager.start('alice', second.id), /RUNTIME_MANAGER_SHUTTING_DOWN/);
    assert.equal(starts, 1);
  } finally {
    await manager.shutdown();
    await rm(dir, { recursive: true, force: true });
  }
});

test('shutdown waits for pending failed startup cleanup and retries the retained handle', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'step-start-race-'));
  let release!: () => void;
  let entered!: () => void;
  const waiting = new Promise<void>((resolve) => (entered = resolve));
  const gate = new Promise<void>((resolve) => (release = resolve));
  let stops = 0;
  let starts = 0;
  const driver: RuntimeDriver = {
    async start(spec) {
      starts++;
      return {
        health: async () => ({ ok: true, workspaceId: spec.workspaceId }),
        call: async () => {
          throw new Error('provider-secret');
        },
        onExit: () => {},
        stop: async () => {
          stops++;
          if (stops === 1) {
            entered();
            await gate;
            throw new Error('cleanup-secret');
          }
        },
      };
    },
  };
  const manager = new RuntimeManager({
    workspacesPerUser: 10,
    dataRoot: provisionTestQuota(dir, 10),
    driver,
    maxRunning: 1,
    grant: () => ({ baseUrl: 'https://example.com', token: 'secret', model: 'model' }),
  });
  const first = await manager.create('alice', { name: 'first' });
  const second = await manager.create('alice', { name: 'second' });
  try {
    const start = assert.rejects(manager.start('alice', first.id), /RUNTIME_START_FAILED/);
    await waiting;
    const concurrent = assert.rejects(manager.start('alice', first.id), /RUNTIME_START_FAILED/);
    await assert.rejects(manager.start('alice', second.id), /RUNTIME_CAPACITY/);
    const shutdown = manager.shutdown();
    release();
    await Promise.all([start, concurrent, shutdown]);
    assert.equal(starts, 1);
    assert.equal(stops, 2);
    assert.equal((await manager.get('alice', first.id)).state, 'stopped');
  } finally {
    release();
    await manager.shutdown();
    await rm(dir, { recursive: true, force: true });
  }
});

test('an orphan exit releases capacity without a cleanup retry', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'step-start-exit-'));
  let exit!: (code: number | null) => void;
  let stops = 0;
  let grantFails = true;
  const driver: RuntimeDriver = {
    async start(spec) {
      return {
        health: async () => ({ ok: true, workspaceId: spec.workspaceId }),
        call: async () => ({}) as never,
        onExit: (listener) => {
          exit = listener;
        },
        stop: async () => {
          if (++stops === 1) throw new Error('cleanup-secret');
        },
      };
    },
  };
  const manager = new RuntimeManager({
    workspacesPerUser: 10,
    dataRoot: provisionTestQuota(dir, 10),
    driver,
    maxRunning: 1,
    grant: () => {
      if (grantFails) throw new Error('grant-secret');
      return undefined;
    },
  });
  const first = await manager.create('alice', { name: 'first' });
  const second = await manager.create('alice', { name: 'second' });
  try {
    await assert.rejects(manager.start('alice', first.id), /RUNTIME_START_FAILED/);
    exit(1);
    assert.equal((await manager.get('alice', first.id)).error, 'RUNTIME_EXITED');
    grantFails = false;
    assert.equal((await manager.start('alice', second.id)).state, 'running');
    assert.equal(stops, 1);
  } finally {
    await manager.shutdown();
    await rm(dir, { recursive: true, force: true });
  }
});

test('a successful retry of unconfirmed driver startup cleanup clears the diagnostic', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'step-start-retry-'));
  let stops = 0;
  const handle: RuntimeHandle = {
    health: async () => ({ ok: false, workspaceId: 'test' }),
    call: async () => ({}) as never,
    onExit: () => {},
    stop: async () => {
      stops++;
    },
  };
  const manager = new RuntimeManager({
    workspacesPerUser: 10,
    dataRoot: provisionTestQuota(dir, 10),
    driver: {
      start: async () => {
        throw new RuntimeStartCleanupError(handle);
      },
    },
  });
  try {
    const workspace = await manager.create('alice', { name: 'test' });
    await assert.rejects(manager.start('alice', workspace.id), /RUNTIME_START_FAILED/);
    assert.equal(stops, 1);
    assert.equal((await manager.get('alice', workspace.id)).error, 'RUNTIME_START_FAILED');
  } finally {
    await manager.shutdown();
    await rm(dir, { recursive: true, force: true });
  }
});

test('shutdown during a hung connect waits for timeout and confirmed cleanup, retaining failures for retry', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'step-connect-race-'));
  let entered!: () => void;
  let release!: () => void;
  const connecting = new Promise<void>((resolve) => (entered = resolve));
  const gate = new Promise<void>((resolve) => (release = resolve));
  let stops = 0;
  const driver: RuntimeDriver = {
    async start(spec) {
      return {
        health: async () => ({ ok: true, workspaceId: spec.workspaceId }),
        call: async () => {
          entered();
          await gate;
          return { ok: true } as never;
        },
        onExit: () => {},
        stop: async () => {
          if (++stops <= 2) throw new Error('stop failed');
        },
      };
    },
  };
  const manager = new RuntimeManager({
    workspacesPerUser: 10,
    dataRoot: provisionTestQuota(dir, 10),
    driver,
    maxRunning: 1,
    connectTimeoutMs: 20,
    grant: () => ({ baseUrl: 'https://example.com', token: 'secret', model: 'model' }),
  });
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  try {
    const first = await manager.create('alice', { name: 'first' });
    const second = await manager.create('alice', { name: 'second' });
    const start = assert.rejects(manager.start('alice', first.id), /RUNTIME_START_FAILED/);
    await connecting;
    const shutdown = assert.rejects(manager.shutdown(), /RUNTIME_STOP_FAILED/);
    await Promise.race([
      Promise.all([start, shutdown]),
      new Promise<never>((_, reject) => {
        watchdog = setTimeout(() => reject(new Error('shutdown hung during connect')), 500);
      }),
    ]);
    assert.equal(stops, 2);
    assert.equal((await manager.get('alice', first.id)).state, 'failed');
    assert.equal((await manager.get('alice', first.id)).error, 'RUNTIME_STOP_FAILED');
    await assert.rejects(manager.start('alice', second.id), /RUNTIME_MANAGER_SHUTTING_DOWN/);
    await manager.shutdown();
    assert.equal(stops, 3);
    assert.equal((await manager.get('alice', first.id)).state, 'stopped');
    release();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal((await manager.get('alice', first.id)).state, 'stopped');
  } finally {
    clearTimeout(watchdog);
    release();
    await manager.shutdown().catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});
