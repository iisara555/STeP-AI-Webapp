// Gateway <-> real broker process (FAKE quota adapter build) over a real Unix socket, unprivileged.
// The broker binary is built from native/quota-broker (make step-quota-broker-fake); no root, no XFS.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import {
  chmodSync,
  closeSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RuntimeManager } from '../src/workspace/manager.ts';
import type { RuntimeDriver, RuntimeHandle, RuntimeSpec } from '../src/workspace/contract.ts';
import { brokerQuotaBoundary, nativeWorkspaceUuid } from '../src/workspace/native-quota.ts';
import {
  brokerClient,
  parseBrokerPolicy,
  readBrokerPolicy,
  usageLevel,
} from '../src/workspace/native-quota-socket.ts';
import { provisionTestQuota } from './support/quota.ts';

const native = fileURLToPath(new URL('../../native/quota-broker/', import.meta.url));
const binary = join(native, 'step-quota-broker-fake');
const MOUNT_UUID = '6b52590c-aed0-4f2e-bcb1-204a09a49304';
const USERS = { alice: 'a11ce000-0000-4000-8000-000000000001', bob: 'b0b00000-0000-4000-8000-000000000002' };
// Placeholder per-user pool: 15 GiB / 750000 inodes (owner chooses real values at install).
const BYTES = 16106127360;
const INODES = 750000;
const uid = process.getuid!();
const gid = process.getgid!();

type Broker = {
  base: string;
  socket: string;
  projectRoot: string;
  policyPath: string;
  stop(): Promise<void>;
};
const brokers: Broker[] = [];

function policyText(base: string) {
  const root = statSync(join(base, 'broker/root'), { bigint: true });
  return [
    '# test policy',
    'version=2',
    'epoch=00112233445566778899aabbccddeeff',
    `mount_uuid=${MOUNT_UUID}`,
    `root_device=${root.dev}`,
    `root_inode=${root.ino}`,
    `bytes_hard=${BYTES}`,
    `inodes_hard=${INODES}`,
    'first_project=100000',
    'last_project=100009',
    `gateway_uid=${uid}`,
    `gateway_gid=${gid}`,
    `workload_uid=${uid}`,
    'reserve_bytes=0',
    '',
  ].join('\n');
}
function args(command: string, base: string) {
  return [command, '--trust-root', base, '--policy-dir', '/policy', '--broker-dir', '/broker'];
}
function run(base: string, command: string, socketDir = '/run0', values: string[] = []) {
  return execFileSync(
    binary,
    [command, ...values, ...args(command, base).slice(1), '--socket-dir', socketDir, '--fake-dir', '/fake'],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
}
async function serve(base: string, socketDir: string): Promise<ChildProcess> {
  mkdirSync(join(base, socketDir), { mode: 0o700 });
  const child = spawn(binary, [...args('--serve', base), '--socket-dir', socketDir, '--fake-dir', '/fake'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let err = '';
  child.stderr!.on('data', (d) => (err += d));
  await new Promise<void>((resolve, reject) => {
    let out = '';
    child.stdout!.on('data', (d) => {
      out += d;
      if (out.includes('READY')) resolve();
    });
    child.on('exit', (code) => reject(Error(`broker exited ${code}: ${err}`)));
  });
  return child;
}
async function startBroker(): Promise<Broker> {
  const base = await mkdtemp(join(tmpdir(), 'qb-ts-'));
  for (const [dir, mode] of [
    ['policy', 0o755],
    ['broker', 0o755],
    ['broker/root', 0o710],
    ['broker/state', 0o700],
    ['fake', 0o700],
  ] as const) {
    mkdirSync(join(base, dir));
    chmodSync(join(base, dir), mode);
  }
  const policyPath = join(base, 'policy/policy');
  writeFileSync(policyPath, policyText(base), { mode: 0o644 });
  chmodSync(policyPath, 0o644);
  // Deterministic free-space seam: tests must not depend on host disk capacity.
  writeFileSync(join(base, 'fake/available'), '1099511627776\n');
  run(base, '--bootstrap');
  for (const user of Object.values(USERS)) run(base, '--add-user', '/run0', [user]);
  let child = await serve(base, '/run1');
  const broker: Broker = {
    base,
    socket: join(base, 'run1/broker.sock'),
    projectRoot: join(base, 'broker/root'),
    policyPath,
    async stop() {
      if (child.exitCode === null) {
        const exited = new Promise((resolve) => child.once('exit', resolve));
        child.kill('SIGTERM');
        await exited;
      }
    },
  };
  brokers.push(broker);
  return broker;
}

before(() => {
  // Build the FAKE-adapter test broker (idempotent). Never the production binary, never root.
  execFileSync('make', ['-s', '-C', native, 'step-quota-broker-fake'], { stdio: 'ignore' });
});
after(async () => {
  for (const b of brokers) {
    await b.stop();
    await rm(b.base, { recursive: true, force: true });
  }
});

function fakeDriver() {
  const bound: { spec: RuntimeSpec; inode: string }[] = [];
  const handle = { stop: async () => {}, onExit: () => {} } as unknown as RuntimeHandle;
  let atSpawn: (() => void) | undefined;
  const driver: RuntimeDriver = {
    start: async () => {
      throw Error('unfenced launch');
    },
    startWithAdmission: async () => {
      throw Error('path launch');
    },
    startPinnedWithAdmission: async (spec, pin, admit) => {
      admit(() => {
        atSpawn?.();
        const fd = pin();
        try {
          bound.push({ spec, inode: String(fstatSync(fd, { bigint: true }).ino) });
        } finally {
          closeSync(fd);
        }
      });
      return handle;
    },
  };
  return { driver, bound, setAtSpawn: (fn: typeof atSpawn) => (atSpawn = fn) };
}
async function composition(broker: Broker, driver: RuntimeDriver, mapping: Record<string, string> = USERS) {
  const root = await mkdtemp(join(tmpdir(), 'qb-meta-'));
  const dataRoot = provisionTestQuota(join(root, 'metadata'), 4);
  const policy = await readBrokerPolicy(broker.policyPath, uid);
  const boundary = brokerQuotaBoundary(
    {
      mode: 'broker',
      dataRoot,
      projectRoot: broker.projectRoot,
      client: brokerClient({ socketPath: broker.socket }),
      mountUuid: policy.mountUuid,
      bytesHard: policy.bytesHard,
      inodesHard: policy.inodesHard,
      firstProjectId: policy.firstProjectId,
      lastProjectId: policy.lastProjectId,
      brokerUid: uid, // root in production; the fake broker runs as the test user
      gatewayGid: policy.gatewayGid,
      workloadUid: policy.workloadUid,
      userUuidFor: (owner) => {
        const mapped = mapping[owner];
        if (!mapped) throw Error('NATIVE_QUOTA_NO_USER_POOL');
        return mapped;
      },
    },
    driver,
  );
  const manager = new RuntimeManager({ dataRoot, workspacesPerUser: 4, ...boundary });
  return {
    dataRoot,
    manager,
    boundary,
    close: async () => {
      await manager.shutdown();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test('socket client: per-user pool receipts, denial and usage against a real broker process', async () => {
  const broker = await startBroker();
  const client = brokerClient({ socketPath: broker.socket });
  // Usage never allocates.
  await assert.rejects(client.usage(USERS.alice), /NATIVE_QUOTA_DENIED/);
  const a = await client.ensureWorkspace(USERS.alice, 'aaaaaaaa-0000-4000-8000-000000000001');
  const b = await client.ensureWorkspace(USERS.alice, 'bbbbbbbb-0000-4000-8000-000000000002');
  const c = await client.ensureWorkspace(USERS.bob, 'aaaaaaaa-0000-4000-8000-000000000001');
  assert.equal(a.projectId, 100000);
  assert.equal(b.projectId, 100000, 'one project per user, shared by every workspace');
  assert.equal(c.projectId, 100001);
  assert.equal(a.userInode, b.userInode);
  assert.notEqual(a.inode, b.inode);
  assert.deepEqual([a.bytesHard, a.inodesHard, a.mountUuid], [BYTES, INODES, MOUNT_UUID]);
  const dir = lstatSync(join(broker.projectRoot, 'p100000', 'aaaaaaaa-0000-4000-8000-000000000001'), {
    bigint: true,
  });
  assert.equal(String(dir.ino), a.inode);
  assert.equal(String(dir.dev), a.device);
  assert.equal(Number(dir.mode & 0o7777n), 0o2750);
  assert.equal(Number(lstatSync(join(broker.projectRoot, 'p100000')).mode & 0o7777), 0o750);
  await assert.rejects(
    client.ensureWorkspace('deadbeef-0000-4000-8000-000000000000', 'aaaaaaaa-0000-4000-8000-000000000001'),
    /NATIVE_QUOTA_DENIED/,
  );
  await assert.rejects(client.ensureWorkspace('../../etc', 'x'), /Invalid|invalid/);
  // Usage levels for the UI: 80 % warning, 95 % critical, at the limit full; the worse ratio decides.
  const usage = async (bytes: number, inodes: number) => {
    await writeFile(join(broker.base, 'fake/u100000'), `${bytes} ${inodes}\n`);
    return client.usage(USERS.alice);
  };
  assert.deepEqual(await usage(0, 0), {
    projectId: 100000,
    bytesUsed: 0,
    bytesHard: BYTES,
    inodesUsed: 0,
    inodesHard: INODES,
  });
  assert.equal(usageLevel(await usage(Math.floor(BYTES * 0.79), 10)).level, 'ok');
  assert.equal(usageLevel(await usage(Math.ceil(BYTES * 0.8), 10)).level, 'warning');
  assert.equal(usageLevel(await usage(10, Math.ceil(INODES * 0.95))).level, 'critical');
  const full = usageLevel(await usage(BYTES, 10));
  assert.equal(full.level, 'full');
  assert.equal(full.bytesPercent, 100);
  // Bob's usage is his own pool.
  assert.equal((await client.usage(USERS.bob)).bytesUsed, 0);
});

test('socket client is bounded and exact: malformed, oversize, partial, silent and absent peers fail', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qb-peer-'));
  try {
    const ws = (path: string) =>
      brokerClient({ socketPath: path, timeoutMs: 300 }).ensureWorkspace(USERS.alice, USERS.bob);
    let seen = '';
    const ok = `OK/3 100000 66 7 8 ${BYTES} ${INODES} ${MOUNT_UUID}\n`;
    await assert.rejects(ws(join(dir, 'absent')), /NATIVE_QUOTA_BROKER_UNAVAILABLE/);
    for (const [reply, code] of [
      [ok.replace('\n', ''), 'MALFORMED'], // partial: no final newline
      [ok + 'x', 'MALFORMED'],
      [ok.replace('OK/3 100000', 'OK/3 0100000'), 'MALFORMED'],
      [ok.replace(' 66 ', ' 99999999999999999999 '), 'MALFORMED'], // > u64
      ['OK/2 100000 66 7 8 9 ' + MOUNT_UUID + '\n', 'MALFORMED'], // wrong reply kind
      ['X'.repeat(300), 'MALFORMED'],
      ['DENIED/1\n', 'DENIED'],
      ['', 'MALFORMED'],
    ] as const) {
      await assert.rejects(
        (async () => {
          const path = join(dir, `p${Math.random().toString(36).slice(2)}`);
          const server = net.createServer({ allowHalfOpen: true }, (socket) => {
            socket.on('data', (d) => (seen = String(d)));
            socket.on('end', () => socket.end(reply));
          });
          await new Promise<void>((r) => server.listen(path, r));
          try {
            await ws(path);
          } finally {
            server.close();
          }
        })(),
        new RegExp(code),
      );
    }
    assert.equal(seen, `WORKSPACE/1 ${USERS.alice} ${USERS.bob}\n`, 'exact 86-byte frame, then EOF');
    assert.equal(Buffer.byteLength(seen), 86);
    // A peer that never answers is cut off by the deadline.
    const path = join(dir, 'silent');
    const server = net.createServer({ allowHalfOpen: true }, () => {});
    await new Promise<void>((r) => server.listen(path, r));
    try {
      await assert.rejects(ws(path), /NATIVE_QUOTA_BROKER_TIMEOUT/);
    } finally {
      server.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('policy reader mirrors the native parser and refuses unsafe files', async () => {
  const broker = await startBroker();
  const policy = await readBrokerPolicy(broker.policyPath, uid);
  assert.deepEqual(
    [policy.bytesHard, policy.inodesHard, policy.reserveBytes, policy.workloadUid, policy.gatewayGid],
    [BYTES, INODES, 0, uid, gid],
  );
  await assert.rejects(readBrokerPolicy(broker.policyPath, uid + 1), /POLICY_UNSAFE/);
  const text = policyText(broker.base);
  for (const bad of [
    text + 'colour=blue\n',
    text.replace('version=2', 'version=1'),
    text.replace(`bytes_hard=${BYTES}`, 'bytes_hard=4097'),
    text.replace('first_project=100000', 'first_project=424242'),
    text + `user=${USERS.alice}\n`,
    text.replace('version=2\n', 'version=2\nversion=2\n'),
    text.slice(0, -1),
  ])
    assert.throws(() => parseBrokerPolicy(bad), /POLICY_INVALID/);
  const copy = join(broker.base, 'policy-copy');
  writeFileSync(copy, text, { mode: 0o664 });
  chmodSync(copy, 0o664);
  await assert.rejects(readBrokerPolicy(copy, uid), /POLICY_UNSAFE/);
});

test('end to end: gateway manager -> broker -> pinned start in the user pool workspace directory', async () => {
  const broker = await startBroker();
  const d = fakeDriver();
  const f = await composition(broker, d.driver);
  try {
    const one = await f.manager.create('alice', { name: 'first' });
    const two = await f.manager.create('alice', { name: 'second' });
    const other = await f.manager.create('bob', { name: 'bob' });
    assert.deepEqual(await readdir(join(f.dataRoot, 'users/alice/workspaces', one.id)), ['workspace.json']);
    assert.deepEqual((await readdir(join(broker.projectRoot))).sort(), ['p100000', 'p100001']);
    assert.deepEqual(
      (await readdir(join(broker.projectRoot, 'p100000'))).sort(),
      [nativeWorkspaceUuid(one.id), nativeWorkspaceUuid(two.id)].sort(),
    );
    assert.equal((await f.manager.start('alice', one.id, (spawn) => spawn())).state, 'running');
    const dir = join(broker.projectRoot, 'p100000', nativeWorkspaceUuid(one.id));
    assert.deepEqual(d.bound[0]!.spec, {
      ownerId: 'alice',
      workspaceId: one.id,
      dir,
      filesDir: join(dir, 'files'),
    });
    assert.equal(
      d.bound[0]!.inode,
      String(lstatSync(dir, { bigint: true }).ino),
      'pinned the workspace dir only',
    );
    await f.manager.start('bob', other.id, (spawn) => spawn());
    assert.equal(d.bound[1]!.spec.dir, join(broker.projectRoot, 'p100001', nativeWorkspaceUuid(other.id)));
    // A stopped workspace's conversation index is readable from the broker workspace directory.
    await f.manager.stop('alice', one.id);
    await writeFile(
      join(dir, 'conversations.json'),
      JSON.stringify([{ id: 's1', title: 't', status: 'review' }]),
    );
    assert.deepEqual(await f.manager.conversations('alice', one.id), [
      { id: 's1', title: 't', status: 'review' },
    ]);
    // Usage is per user.
    await writeFile(join(broker.base, 'fake/u100000'), `${Math.ceil(BYTES * 0.96)} 5\n`);
    const usage = await f.boundary.usage('alice');
    assert.equal(usage.level, 'critical');
    assert.equal((await f.boundary.usage('bob')).level, 'ok');
    // Rename + substitute after verification: the pin refuses, nothing is launched.
    d.setAtSpawn(() => {
      renameSync(dir, dir + '.moved');
      mkdirSync(dir, { mode: 0o2750 });
    });
    await assert.rejects(
      f.manager.start('alice', one.id, (spawn) => spawn()),
      /NATIVE_QUOTA_UNVERIFIED|RUNTIME/,
    );
    assert.equal(d.bound.length, 2);
    d.setAtSpawn(undefined);
  } finally {
    await f.close();
  }
});

test('end to end fails closed: unmapped user, unknown user, changed boundary, broker down', async () => {
  const broker = await startBroker();
  const d = fakeDriver();
  const f = await composition(broker, d.driver, { ...USERS, carol: 'c0000000-0000-4000-8000-000000000003' });
  try {
    await assert.rejects(f.manager.create('dave', { name: 'unmapped' }), /NATIVE_QUOTA_NO_USER_POOL/);
    await assert.rejects(f.manager.create('carol', { name: 'not in policy' }), /NATIVE_QUOTA_DENIED/);
    assert.deepEqual(await f.manager.list('dave'), []);
    assert.deepEqual(await f.manager.list('carol'), []);
    const ws = await f.manager.create('alice', { name: 'w' });
    const dir = join(broker.projectRoot, 'p100000', nativeWorkspaceUuid(ws.id));
    chmodSync(dir, 0o2770); // the broker denies; never repaired
    await assert.rejects(
      f.manager.start('alice', ws.id, (spawn) => spawn()),
      /NATIVE_QUOTA_DENIED/,
    );
    chmodSync(dir, 0o2750);
    await broker.stop();
    await assert.rejects(
      f.manager.start('alice', ws.id, (spawn) => spawn()),
      /NATIVE_QUOTA_BROKER_UNAVAILABLE/,
    );
    await assert.rejects(f.boundary.usage('alice'), /NATIVE_QUOTA_BROKER_UNAVAILABLE/);
    assert.equal(d.bound.length, 0);
  } finally {
    await f.close();
  }
});

test('broker mode is explicit and the production gateway stays refused', async () => {
  const d = fakeDriver();
  assert.throws(
    () => brokerQuotaBoundary({ mode: 'synthetic-only' } as never, d.driver),
    /NATIVE_QUOTA_PRODUCTION_UNAVAILABLE/,
  );
  const main = await import('node:fs/promises').then((fs) =>
    fs.readFile(fileURLToPath(new URL('../src/gateway/main.ts', import.meta.url)), 'utf8'),
  );
  assert.match(main, /^refuseUnsafeGateway\(\);$/m);
  assert.doesNotMatch(main, /brokerQuotaBoundary|native-quota/);
});
