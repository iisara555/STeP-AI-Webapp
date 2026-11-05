import { provisionTestQuota } from './support/quota.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeSync, openSync } from 'node:fs';
import { RuntimeManager } from '../src/workspace/manager.ts';

// File-backed child output avoids restricted-host stdio pipe failures.
async function execute(command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv }) {
  const logs = await mkdtemp(join(tmpdir(), 'quota-child-'));
  const output = join(logs, 'output');
  const fd = openSync(output, 'wx', 0o600);
  const stderrPath = join(logs, 'stderr');
  const stderrFd = openSync(stderrPath, 'wx', 0o600);
  try {
    const child = spawn(command, args, { ...options, stdio: ['ignore', fd, stderrFd] });
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', resolve);
    });
    const stdout = await readFile(output, 'utf8');
    const stderr = await readFile(stderrPath, 'utf8');
    if (code !== 0) throw Object.assign(new Error(`child exited ${code}: ${stderr}`), { code, stderr });
    return { stdout };
  } finally {
    closeSync(fd);
    closeSync(stderrFd);
    await rm(logs, { recursive: true, force: true });
  }
}

const driver = {
  start: async () => {
    throw new Error('unused');
  },
};

test('gateway refuses to start without an explicit workspace quota', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'step-quota-config-'));
  try {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      STEP_DATA_ROOT: dataRoot,
      STEP_INVITES_FILE: join(dataRoot, 'invites'),
      STEP_ALLOWED_DOMAINS: 'example.org',
    };
    delete env.STEP_QUOTA_WORKSPACES;
    await assert.rejects(
      execute(process.execPath, ['--import', 'tsx', 'server/src/gateway/main.ts'], {
        cwd: process.cwd(),
        env,
      }),
      (error: any) => error.code === 2 && String(error.stderr).includes('STEP_QUOTA_WORKSPACES'),
    );
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test('simultaneous processes share one workspace limit', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'step-quota-processes-'));
  try {
    new RuntimeManager({ dataRoot: provisionTestQuota(dataRoot, 1), driver, workspacesPerUser: 1 });
    const script = `
      import { RuntimeManager } from './server/src/workspace/manager.ts';
      const manager = new RuntimeManager({ dataRoot: process.argv[1], workspacesPerUser: 1, driver: {start: async () => {throw Error('unused')}} });
      try { await manager.create('alice', {name:'test'}); console.log('CREATED'); }
      catch (error) { console.log(error.message); }
    `;
    const createInChild = () =>
      execute(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, dataRoot], {
        cwd: process.cwd(),
      });
    const results = await Promise.all([createInChild(), createInChild()]);
    assert.deepEqual(results.map((result) => result.stdout.trim()).sort(), ['CREATED', 'QUOTA_WORKSPACES']);
    const manager = new RuntimeManager({
      dataRoot,
      driver,
      workspacesPerUser: 1,
    });
    assert.equal((await manager.list('alice')).length, 1);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test('a crash immediately after rename still consumes quota', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'step-quota-crash-'));
  try {
    provisionTestQuota(dataRoot, 1);
    const script = `
      import { RuntimeManager } from './server/src/workspace/manager.ts';
      const manager = new RuntimeManager({ dataRoot: process.argv[1], workspacesPerUser: 1, driver: {start: async () => {throw Error('unused')}} });
      await manager.create('alice', {name:'first'}, publish => { publish(); process.exit(19); });
    `;
    await assert.rejects(
      execute(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, dataRoot], {
        cwd: process.cwd(),
      }),
      (error: any) => error.code === 19,
    );
    const manager = new RuntimeManager({
      dataRoot,
      driver,
      workspacesPerUser: 1,
    });
    assert.equal((await manager.list('alice')).length, 1);
    await assert.rejects(manager.create('alice', { name: 'second' }), /QUOTA_WORKSPACES/);
    await rm(join(dataRoot, 'workspace-quota.sqlite'));
    assert.throws(
      () => new RuntimeManager({ dataRoot, driver, workspacesPerUser: 1 }),
      /QUOTA_POLICY_REQUIRED/,
    );
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});
