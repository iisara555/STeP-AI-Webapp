import { provisionTestQuota } from './support/quota.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { promisify } from 'node:util';
import { createGateway } from '../src/gateway/http.ts';
import { RunService, DEFAULT_QUOTAS } from '../src/gateway/runs.ts';
import { RuntimeManager } from '../src/workspace/manager.ts';

const exec = promisify(execFile);

test('another process cannot bypass a gateway workspace quota via RuntimeManager', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'step-workspace-cross-process-'));
  const manager = new RuntimeManager({
    workspacesPerUser: 1,
    dataRoot: provisionTestQuota(dir, 1),
    driver: {
      start: async () => {
        throw new Error('unused');
      },
    },
  });
  const audit = () => {};
  const quotas = { ...DEFAULT_QUOTAS, workspacesPerUser: 1 };
  const server = createGateway({
    manager,
    runs: new RunService(manager, audit),
    audit,
    quotas,
    authenticate: async () => ({ userId: 'alice', email: 'alice@step.example', admin: false }),
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(
      `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/workspaces`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'first' }),
      },
    );
    assert.equal(response.status, 200);
    const script = `
      import { RuntimeManager } from './server/src/workspace/manager.ts';
      const manager = new RuntimeManager({ workspacesPerUser: 1, dataRoot: process.argv[1], driver: { start: async () => { throw Error('unused'); } } });
      try { await manager.create('alice', { name: 'second' }); console.log('CREATED'); }
      catch (error) { console.log(error.code ?? error.message); }
    `;
    const { stdout } = await exec(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '-e', script, dir],
      { cwd: process.cwd() },
    );
    assert.equal(stdout.trim(), 'QUOTA_WORKSPACES');
    assert.equal((await manager.list('alice')).length, 1);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});
