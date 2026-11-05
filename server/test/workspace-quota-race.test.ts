import { provisionTestQuota } from './support/quota.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createGateway } from '../src/gateway/http.ts';
import { RunService, DEFAULT_QUOTAS } from '../src/gateway/runs.ts';
import { RuntimeManager } from '../src/workspace/manager.ts';

test('concurrent workspace requests cannot exceed the per-user limit', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'step-workspace-quota-'));
  const manager = new RuntimeManager({
    workspacesPerUser: 1,
    dataRoot: provisionTestQuota(dir, 1),
    driver: {
      start: async () => {
        throw new Error('unused');
      },
    },
  });
  const original = manager.create.bind(manager);
  let arrived = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  manager.create = async (...args) => {
    if (++arrived === 2) release();
    await gate;
    return original(...args);
  };
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
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/workspaces`;
    const request = () =>
      fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'synthetic' }),
      });
    const responses = await Promise.all([request(), request()]);
    assert.deepEqual(responses.map((response) => response.status).sort(), [200, 429]);
    assert.equal((await manager.list('alice')).length, 1);
  } finally {
    release();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});
