import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import {
  validateDiskQuotaRequest,
  initializeDiskQuotaLedger,
  DiskQuotaLedger,
  DiskQuotaAuthority,
} from '../src/workspace/disk-provisioning.ts';

const policy = {
  mountUuid: '6b52590c-aed0-4f2e-bcb1-204a09a49304',
  firstProjectId: 100000,
  lastProjectId: 100001,
};

test('authority reserves unique permanent IDs before provisioning and pins quota policy', () => {
  const db = new DatabaseSync(':memory:');
  try {
    assert.throws(() => new DiskQuotaLedger(db, policy), /DISK_QUOTA_LEDGER_REQUIRED/);
    initializeDiskQuotaLedger(db, policy);
    const ledger = new DiskQuotaLedger(db, policy);
    const first = ledger.reserve({ ownerId: 'alice', workspaceId, bytesHard: 1048576, inodesHard: 32 });
    assert.equal(first.projectId, 100000);
    assert.deepEqual(ledger.reserve(first), first);
    assert.throws(() => ledger.reserve({ ...first, bytesHard: 2097152 }), /DISK_QUOTA_POLICY_MISMATCH/);
    const second = ledger.reserve({ ...first, ownerId: 'bob' });
    assert.equal(second.projectId, 100001);
    assert.throws(() => ledger.reserve({ ...first, ownerId: 'carol' }), /DISK_QUOTA_CAPACITY/);
    assert.throws(
      () => new DiskQuotaLedger(db, { ...policy, lastProjectId: 100002 }),
      /DISK_QUOTA_POLICY_MISMATCH/,
    );
    assert.throws(() => initializeDiskQuotaLedger(db, policy), /DISK_QUOTA_LEDGER_EXISTS/);
    const restarted = new DiskQuotaLedger(db, policy);
    assert.deepEqual(restarted.reserve(first), first);
  } finally {
    db.close();
  }
});

const workspaceId = 'ws_0123456789abcdef0123456789abcdef';

test('broker retains failed reservations, verifies both limits afresh, and denies foreign subjects', async () => {
  const db = new DatabaseSync(':memory:');
  initializeDiskQuotaLedger(db, policy);
  const ledger = new DiskQuotaLedger(db, policy);
  let attempts = 0;
  let badEvidence = true;
  const seen: number[] = [];
  const authority = new DiskQuotaAuthority({
    ledger,
    authorize: async (subject, request) => {
      assert.equal(request.workspaceId, workspaceId);
      if (subject !== 'authenticated-alice') throw Error('DENIED');
      return { ownerId: 'alice', bytesHard: 1048576, inodesHard: 32 };
    },
    provisionAndVerify: async (allocation) => {
      attempts++;
      seen.push(allocation.projectId);
      if (attempts === 1) throw Error('synthetic interrupted provisioning');
      return { ...allocation, inodesHard: badEvidence ? 0 : 32, projectInherit: true, quotaEnforced: true };
    },
  });
  try {
    await assert.rejects(authority.ensure('foreign', { workspaceId }), /DENIED/);
    assert.equal(attempts, 0);
    await assert.rejects(authority.ensure('authenticated-alice', { workspaceId }), /interrupted/);
    await assert.rejects(authority.ensure('authenticated-alice', { workspaceId }), /DISK_QUOTA_UNVERIFIED/);
    badEvidence = false;
    assert.equal((await authority.ensure('authenticated-alice', { workspaceId })).projectId, 100000);
    assert.equal((await authority.ensure('authenticated-alice', { workspaceId })).projectId, 100000);
    assert.deepEqual(seen, [100000, 100000, 100000, 100000]);
    assert.equal(
      ledger.reserve({ ownerId: 'bob', workspaceId, bytesHard: 1048576, inodesHard: 32 }).projectId,
      100001,
    );
  } finally {
    db.close();
  }
});

test(
  'separate authority processes share durable non-reusable allocation and restart state',
  { timeout: 20000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'disk-ledger-'));
    const file = join(root, 'ledger.sqlite');
    const db = new DatabaseSync(file);
    const largerPolicy = { ...policy, lastProjectId: 100003 };
    initializeDiskQuotaLedger(db, largerPolicy);
    db.close();
    const moduleUrl = new URL('../src/workspace/disk-provisioning.ts', import.meta.url).href;
    const script = `
    import { DatabaseSync } from 'node:sqlite';
    import { DiskQuotaLedger } from ${JSON.stringify(moduleUrl)};
    const [file, owner] = process.argv.slice(1);
    const db = new DatabaseSync(file);
    const ledger = new DiskQuotaLedger(db, ${JSON.stringify(largerPolicy)});
    const result = ledger.reserve({ ownerId: owner, workspaceId: '${workspaceId}', bytesHard: 1048576, inodesHard: 32 });
    console.log(result.projectId);
    db.close();
  `;
    const reserve = (owner: string) =>
      new Promise<number>((resolve, reject) => {
        const child = spawn(
          process.execPath,
          ['--import', 'tsx', '--input-type=module', '-e', script, file, owner],
          { stdio: ['ignore', 'pipe', 'pipe'] },
        );
        let output = '';
        let errors = '';
        child.stdout.on('data', (chunk) => {
          output += chunk;
        });
        child.stderr.on('data', (chunk) => {
          errors += chunk;
        });
        child.once('error', reject);
        child.once('exit', (code) => (code === 0 ? resolve(Number(output.trim())) : reject(Error(errors))));
      });
    try {
      const results = await Promise.all(['alice', 'alice', 'bob', 'carol', 'dave'].map(reserve));
      assert.equal(results[0], results[1]);
      assert.deepEqual([...new Set(results)].sort(), [100000, 100001, 100002, 100003]);
      assert.equal(await reserve('alice'), results[0]);
      await assert.rejects(reserve('eve'), /DISK_QUOTA_CAPACITY/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test('broker rechecks policy after provisioning and never releases a reservation on revocation', async () => {
  const db = new DatabaseSync(':memory:');
  initializeDiskQuotaLedger(db, policy);
  const ledger = new DiskQuotaLedger(db, policy);
  let authorized = true;
  const authority = new DiskQuotaAuthority({
    ledger,
    authorize: async () => {
      if (!authorized) throw Error('REVOKED');
      return { ownerId: 'alice', bytesHard: 1048576, inodesHard: 32 };
    },
    provisionAndVerify: async (allocation) => {
      authorized = false;
      return { ...allocation, projectInherit: true, quotaEnforced: true };
    },
  });
  try {
    await assert.rejects(authority.ensure('trusted-subject', { workspaceId }), /REVOKED/);
    assert.equal(
      ledger.reserve({ ownerId: 'bob', workspaceId, bytesHard: 1048576, inodesHard: 32 }).projectId,
      100001,
    );
  } finally {
    db.close();
  }
});

test('retired shell helper refuses every operation without touching quota', () => {
  const helper = new URL('../../spikes/057-workspace-quota/step-workspace-quota', import.meta.url);
  for (const args of [
    [],
    ['set', 'alice', workspaceId, '100000', '1', '32'],
    ['clear', 'alice', workspaceId, '100000'],
    ['report', '100000'],
  ]) {
    const result = spawnSync('/bin/bash', [helper.pathname, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /DISABLED_UNSAFE_QUOTA_HELPER/);
    assert.equal(result.stdout, '');
  }
});

test('storage request accepts only a workspace identity, never caller-selected authority', () => {
  assert.deepEqual(validateDiskQuotaRequest({ workspaceId }), { workspaceId });
  for (const request of [
    null,
    [],
    { workspaceId: '../escape' },
    { workspaceId, projectId: 100001 },
    { workspaceId, ownerId: 'other' },
    { workspaceId, path: '/etc' },
    { workspaceId, mount: '/mnt/other' },
    { workspaceId, bytesHard: 1 },
    { workspaceId, operation: 'clear' },
  ]) {
    assert.throws(() => validateDiskQuotaRequest(request), /DISK_QUOTA_INVALID_REQUEST/);
  }
});
