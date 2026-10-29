import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile, symlink } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceError, type RuntimeDriver } from '../src/workspace/contract.ts';
import { RuntimeManager } from '../src/workspace/manager.ts';
import { isolatedRuntimeArgs, processDriver, runtimeEnv } from '../src/workspace/process-driver.ts';
import { workspacePaths } from '../src/workspace/storage.ts';

const code = (expected: string) => (error: unknown) =>
  error instanceof WorkspaceError && error.code === expected;

async function withManager(
  fn: (manager: RuntimeManager, dataRoot: string) => Promise<void>,
  options: Partial<ConstructorParameters<typeof RuntimeManager>[0]> = {},
) {
  const dataRoot = await mkdtemp(join(tmpdir(), 'step-workspaces-'));
  const manager = new RuntimeManager({ dataRoot, driver: processDriver(), ...options });
  try {
    await fn(manager, dataRoot);
  } finally {
    await manager.shutdown();
    await rm(dataRoot, { recursive: true, force: true });
  }
}

/** Starts instantly and records what it was given; for policy tests that do not need a real process. */
function fakeDriver() {
  const started: string[] = [];
  const driver: RuntimeDriver = {
    async start(spec) {
      started.push(spec.workspaceId);
      let exit: (code: number | null) => void = () => {};
      return {
        health: async () => ({ ok: true, workspaceId: spec.workspaceId }),
        call: async () => {
          throw new Error('UNUSED');
        },
        stop: async () => exit(0),
        onExit: (listener) => void (exit = listener),
      };
    },
  };
  return { driver, started };
}

test('two users have separate private Workspaces and cannot reach each other’s', async () => {
  await withManager(async (manager, dataRoot) => {
    const a = await manager.create('alice', { name: 'โครงการ A' });
    const b = await manager.create('bob', { name: 'โครงการ B' });
    assert.deepEqual(
      (await manager.list('alice')).map((w) => w.id),
      [a.id],
    );
    assert.deepEqual(
      (await manager.list('bob')).map((w) => w.id),
      [b.id],
    );
    for (const call of [
      () => manager.get('bob', a.id),
      () => manager.start('bob', a.id),
      () => manager.stop('bob', a.id),
      () => manager.health('bob', a.id),
      () => manager.touch('bob', a.id),
    ])
      await assert.rejects(call, code('WORKSPACE_NOT_FOUND'));

    // ADR 0001 §2 layout, private to the service user at every level a user id appears.
    const paths = workspacePaths(dataRoot, 'alice', a.id);
    assert.equal(paths.dir, join(dataRoot, 'users', 'alice', 'workspaces', a.id));
    for (const dir of [
      join(dataRoot, 'users', 'alice'),
      join(dataRoot, 'users', 'alice', 'workspaces'),
      paths.dir,
      paths.filesDir,
      join(paths.dir, 'snapshots'),
    ])
      assert.equal((await stat(dir)).mode & 0o077, 0, dir);
  });
});

test('ids that could leave the data root are refused before any file is touched', async () => {
  await withManager(async (manager) => {
    for (const user of ['..', '../bob', '.hidden', 'a/b', '', 'x'.repeat(65)])
      await assert.rejects(() => manager.create(user, { name: 'x' }), code('INVALID_ID'), user);
    for (const id of ['../ws_x', 'ws_' + '0'.repeat(31), 'ws_' + 'g'.repeat(32)])
      await assert.rejects(() => manager.get('alice', id), code('INVALID_ID'), id);
    await assert.rejects(() => manager.create('alice', { name: '   ' }), code('INVALID_NAME'));
  });
});

test('a runtime is its own process in its own folder and inherits no secrets', async () => {
  process.env.STEP_AI_KEY = 'synthetic-secret';
  try {
    await withManager(async (manager, dataRoot) => {
      const a = await manager.create('alice', { name: 'A' });
      const b = await manager.create('bob', { name: 'B' });
      assert.equal((await manager.start('alice', a.id)).state, 'running');
      assert.equal((await manager.start('bob', b.id)).state, 'running');
      const ha = await manager.health('alice', a.id);
      const hb = await manager.health('bob', b.id);
      assert.equal(ha.ok, true);
      assert.equal(ha.workspaceId, a.id);
      assert.notEqual(ha.pid, process.pid);
      assert.notEqual(ha.pid, hb.pid);
      assert.equal(ha.cwd, workspacePaths(dataRoot, 'alice', a.id).filesDir);
      assert.equal(hb.cwd, workspacePaths(dataRoot, 'bob', b.id).filesDir);
      const env = runtimeEnv(workspacePaths(dataRoot, 'alice', a.id));
      assert.equal(env.STEP_AI_KEY, undefined);
      assert.deepEqual(Object.keys(env).sort(), [
        'LANG',
        'NODE_ENV',
        'PATH',
        'STEP_WORKSPACE_DIR',
        'STEP_WORKSPACE_ID',
      ]);
    });
  } finally {
    delete process.env.STEP_AI_KEY;
  }
});

test('stop keeps the data and start resumes the same Workspace in a new process', async () => {
  await withManager(async (manager, dataRoot) => {
    const w = await manager.create('alice', { name: 'A' });
    const first = (await manager.start('alice', w.id), await manager.health('alice', w.id));
    const file = join(workspacePaths(dataRoot, 'alice', w.id).filesDir, 'note.txt');
    await writeFile(file, 'ร่างที่ทำค้างไว้');
    assert.equal((await manager.stop('alice', w.id)).state, 'stopped');
    assert.equal((await manager.health('alice', w.id)).ok, false);

    await manager.start('alice', w.id);
    const second = await manager.health('alice', w.id);
    assert.equal(second.ok, true);
    assert.notEqual(second.pid, first.pid);
    assert.equal(await readFile(file, 'utf8'), 'ร่างที่ทำค้างไว้');
  });
});

test('a crashed runtime is reported as failed and can be started again', async () => {
  await withManager(async (manager) => {
    const w = await manager.create('alice', { name: 'A' });
    await manager.start('alice', w.id);
    const { pid } = await manager.health('alice', w.id);
    process.kill(pid!, 'SIGKILL');
    for (let i = 0; i < 100 && (await manager.get('alice', w.id)).state !== 'failed'; i++)
      await new Promise((done) => setTimeout(done, 20));
    const failed = await manager.get('alice', w.id);
    assert.equal(failed.state, 'failed');
    assert.equal(failed.error, 'RUNTIME_EXITED');

    assert.equal((await manager.start('alice', w.id)).state, 'running');
    assert.equal((await manager.health('alice', w.id)).ok, true);
  });
});

test('the shared server admits only maxRunning runtimes and stops idle ones', async () => {
  let clock = 0;
  const { driver, started } = fakeDriver();
  await withManager(
    async (manager) => {
      const a = await manager.create('alice', { name: 'A' });
      const b = await manager.create('bob', { name: 'B' });
      await manager.start('alice', a.id);
      await manager.start('alice', a.id); // already running: no second runtime
      assert.deepEqual(started, [a.id]);
      await assert.rejects(() => manager.start('bob', b.id), code('RUNTIME_CAPACITY'));

      clock = 10 * 60_000;
      assert.deepEqual(await manager.sweepIdle(), [], 'not idle long enough');
      clock = 31 * 60_000;
      assert.deepEqual(await manager.sweepIdle(), [a.id]);
      assert.equal((await manager.get('alice', a.id)).state, 'stopped');
      assert.equal((await manager.start('bob', b.id)).state, 'running');

      clock = 40 * 60_000;
      await manager.touch('bob', b.id);
      clock = 65 * 60_000;
      assert.deepEqual(await manager.sweepIdle(), [], 'activity resets the idle timer');
    },
    { driver, maxRunning: 1, idleMs: 30 * 60_000, now: () => clock },
  );
});

test('a request waits for a stopping runtime before starting its replacement', async () => {
  let release!: () => void;
  let stopping!: () => void;
  const stopped = new Promise<void>((resolve) => (release = resolve));
  const beganStopping = new Promise<void>((resolve) => (stopping = resolve));
  let starts = 0;
  const driver: RuntimeDriver = {
    async start(spec) {
      starts++;
      let exit: (code: number | null) => void = () => {};
      return {
        health: async () => ({ ok: true, workspaceId: spec.workspaceId }),
        call: async () => ({}) as never,
        async stop() {
          stopping();
          await stopped;
          exit(0);
        },
        onExit: (listener) => {
          exit = listener;
        },
      };
    },
  };
  await withManager(
    async (manager) => {
      const workspace = await manager.create('alice', { name: 'A' });
      await manager.start('alice', workspace.id);
      const stop = manager.stop('alice', workspace.id);
      await beganStopping;
      const restart = manager.start('alice', workspace.id);
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(starts, 1);
      release();
      await stop;
      assert.equal((await restart).state, 'running');
      assert.equal(starts, 2);
    },
    { driver },
  );
});

test('concurrent activity updates do not collide on the workspace metadata file', async () => {
  const { driver } = fakeDriver();
  await withManager(
    async (manager) => {
      const workspace = await manager.create('alice', { name: 'A' });
      await manager.start('alice', workspace.id);
      await Promise.all(Array.from({ length: 20 }, () => manager.touch('alice', workspace.id)));
      assert.equal((await manager.get('alice', workspace.id)).state, 'running');
    },
    { driver },
  );
});

test('isolated runtime cannot read another workspace or connect to the host loopback', async () => {
  await withManager(async (manager, root) => {
    const a = await manager.create('alice', { name: 'A' });
    const b = await manager.create('bob', { name: 'B' });
    const first = workspacePaths(root, 'alice', a.id);
    const other = workspacePaths(root, 'bob', b.id);
    const secret = join(other.filesDir, 'private.txt');
    await writeFile(secret, 'synthetic private data');
    await writeFile(join(first.filesDir, 'own.txt'), 'own');
    await symlink(secret, join(first.filesDir, 'link'));
    const listener = createServer((socket) => socket.end());
    await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
    const port = (listener.address() as { port: number }).port;
    try {
      const script = `const fs=require('node:fs'); const net=require('node:net'); const check=p=>{try{fs.readFileSync(p);return true}catch{return false}}; const socket=net.connect(${port},'127.0.0.1'); socket.setTimeout(1000); socket.on('connect',()=>{console.log(JSON.stringify({own:check('own.txt'),other:check(${JSON.stringify(secret)}),link:check('link'),network:true}));socket.destroy()});socket.on('error',()=>console.log(JSON.stringify({own:check('own.txt'),other:check(${JSON.stringify(secret)}),link:check('link'),network:false})));socket.on('timeout',()=>{socket.destroy();process.exit(2)});`;
      const child = spawn('/usr/bin/bwrap', [...isolatedRuntimeArgs(first), '-e', script], {
        cwd: first.filesDir,
        env: runtimeEnv(first),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '',
        error = '';
      child.stdout.on('data', (chunk) => (output += chunk));
      child.stderr.on('data', (chunk) => (error += chunk));
      const status = await new Promise<number | null>((resolve) => child.on('exit', resolve));
      assert.equal(status, 0, error);
      assert.deepEqual(JSON.parse(output), { own: true, other: false, link: false, network: false });
    } finally {
      await new Promise<void>((resolve) => listener.close(() => resolve()));
    }
  });
});

test('an isolated runtime crash is reported and the next request resumes its conversation', async () => {
  let pid = 0;
  const sandbox = processDriver({ isolated: true });
  const driver: RuntimeDriver = {
    async start(spec) {
      const handle = await sandbox.start(spec);
      pid = handle.pid!;
      return handle;
    },
  };
  await withManager(
    async (manager) => {
      const w = await manager.create('alice', { name: 'A' });
      const first = await manager.ask('alice', w.id, { text: 'ช่วยคิดชื่องานสัมมนาให้หน่อย' });
      assert.equal(first.status, 'review');
      const oldPid = pid;
      process.kill(oldPid, 'SIGKILL');
      for (let i = 0; i < 100 && (await manager.get('alice', w.id)).state !== 'failed'; i++)
        await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal((await manager.get('alice', w.id)).state, 'failed');
      const next = await manager.ask('alice', w.id, { text: 'ขออีกสามชื่อ', sessionId: first.sessionId });
      assert.equal(next.status, 'review');
      assert.equal(next.sessionId, first.sessionId);
      assert.notEqual(pid, oldPid);
    },
    { driver, grant: () => ({ baseUrl: 'http://127.0.0.1:1/v1', model: 'synthetic' }) },
  );
});
