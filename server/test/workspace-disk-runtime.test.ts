import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RuntimeManager } from '../src/workspace/manager.ts';
import type { RuntimeDriver, RuntimeHandle } from '../src/workspace/contract.ts';
import { withDiskQuota } from '../src/workspace/disk-provisioning.ts';
import { workspacePaths } from '../src/workspace/storage.ts';
import { provisionTestQuota } from './support/quota.ts';

const limits = { mountUuid: '6b52590c-aed0-4f2e-bcb1-204a09a49304', bytesHard: 1048576, inodesHard: 32 };

test('real manager cannot start or resume until disk and inode provisioning is freshly verified', async () => {
  const root = await mkdtemp(join(tmpdir(), 'disk-runtime-'));
  let spawns = 0;
  let verifies = 0;
  let ready = false;
  let id = '';
  const handle = { stop: async () => {}, onExit: () => {} } as unknown as RuntimeHandle;
  const driver: RuntimeDriver = {
    start: async () => {
      spawns++;
      return handle;
    },
    startWithAdmission: async (_spec, admit) => {
      admit(() => {
        spawns++;
      });
      return handle;
    },
  };
  try {
    const manager = new RuntimeManager({
      dataRoot: provisionTestQuota(root, 2),
      workspacesPerUser: 2,
      driver: withDiskQuota(driver, {
        dataRoot: root,
        ...limits,
        provision: async (request) => {
          verifies++;
          assert.deepEqual(request, { workspaceId: id });
          if (!ready) throw Error('DISK_QUOTA_BROKER_UNAVAILABLE');
          return {
            ...limits,
            workspaceId: id,
            ownerId: 'alice',
            projectId: 100000,
            projectInherit: true,
            quotaEnforced: true,
          };
        },
      }),
    });
    id = (await manager.create('alice', { name: 'synthetic disk gate' })).id;
    await assert.rejects(
      manager.start('alice', id, (spawn) => spawn()),
      /DISK_QUOTA_BROKER_UNAVAILABLE/,
    );
    assert.equal(spawns, 0);
    ready = true;
    assert.equal((await manager.start('alice', id, (spawn) => spawn())).state, 'running');
    assert.equal(spawns, 1);
    await manager.stop('alice', id);
    ready = false;
    await assert.rejects(
      manager.start('alice', id, (spawn) => spawn()),
      /DISK_QUOTA_BROKER_UNAVAILABLE/,
    );
    assert.equal(spawns, 1);
    assert.equal(verifies, 3);
    await manager.shutdown();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('revocation during asynchronous provisioning still fences the actual spawn', async () => {
  let allowed = true;
  let spawns = 0;
  let admitted = 0;
  const workspaceId = 'ws_0123456789abcdef0123456789abcdef';
  const spec = workspacePaths('/synthetic-data', 'alice', workspaceId);
  const driver = withDiskQuota(
    {
      start: async () => {
        throw Error('must use admission');
      },
      startWithAdmission: async (_spec, admit) => {
        admit(() => {
          spawns++;
        });
        throw Error('must not reach readiness');
      },
    },
    {
      dataRoot: '/synthetic-data',
      ...limits,
      provision: async () => {
        allowed = false;
        return {
          ...limits,
          workspaceId,
          ownerId: 'alice',
          projectId: 100000,
          projectInherit: true,
          quotaEnforced: true,
        };
      },
    },
  );
  await assert.rejects(
    driver.startWithAdmission!(spec, (spawn) => {
      admitted++;
      if (!allowed) throw Error('REVOKED');
      spawn();
    }),
    /REVOKED/,
  );
  assert.equal(admitted, 1);
  assert.equal(spawns, 0);
});

test('runtime seam snapshots caller-owned paths before awaiting the broker', async () => {
  const workspaceId = 'ws_0123456789abcdef0123456789abcdef';
  const spec = workspacePaths('/synthetic-data', 'alice', workspaceId);
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  let spawnedDir: string | undefined;
  const driver = withDiskQuota(
    {
      start: async (actual) => {
        spawnedDir = actual.dir;
        throw Error('synthetic spawn reached');
      },
    },
    {
      dataRoot: '/synthetic-data',
      ...limits,
      provision: async () => {
        await wait;
        return {
          ...limits,
          workspaceId,
          ownerId: 'alice',
          projectId: 100000,
          projectInherit: true,
          quotaEnforced: true,
        };
      },
    },
  );
  const starting = driver.start(spec);
  spec.dir = '/etc';
  release();
  await assert.rejects(starting, /synthetic spawn reached/);
  assert.equal(spawnedDir, `/synthetic-data/users/alice/workspaces/${workspaceId}`);
});

test('runtime seam rejects alternate paths and unverified, foreign or weaker evidence before spawn', async () => {
  let spawns = 0;
  const workspaceId = 'ws_0123456789abcdef0123456789abcdef';
  const spec = workspacePaths('/synthetic-data', 'alice', workspaceId);
  const valid = {
    ...limits,
    workspaceId,
    ownerId: 'alice',
    projectId: 100000,
    projectInherit: true,
    quotaEnforced: true,
  };
  let evidence: unknown = valid;
  const driver = withDiskQuota(
    {
      start: async () => {
        spawns++;
        throw Error('test spawn');
      },
    },
    {
      dataRoot: '/synthetic-data',
      ...limits,
      provision: async () => evidence,
    },
  );
  assert.equal(driver.startWithAdmission, undefined, 'must not invent synchronous admission support');
  await assert.rejects(driver.start({ ...spec, dir: '/etc' }), /DISK_QUOTA_UNSAFE_SPEC/);
  for (evidence of [
    null,
    {},
    { ...valid, ownerId: 'bob' },
    { ...valid, bytesHard: 4096 },
    { ...valid, inodesHard: 0 },
    { ...valid, projectInherit: false },
    { ...valid, quotaEnforced: false },
    { ...valid, mountUuid: '00000000-0000-4000-8000-000000000000' },
  ]) {
    await assert.rejects(driver.start(spec), /DISK_QUOTA_UNVERIFIED/);
  }
  assert.equal(spawns, 0);
});
