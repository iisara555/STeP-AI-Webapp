import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { brokerQuotaExpectations } from '../src/workspace/native-quota-expectations.ts';
import { brokerQuotaBoundary, nativeWorkspaceUuid } from '../src/workspace/native-quota.ts';
import type { BrokerWorkspaceReceipt } from '../src/workspace/native-quota-socket.ts';
import type { RuntimeDriver } from '../src/workspace/contract.ts';
import { stat } from 'node:fs/promises';

const user = 'a11ce000-0000-4000-8000-000000000001';
const mount = '6b52590c-aed0-4f2e-bcb1-204a09a49304';
const epoch = '00112233445566778899aabbccddeeff';
const uid = process.getuid!();
const gid = process.getgid!();
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'expectations-'));
  await chmod(root, 0o700);
  const policy = `version=2\nepoch=${epoch}\nmount_uuid=${mount}\nroot_device=1\nroot_inode=2\nbytes_hard=4096\ninodes_hard=10\nreserve_bytes=0\nfirst_project=100000\nlast_project=199999\ngateway_uid=${uid}\ngateway_gid=${gid}\nworkload_uid=${uid}\n`;
  await writeFile(join(root, 'policy'), policy, { mode: 0o600 });
  const document = {
    version: 1,
    epoch,
    mountUuid: mount,
    rootDevice: '1',
    rootInode: '2',
    users: [{ userUuid: user, projectId: 100000, bytesHard: 8192, inodesHard: 20 }],
  };
  const save = () => writeFile(join(root, 'expectations'), JSON.stringify(document), { mode: 0o600 });
  await save();
  const source = brokerQuotaExpectations({
    mode: 'synthetic-only',
    trustRoot: root,
    policyPath: 'policy',
    expectationsPath: 'expectations',
  });
  return { root, source, document, save, policy };
}

test('protected per-user expectations accept an explicit raised grant and reread changes', async () => {
  const f = await fixture();
  try {
    assert.deepEqual((await f.source.read(user)).grant, {
      userUuid: user,
      projectId: 100000,
      bytesHard: 8192,
      inodesHard: 20,
    });
    f.document.users[0]!.bytesHard = 12288;
    await f.save();
    assert.equal((await f.source.read(user)).grant.bytesHard, 12288);
    await assert.rejects(f.source.read('b0b00000-0000-4000-8000-000000000002'));
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

async function boundaryFixture() {
  const f = await fixture();
  const projectRoot = join(f.root, 'pools');
  const workspace = nativeWorkspaceUuid('ws_aaaaaaaa000040008000000000000001');
  const userDir = join(projectRoot, 'p100000');
  const dir = join(userDir, workspace);
  await mkdir(join(dir, 'files'), { recursive: true });
  await mkdir(join(dir, 'snapshots'));
  await chmod(userDir, 0o750);
  await chmod(dir, 0o2750);
  const rootStat = await stat(projectRoot, { bigint: true });
  f.document.rootDevice = String(rootStat.dev);
  f.document.rootInode = String(rootStat.ino);
  await f.save();
  await writeFile(
    join(f.root, 'policy'),
    f.policy
      .replace('root_device=1', `root_device=${rootStat.dev}`)
      .replace('root_inode=2', `root_inode=${rootStat.ino}`),
  );
  const s = await stat(dir, { bigint: true });
  const u = await stat(userDir, { bigint: true });
  const receipt: BrokerWorkspaceReceipt = {
    userUuid: user,
    workspaceUuid: workspace,
    projectId: 100000,
    device: String(s.dev),
    userInode: String(u.ino),
    inode: String(s.ino),
    bytesHard: 8192,
    inodesHard: 20,
    mountUuid: mount,
  };
  let duringReply: (() => Promise<void>) | undefined;
  const client = {
    async ensureWorkspace() {
      await duringReply?.();
      return { ...receipt };
    },
    async usage() {
      await duringReply?.();
      return {
        projectId: receipt.projectId,
        bytesHard: receipt.bytesHard,
        inodesHard: receipt.inodesHard,
        bytesUsed: 0,
        inodesUsed: 0,
      };
    },
  };
  const driver: RuntimeDriver = {
    async start() {
      throw Error('unused');
    },
    async startWithAdmission() {
      throw Error('unused');
    },
    async startPinnedWithAdmission() {
      throw Error('unused');
    },
  };
  const options = {
    mode: 'broker' as const,
    dataRoot: join(f.root, 'metadata'),
    projectRoot,
    client,
    mountUuid: mount,
    bytesHard: 4096,
    inodesHard: 10,
    firstProjectId: 100000,
    lastProjectId: 199999,
    brokerUid: uid,
    gatewayGid: gid,
    workloadUid: uid,
    userUuidFor: () => user,
    expectations: f.source,
  };
  const record = {
    id: 'ws_aaaaaaaa000040008000000000000001',
    ownerId: 'alice',
    name: 'A',
    createdAt: '',
    lastActiveAt: '',
  };
  return {
    ...f,
    receipt,
    options,
    driver,
    record,
    boundary: brokerQuotaBoundary(options, driver),
    duringReply: (fn: typeof duringReply) => {
      duringReply = fn;
    },
  };
}

test('broker boundary accepts only the exact protected raised user grant for paths and usage', async () => {
  const f = await boundaryFixture();
  try {
    assert.equal((await f.boundary.storage.runtimePaths(f.record)).ownerId, 'alice');
    assert.equal((await f.boundary.usage('alice')).bytesHard, 8192);
    f.receipt.bytesHard = 12288;
    await assert.rejects(f.boundary.storage.runtimePaths(f.record), /NATIVE_QUOTA_UNVERIFIED/);
    await assert.rejects(f.boundary.usage('alice'), /NATIVE_QUOTA_UNVERIFIED/);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('broker boundary refuses stale, cross-user, wrong-project and non-exact per-user receipts', async () => {
  const f = await boundaryFixture();
  try {
    const original = { ...f.receipt };
    for (const change of [
      { bytesHard: 4096 },
      { bytesHard: 12288 },
      { inodesHard: 10 },
      { inodesHard: 21 },
      { projectId: 100001 },
      { userUuid: 'b0b00000-0000-4000-8000-000000000002' },
      { mountUuid: '00000000-0000-0000-0000-000000000001' },
      { workspaceUuid: 'bbbbbbbb-0000-4000-8000-000000000001' },
    ]) {
      Object.assign(f.receipt, original, change);
      await assert.rejects(f.boundary.storage.runtimePaths(f.record), /NATIVE_QUOTA_UNVERIFIED/);
    }
    Object.assign(f.receipt, original);
    // No metadata source means default-only, never elevated receipt >= default.
    const withoutSource = brokerQuotaBoundary({ ...f.options, expectations: undefined }, f.driver);
    await assert.rejects(withoutSource.storage.runtimePaths(f.record), /NATIVE_QUOTA_UNVERIFIED/);
    assert.throws(
      () => brokerQuotaBoundary({ ...f.options, expectations: { read: f.source.read } }, f.driver),
      /NATIVE_QUOTA_EXPECTATIONS_UNSAFE/,
    );
    f.document.users = [];
    await f.save();
    await assert.rejects(f.boundary.storage.runtimePaths(f.record));
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('operator policy change during a broker response invalidates the in-flight claim', async () => {
  const f = await boundaryFixture();
  try {
    f.duringReply(async () => {
      f.document.users[0]!.bytesHard = 12288;
      await f.save();
    });
    await assert.rejects(f.boundary.storage.runtimePaths(f.record), /NATIVE_QUOTA_UNVERIFIED/);
    f.document.users[0]!.bytesHard = 8192;
    await f.save();
    await assert.rejects(f.boundary.usage('alice'), /NATIVE_QUOTA_UNVERIFIED/);
    f.duringReply(undefined);
    // The old receipt remains invalid on the NEXT request too: no cached per-user claims.
    await assert.rejects(f.boundary.storage.runtimePaths(f.record), /NATIVE_QUOTA_UNVERIFIED/);
    f.receipt.bytesHard = 12288;
    assert.equal((await f.boundary.usage('alice')).bytesHard, 12288);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('metadata refuses tampering, low grants, duplicate users/projects and installation drift', async () => {
  const f = await fixture();
  try {
    const valid = JSON.stringify(f.document);
    const mutations = [
      { ...f.document, epoch: 'f'.repeat(32) },
      { ...f.document, mountUuid: '00000000-0000-0000-0000-000000000001' },
      { ...f.document, rootDevice: '3' },
      { ...f.document, rootInode: '3' },
      { ...f.document, extra: true },
      { ...f.document, users: [{ ...f.document.users[0], bytesHard: 0 }] },
      { ...f.document, users: [{ ...f.document.users[0], bytesHard: 4097 }] },
      { ...f.document, users: [{ ...f.document.users[0], inodesHard: 9 }] },
      { ...f.document, users: [{ ...f.document.users[0], inodesHard: 10000001 }] },
      { ...f.document, users: [f.document.users[0], f.document.users[0]] },
      {
        ...f.document,
        users: [
          f.document.users[0],
          { ...f.document.users[0], userUuid: 'b0b00000-0000-4000-8000-000000000002' },
        ],
      },
    ];
    for (const mutation of mutations) {
      await writeFile(join(f.root, 'expectations'), JSON.stringify(mutation));
      await assert.rejects(f.source.read(user));
    }
    await writeFile(join(f.root, 'expectations'), valid);
    await chmod(join(f.root, 'expectations'), 0o666);
    await assert.rejects(f.source.read(user), /UNSAFE/);
    await chmod(join(f.root, 'expectations'), 0o600);
    await chmod(f.root, 0o777);
    await assert.rejects(f.source.read(user), /UNSAFE/);
    await chmod(f.root, 0o700);
    const protectedSource = brokerQuotaExpectations({
      mode: 'protected',
      policyPath: join(f.root, 'policy').slice(1),
      expectationsPath: join(f.root, 'expectations').slice(1),
    });
    await assert.rejects(protectedSource.read(user), /UNSAFE/);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('protected reader rejects symlink components, hardlinks and changed service policy', async () => {
  const { symlink, link, unlink } = await import('node:fs/promises');
  const f = await fixture();
  try {
    await writeFile(join(f.root, 'copy'), JSON.stringify(f.document), { mode: 0o600 });
    await unlink(join(f.root, 'expectations'));
    await symlink('copy', join(f.root, 'expectations'));
    await assert.rejects(f.source.read(user));
    await unlink(join(f.root, 'expectations'));
    await link(join(f.root, 'copy'), join(f.root, 'expectations'));
    await assert.rejects(f.source.read(user), /UNSAFE/);
    await unlink(join(f.root, 'expectations'));
    await f.save();
    await mkdir(join(f.root, 'directory'));
    await symlink('directory', join(f.root, 'alias'));
    const viaAlias = brokerQuotaExpectations({
      mode: 'synthetic-only',
      trustRoot: f.root,
      policyPath: 'policy',
      expectationsPath: 'alias/file',
    });
    await assert.rejects(viaAlias.read(user));
    f.document.users[0]!.bytesHard = 4096;
    await f.save();
    await writeFile(join(f.root, 'policy'), f.policy.replace('bytes_hard=4096', 'bytes_hard=8192'));
    await assert.rejects(f.source.read(user), /UNVERIFIED/);
    await writeFile(join(f.root, 'policy'), f.policy);
    await chmod(join(f.root, 'policy'), 0o666);
    await assert.rejects(f.source.read(user), /UNSAFE/);
    assert.throws(
      () =>
        brokerQuotaExpectations({
          mode: 'protected',
          trustRoot: f.root,
          policyPath: 'policy',
          expectationsPath: 'expectations',
        }),
      /UNSAFE/,
    );
    assert.throws(
      () =>
        brokerQuotaExpectations({
          mode: 'synthetic-only',
          trustRoot: f.root,
          policyPath: '../policy',
          expectationsPath: 'expectations',
        }),
      /UNSAFE/,
    );
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
