// #62: exactly one live RuntimeManager writes a storage root, across processes. The fence is a kernel-held lock, so a
// dead holder never blocks a successor, a live holder is never overtaken, and runtime children never inherit it.
import { provisionTestQuota } from './support/quota.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readdir, readFile, readlink, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RuntimeManager } from '../src/workspace/manager.ts';

const FENCE = 'workspace-writer.fence';
const unusedDriver = {
  start: async () => {
    throw new Error('unused');
  },
};
const manager = (dataRoot: string, workspacesPerUser = 2) =>
  new RuntimeManager({ dataRoot, workspacesPerUser, driver: unusedDriver });

/** A RuntimeManager in another process. With `child`, it also spawns a long-lived runtime-like child process. */
function holder(dataRoot: string, child = false) {
  const script = `
    import { spawn } from 'node:child_process';
    import { RuntimeManager } from './server/src/workspace/manager.ts';
    try {
      new RuntimeManager({ dataRoot: process.argv[1], workspacesPerUser: 2, driver: { start: async () => { throw Error('unused'); } } });
    } catch (error) { console.log('REFUSED ' + error.message); process.exit(3); }
    if (process.argv[2] === 'child') {
      const runtime = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', detached: true });
      runtime.unref();
      console.log('CHILD ' + runtime.pid);
    }
    console.log('HELD');
    setInterval(() => {}, 1000);
  `;
  const proc = spawn(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '-e', script, dataRoot, ...(child ? ['child'] : [])],
    { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'inherit'] },
  );
  let out = '';
  const lines = new Promise<string>((resolve, reject) => {
    proc.stdout!.on('data', (chunk) => {
      out += chunk;
      if (/^(HELD|REFUSED .*)$/m.test(out)) resolve(out);
    });
    proc.once('exit', (code) => resolve(out || `EXIT ${code}`));
    proc.once('error', reject);
  });
  return { proc, lines };
}

const exited = (proc: ChildProcess) =>
  proc.exitCode !== null || proc.signalCode !== null
    ? Promise.resolve()
    : new Promise<void>((resolve) => proc.once('exit', () => resolve()));

async function root(prefix: string) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  return provisionTestQuota(dir, 2);
}

test('a live manager in another process blocks a second manager; startup fails closed', async () => {
  const dir = await root('step-writer-fence-live-');
  const first = holder(dir);
  try {
    assert.match(await first.lines, /^HELD$/m);
    assert.throws(() => manager(dir), /WORKSPACE_WRITER_FENCE_HELD/);
    const second = holder(dir);
    assert.match(await second.lines, /^REFUSED WORKSPACE_WRITER_FENCE_HELD$/m);
    await exited(second.proc);
    assert.equal(second.proc.exitCode, 3);
    // The refused attempt did not disturb the live holder.
    assert.equal(first.proc.exitCode, null);
    assert.throws(() => manager(dir), /WORKSPACE_WRITER_FENCE_HELD/);
  } finally {
    first.proc.kill('SIGKILL');
    await exited(first.proc);
    await rm(dir, { recursive: true, force: true });
  }
});

test('SIGKILL of the holder lets a successor acquire; runtime children never inherit the fence', async () => {
  const dir = await root('step-writer-fence-kill-');
  const first = holder(dir, true);
  let runtimePid: number | undefined;
  try {
    const out = await first.lines;
    assert.match(out, /^HELD$/m);
    runtimePid = Number(/^CHILD (\d+)$/m.exec(out)![1]);
    const fds = await readdir(`/proc/${runtimePid}/fd`);
    const targets = await Promise.all(
      fds.map((fd) => readlink(`/proc/${runtimePid}/fd/${fd}`).catch(() => '')),
    );
    assert.ok(!targets.some((target) => target.includes(FENCE)), `runtime child inherited: ${targets}`);
    const holderFds = await readdir(`/proc/${first.proc.pid}/fd`);
    const holderTargets = await Promise.all(
      holderFds.map((fd) => readlink(`/proc/${first.proc.pid}/fd/${fd}`).catch(() => '')),
    );
    assert.ok(
      holderTargets.some((target) => target.endsWith(`/${FENCE}`)),
      'holder keeps the fence open',
    );
    assert.throws(() => manager(dir), /WORKSPACE_WRITER_FENCE_HELD/);
    // Kernel evidence: a POSIX record lock on the fence inode, owned by the holder and not by its runtime child.
    const ino = (await stat(join(dir, FENCE))).ino;
    const locks = async (pid: number) =>
      (await readFile('/proc/locks', 'utf8'))
        .split('\n')
        .filter((line) => /\bPOSIX\b/.test(line) && line.split(/\s+/)[4] === String(pid))
        .filter((line) => line.split(/\s+/)[5]?.endsWith(`:${ino}`));
    assert.ok(
      (await locks(first.proc.pid!)).some((line) => /\bWRITE\b/.test(line)),
      'holder owns a POSIX write lock on the fence',
    );
    assert.deepEqual(await locks(runtimePid), []);

    first.proc.kill('SIGKILL');
    await exited(first.proc);
    assert.deepEqual(await locks(first.proc.pid!), [], 'the kernel released the dead holder lock');
    // The orphaned runtime child is still alive, yet the kernel released the dead holder's lock.
    process.kill(runtimePid, 0);
    const successor = manager(dir);
    await successor.create('alice', { name: 'after crash' });
    await successor.shutdown();
  } finally {
    first.proc.kill('SIGKILL');
    await exited(first.proc);
    if (runtimePid) process.kill(runtimePid, 'SIGKILL');
    await rm(dir, { recursive: true, force: true });
  }
});

test('a second manager in the same process is refused while the first is live', async () => {
  const dir = await root('step-writer-fence-local-');
  try {
    const first = manager(dir);
    assert.throws(() => manager(dir), /WORKSPACE_WRITER_FENCE_HELD/);
    // The refused in-process attempt must not have dropped the kernel lock (POSIX close semantics).
    const other = holder(dir);
    assert.match(await other.lines, /^REFUSED WORKSPACE_WRITER_FENCE_HELD$/m);
    await exited(other.proc);
    await first.create('alice', { name: 'still writable' });
    await first.shutdown();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('shutdown releases the fence and the old manager refuses further writes', async () => {
  const dir = await root('step-writer-fence-shutdown-');
  try {
    const first = manager(dir);
    const ws = await first.create('alice', { name: 'one' });
    await first.shutdown();
    await assert.rejects(() => first.create('alice', { name: 'two' }), /RUNTIME_MANAGER_SHUTTING_DOWN/);
    await assert.rejects(() => first.start('alice', ws.id), /RUNTIME_MANAGER_SHUTTING_DOWN/);
    const other = holder(dir);
    assert.match(await other.lines, /^HELD$/m);
    other.proc.kill('SIGKILL');
    await exited(other.proc);
    const third = manager(dir);
    assert.equal((await third.list('alice')).length, 1);
    await third.shutdown();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a failed quota check does not leave the fence held', async () => {
  const dir = await root('step-writer-fence-policy-');
  try {
    assert.throws(() => manager(dir, 3), /QUOTA_POLICY_MISMATCH/);
    const ok = manager(dir);
    await ok.shutdown();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a substituted fence path fails closed', async () => {
  const dir = await root('step-writer-fence-symlink-');
  const elsewhere = await mkdtemp(join(tmpdir(), 'step-writer-fence-target-'));
  try {
    await symlink(join(elsewhere, FENCE), join(dir, FENCE));
    assert.throws(() => manager(dir), /WORKSPACE_WRITER_FENCE_UNSAFE/);
    assert.deepEqual(await readdir(elsewhere), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(elsewhere, { recursive: true, force: true });
  }
});
