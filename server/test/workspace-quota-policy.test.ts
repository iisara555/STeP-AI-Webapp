import { provisionTestQuota } from './support/quota.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, rename, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RuntimeManager } from '../src/workspace/manager.ts';
import { DatabaseSync } from 'node:sqlite';
import { createGateway } from '../src/gateway/http.ts';
import { DEFAULT_QUOTAS, RunService } from '../src/gateway/runs.ts';

const driver = {
  start: async () => {
    throw new Error('unused');
  },
};

test('managers sharing a root reject missing or conflicting workspace quota policies', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'step-quota-policy-'));
  try {
    new RuntimeManager({ dataRoot: provisionTestQuota(dataRoot, 1), driver, workspacesPerUser: 1 });
    assert.throws(
      () => new RuntimeManager({ dataRoot, driver, workspacesPerUser: 2 }),
      /QUOTA_POLICY_MISMATCH/,
    );
    assert.throws(() => new RuntimeManager({ dataRoot, driver } as never), /QUOTA_POLICY_REQUIRED/);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test('gateway refuses a quota different from its manager policy', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'step-quota-gateway-mismatch-'));
  try {
    const manager = new RuntimeManager({
      dataRoot: provisionTestQuota(dataRoot, 1),
      driver,
      workspacesPerUser: 1,
    });
    const audit = () => {};
    assert.throws(
      () =>
        createGateway({
          manager,
          runs: new RunService(manager, audit),
          authenticate: async () => null,
          audit,
          quotas: DEFAULT_QUOTAS,
        }),
      /QUOTA_POLICY_MISMATCH/,
    );
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test('missing policy in an existing store fails closed', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'step-quota-missing-'));
  try {
    new RuntimeManager({ dataRoot: provisionTestQuota(dataRoot, 1), driver, workspacesPerUser: 1 });
    const db = new DatabaseSync(join(dataRoot, 'workspace-quota.sqlite'));
    db.exec('DELETE FROM policy');
    db.close();
    assert.throws(
      () => new RuntimeManager({ dataRoot, driver, workspacesPerUser: 1 }),
      /QUOTA_POLICY_REQUIRED/,
    );
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test('workspace symlinks cannot bypass the quota', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'step-quota-symlink-'));
  try {
    const manager = new RuntimeManager({
      dataRoot: provisionTestQuota(dataRoot, 1),
      driver,
      workspacesPerUser: 1,
    });
    const first = await manager.create('alice', { name: 'first' });
    const path = join(dataRoot, 'users', 'alice', 'workspaces', first.id);
    const moved = join(dataRoot, 'moved');
    await rename(path, moved);
    await symlink(moved, path);
    assert.equal((await manager.list('alice')).length, 1);
    await assert.rejects(manager.create('alice', { name: 'second' }), /QUOTA_WORKSPACES/);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test('publication cannot be deferred until after the quota lock is released', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'step-quota-deferred-'));
  try {
    const manager = new RuntimeManager({
      dataRoot: provisionTestQuota(dataRoot, 1),
      driver,
      workspacesPerUser: 1,
    });
    let deferred!: () => void;
    await assert.rejects(
      manager.create('alice', { name: 'first' }, (publish) => {
        deferred = publish;
      }),
      /PUBLICATION_NOT_SYNCHRONOUS/,
    );
    assert.throws(() => deferred(), /PUBLICATION_NOT_SYNCHRONOUS/);
    assert.equal((await manager.list('alice')).length, 0);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});
