import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RuntimeManager } from '../src/workspace/manager.ts';
import { processDriver } from '../src/workspace/process-driver.ts';

test('shutdown cannot finish while the timed-out startup child is still alive', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'step-timeout-'));
  const original = ChildProcess.prototype.kill;
  let child: ChildProcess | undefined;
  let signalled!: () => void;
  const signal = new Promise<void>((resolve) => (signalled = resolve));
  ChildProcess.prototype.kill = function (this: ChildProcess, _signal) {
    child = this;
    signalled();
    return true;
  };
  const manager = new RuntimeManager({
    workspacesPerUser: 10,
    dataRoot: dir,
    driver: processDriver({ startTimeoutMs: 1 }),
  });
  try {
    const workspace = await manager.create('alice', { name: 'test' });
    const start = manager.start('alice', workspace.id).catch(() => {});
    await signal;
    let finished = false;
    const shutdown = manager.shutdown().then(() => {
      finished = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(child?.exitCode, null);
    assert.equal(child?.signalCode, null);
    assert.equal(finished, false, 'shutdown returned while child was alive');
    original.call(child!, 'SIGKILL');
    await Promise.all([start, shutdown]);
  } finally {
    ChildProcess.prototype.kill = original;
    if (child && child.exitCode === null && child.signalCode === null) original.call(child, 'SIGKILL');
    await rm(dir, { recursive: true, force: true });
  }
});

test('failed signals retain a live child and shutdown reports failure within a bound', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'step-signal-failure-'));
  const kill = ChildProcess.prototype.kill;
  const disconnect = ChildProcess.prototype.disconnect;
  let child: ChildProcess | undefined;
  ChildProcess.prototype.kill = function (this: ChildProcess) {
    child = this;
    throw new Error('kill denied');
  };
  ChildProcess.prototype.disconnect = function () {
    throw new Error('disconnect denied');
  };
  const manager = new RuntimeManager({
    workspacesPerUser: 10,
    dataRoot: dir,
    maxRunning: 1,
    driver: processDriver({ startTimeoutMs: 1, stopTimeoutMs: 10 }),
  });
  try {
    const first = await manager.create('alice', { name: 'first' });
    const second = await manager.create('alice', { name: 'second' });
    await assert.rejects(manager.start('alice', first.id), /RUNTIME_START_FAILED/);
    assert.equal((await manager.get('alice', first.id)).error, 'RUNTIME_START_CLEANUP_FAILED');
    await assert.rejects(manager.start('alice', second.id), /RUNTIME_CAPACITY/);
    await assert.rejects(manager.shutdown(), /RUNTIME_STOP_FAILED/);
    assert.equal(child?.exitCode, null);
    assert.equal(child?.signalCode, null);
  } finally {
    ChildProcess.prototype.kill = kill;
    ChildProcess.prototype.disconnect = disconnect;
    if (child && child.exitCode === null && child.signalCode === null) kill.call(child, 'SIGKILL');
    await manager.shutdown().catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});

test('hung connect is timed out and shutdown confirms the actual child exit', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'step-connect-child-'));
  let pid: number | undefined;
  let exited = false;
  let entered!: () => void;
  const connecting = new Promise<void>((resolve) => (entered = resolve));
  const driver = processDriver({ stopTimeoutMs: 100 });
  const manager = new RuntimeManager({
    workspacesPerUser: 10,
    dataRoot: dir,
    driver: {
      async start(spec) {
        const handle = await driver.start(spec);
        pid = handle.pid;
        handle.onExit(() => {
          exited = true;
        });
        return {
          ...handle,
          call: (method, params) => {
            if (method !== 'connect') return handle.call(method, params);
            entered();
            return new Promise(() => {});
          },
        };
      },
    },
    connectTimeoutMs: 30,
    grant: () => ({ baseUrl: 'https://example.com', token: 'synthetic', model: 'model' }),
  });
  try {
    const workspace = await manager.create('alice', { name: 'test' });
    const start = assert.rejects(manager.start('alice', workspace.id), /RUNTIME_START_FAILED/);
    await connecting;
    const shutdown = manager.shutdown();
    await Promise.all([start, shutdown]);
    assert.ok(pid);
    assert.ok(exited, 'child exit must be confirmed');
    assert.equal((await manager.get('alice', workspace.id)).state, 'stopped');
  } finally {
    if (pid && !exited) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* child already exited */
      }
    }
    await manager.shutdown().catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});
