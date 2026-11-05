import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { RuntimeManager } from '../src/workspace/manager.ts';

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
      promisify(execFile)(process.execPath, ['--import', 'tsx', 'server/src/gateway/main.ts'], {
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
    new RuntimeManager({ dataRoot, driver, workspacesPerUser: 1 });
    const script = `
      import { RuntimeManager } from './server/src/workspace/manager.ts';
      const manager = new RuntimeManager({ dataRoot: process.argv[1], workspacesPerUser: 1, driver: {start: async () => {throw Error('unused')}} });
      try { await manager.create('alice', {name:'test'}); console.log('CREATED'); }
      catch (error) { console.log(error.message); }
    `;
    const execute = () =>
      promisify(execFile)(
        process.execPath,
        ['--import', 'tsx', '--input-type=module', '-e', script, dataRoot],
        { cwd: process.cwd() },
      );
    const results = await Promise.all([execute(), execute()]);
    assert.deepEqual(results.map((result) => result.stdout.trim()).sort(), ['CREATED', 'QUOTA_WORKSPACES']);
    const manager = new RuntimeManager({ dataRoot, driver, workspacesPerUser: 1 });
    assert.equal((await manager.list('alice')).length, 1);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test('a crash immediately after rename still consumes quota', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'step-quota-crash-'));
  try {
    const script = `
      import { RuntimeManager } from './server/src/workspace/manager.ts';
      const manager = new RuntimeManager({ dataRoot: process.argv[1], workspacesPerUser: 1, driver: {start: async () => {throw Error('unused')}} });
      await manager.create('alice', {name:'first'}, publish => { publish(); process.exit(19); });
    `;
    await assert.rejects(
      promisify(execFile)(
        process.execPath,
        ['--import', 'tsx', '--input-type=module', '-e', script, dataRoot],
        { cwd: process.cwd() },
      ),
      (error: any) => error.code === 19,
    );
    const manager = new RuntimeManager({ dataRoot, driver, workspacesPerUser: 1 });
    assert.equal((await manager.list('alice')).length, 1);
    await assert.rejects(manager.create('alice', { name: 'second' }), /QUOTA_WORKSPACES/);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});
