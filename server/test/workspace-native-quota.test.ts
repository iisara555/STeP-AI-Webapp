import assert from 'node:assert/strict';
import { test } from 'node:test';
import { closeSync, fstatSync, lstatSync, mkdirSync, renameSync } from 'node:fs';
import { mkdtemp, mkdir, lstat, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RuntimeManager } from '../src/workspace/manager.ts';
import {
  WorkspaceError,
  type RuntimeDriver,
  type RuntimeHandle,
  type RuntimeSpec,
} from '../src/workspace/contract.ts';
import {
  nativeQuotaBoundary,
  nativeWorkspaceUuid,
  type NativeQuotaOptions,
} from '../src/workspace/native-quota.ts';
import { provisionTestQuota } from './support/quota.ts';

const limits = { mountUuid: '6b52590c-aed0-4f2e-bcb1-204a09a49304', bytesHard: 1048576, inodesHard: 32 };
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function fixture(count = 2) {
  const root = await mkdtemp(join(tmpdir(), 'native-integration-'));
  const dataRoot = provisionTestQuota(join(root, 'metadata'), count);
  const projectRoot = join(root, 'native');
  await mkdir(projectRoot);
  const requests: string[] = [];
  const specs: RuntimeSpec[] = [];
  const allocations = new Map<string, number>();
  const exits: ((code: number | null, error?: WorkspaceError) => void)[] = [];
  let mutate: (value: Record<string, unknown>) => unknown = (value) => value;
  let wait: (() => Promise<void>) | undefined;
  let cleanupFails = false;
  let stops = 0;
  // What the fake launch actually bound: the inode a path bind resolves at spawn, or the pinned descriptor's inode.
  const bound: string[] = [];
  let beforeLaunch: (() => void) | undefined;
  let atSpawn: (() => void) | undefined;
  const handle = {
    stop: async () => {
      stops++;
      if (cleanupFails) throw new WorkspaceError('RUNTIME_CLEANUP_FAILED');
    },
    onExit: (listener) => {
      exits.push(listener);
    },
  } as RuntimeHandle;
  const driver: RuntimeDriver = {
    start: async () => {
      throw Error('unfenced launch');
    },
    startWithAdmission: async (spec, admit) => {
      beforeLaunch?.();
      admit(() => {
        atSpawn?.();
        bound.push(String(lstatSync(spec.dir, { bigint: true }).ino));
        specs.push(spec);
      });
      return handle;
    },
    startPinnedWithAdmission: async (spec, pin, admit) => {
      beforeLaunch?.();
      admit(() => {
        const fd = pin();
        try {
          atSpawn?.();
          bound.push(String(fstatSync(fd, { bigint: true }).ino));
          specs.push(spec);
        } finally {
          closeSync(fd);
        }
      });
      return handle;
    },
  };
  const options: NativeQuotaOptions = {
    mode: 'synthetic-only',
    dataRoot,
    projectRoot,
    ...limits,
    firstProjectId: 100000,
    lastProjectId: 100099,
    forOwner: (ownerId) => {
      assert.equal(ownerId, 'alice');
      return {
        ensure: async (frame) => {
          requests.push(frame);
          assert.match(frame, /^ENSURE\/1 [0-9a-f-]{36}\n$/);
          assert.equal(Buffer.byteLength(frame), 46);
          const workspaceUuid = frame.slice(9, 45);
          if (!allocations.has(workspaceUuid)) allocations.set(workspaceUuid, 100037 + allocations.size);
          const projectId = allocations.get(workspaceUuid)!;
          const dir = join(projectRoot, `p${projectId}`);
          await mkdir(dir, { recursive: true }); // FAKE native, not adapter; no XFS/privilege.
          const stat = await lstat(dir, { bigint: true });
          await wait?.();
          return mutate({
            workspaceUuid,
            ...limits,
            projectId,
            device: String(stat.dev),
            inode: String(stat.ino),
            projectInherit: true,
            quotaEnforced: true,
          });
        },
      };
    },
  };
  const composition = nativeQuotaBoundary(options, driver);
  const manager = new RuntimeManager({ dataRoot, workspacesPerUser: count, ...composition });
  return {
    root,
    dataRoot,
    projectRoot,
    requests,
    specs,
    allocations,
    exits,
    manager,
    options,
    driver,
    setEvidence: (fn: typeof mutate) => {
      mutate = fn;
    },
    setWait: (fn: typeof wait) => {
      wait = fn;
    },
    bound,
    setBeforeLaunch: (fn: typeof beforeLaunch) => {
      beforeLaunch = fn;
    },
    setAtSpawn: (fn: typeof atSpawn) => {
      atSpawn = fn;
    },
    failCleanup: (fail: boolean) => {
      cleanupFails = fail;
    },
    get stops() {
      return stops;
    },
    close: async () => {
      cleanupFails = false;
      await manager.shutdown();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test('native alone allocates project roots; manager publishes control metadata and starts/resumes in p<ID>', async () => {
  const f = await fixture();
  try {
    const workspace = await f.manager.create('alice', { name: 'single authority' });
    assert.equal(f.requests.length, 1);
    assert.deepEqual(await readdir(join(f.dataRoot, 'users/alice/workspaces', workspace.id)), [
      'workspace.json',
    ]);
    assert.equal((await f.manager.start('alice', workspace.id, (spawn) => spawn())).state, 'running');
    assert.deepEqual(f.specs, [
      {
        ownerId: 'alice',
        workspaceId: workspace.id,
        dir: join(f.projectRoot, 'p100037'),
        filesDir: join(f.projectRoot, 'p100037/files'),
      },
    ]);
    await f.manager.stop('alice', workspace.id);
    await f.manager.start('alice', workspace.id, (spawn) => spawn());
    assert.equal(f.requests.length, 3, 'resume freshly verifies');
    assert.deepEqual(await readdir(f.projectRoot), ['p100037']);
    assert.deepEqual((await readdir(f.dataRoot)).sort(), [
      '.workspace-quota-established',
      'users',
      'workspace-quota.sqlite',
      'workspace-writer.fence',
    ]);
    assert.equal((await f.manager.list('alice')).length, 1);
    assert.equal((await f.manager.list('bob')).length, 0);
    await assert.rejects(
      f.manager.start('bob', workspace.id, (spawn) => spawn()),
      /WORKSPACE_NOT_FOUND/,
    );
    assert.equal(f.requests.length, 3, 'foreign lookup never contacts a native peer');
    await f.manager.stop('alice', workspace.id);
    await writeFile(
      join(f.projectRoot, 'p100037/conversations.json'),
      JSON.stringify([{ id: 'native-session', title: 'persisted', status: 'review' }]),
    );
    assert.deepEqual(await f.manager.conversations('alice', workspace.id), [
      { id: 'native-session', title: 'persisted', status: 'review' },
    ]);
    // One live writer per data root (#62): the resuming manager replaces the first one.
    await f.manager.shutdown();
    const resumed = new RuntimeManager({
      dataRoot: f.dataRoot,
      workspacesPerUser: 2,
      ...nativeQuotaBoundary(f.options, f.driver),
    });
    try {
      await resumed.start('alice', workspace.id, (spawn) => spawn());
      assert.equal(f.allocations.size, 1);
    } finally {
      await resumed.shutdown();
    }
  } finally {
    await f.close();
  }
});

test('native protected grant denial cannot auto-register a generated workspace or publish metadata', async () => {
  const f = await fixture();
  let calls = 0;
  const options = {
    ...f.options,
    forOwner: () => ({
      ensure: async (_frame: string) => {
        calls++;
        throw Error('NATIVE_GRANT_DENIED');
      },
    }),
  };
  await f.manager.shutdown();
  const manager = new RuntimeManager({
    dataRoot: f.dataRoot,
    workspacesPerUser: 2,
    ...nativeQuotaBoundary(options, f.driver),
  });
  try {
    await assert.rejects(manager.create('alice', { name: 'unregistered UUID' }), /NATIVE_GRANT_DENIED/);
    assert.equal(calls, 1);
    assert.deepEqual(await manager.list('alice'), []);
    assert.deepEqual(await readdir(f.projectRoot), []);
    assert.equal(f.specs.length, 0);
  } finally {
    await manager.shutdown();
    await f.close();
  }
});

test('workspace identity is validated before lossless conversion, never normalized or repaired', () => {
  assert.equal(
    nativeWorkspaceUuid('ws_0123456789abcdef0123456789abcdef'),
    '01234567-89ab-cdef-0123-456789abcdef',
  );
  for (const id of [
    'ws_0123456789ABCDEF0123456789ABCDEF',
    '01234567-89ab-cdef-0123-456789abcdef',
    '../alice',
    'ws_0123456789abcdef0123456789abcdef\n',
  ])
    assert.throws(() => nativeWorkspaceUuid(id));
});

test('strict matching evidence rejects malformed/foreign/weaker identities without publication or launch', async () => {
  const f = await fixture();
  try {
    const invalid: unknown[] = [
      null,
      {},
      { projectId: 100099.5 },
      { projectId: 100100 },
      { projectId: 99999 },
      { workspaceUuid: '00000000-0000-0000-0000-000000000000' },
      { mountUuid: '00000000-0000-0000-0000-000000000000' },
      { bytesHard: 4096 },
      { inodesHard: 31 },
      { projectInherit: false },
      { quotaEnforced: false },
      { device: '01' },
      { inode: '18446744073709551616' },
      { inode: '1' },
      { device: 1 },
      { ownerId: 'alice' },
      { directory: '/etc' },
      { operation: 'clear' },
    ];
    for (const patch of invalid) {
      f.setEvidence((value) =>
        patch === null ? null : Object.keys(patch as object).length ? { ...value, ...(patch as object) } : {},
      );
      await assert.rejects(
        f.manager.create('alice', { name: 'must not publish' }),
        /NATIVE_QUOTA_UNVERIFIED/,
      );
    }
    assert.deepEqual(await f.manager.list('alice'), []);
    assert.equal(f.specs.length, 0);
    assert.equal(f.allocations.size, invalid.length, 'failed attempts never recycle native reservations');
  } finally {
    await f.close();
  }
});

test('native absence or failure never causes TS to mkdir/adopt a project root', async () => {
  const f = await fixture();
  try {
    f.setEvidence(async (value) => {
      await rm(join(f.projectRoot, 'p100037'), { recursive: true });
      return value;
    });
    await assert.rejects(f.manager.create('alice', { name: 'missing native root' }), /ENOENT/);
    assert.deepEqual(await readdir(f.projectRoot), []);
    f.setEvidence(() => {
      throw Error('BROKER_UNAVAILABLE');
    });
    await assert.rejects(f.manager.create('alice', { name: 'offline broker' }), /BROKER_UNAVAILABLE/);
    assert.deepEqual(await f.manager.list('alice'), []);
  } finally {
    await f.close();
  }
});

test('symlink child fails closed and never writes through the alias', async () => {
  const f = await fixture();
  try {
    const outside = join(f.root, 'outside');
    await mkdir(outside);
    f.setEvidence(async (value) => {
      await symlink(outside, join(f.projectRoot, 'p100037/files'));
      return value;
    });
    await assert.rejects(f.manager.create('alice', { name: 'unsafe files' }), /NATIVE_QUOTA_UNSAFE_PATH/);
    assert.deepEqual(await readdir(outside), []);
    assert.deepEqual(await f.manager.list('alice'), []);
  } finally {
    await f.close();
  }
});

test('revocation during native create preparation prevents synchronous metadata publication', async () => {
  const f = await fixture();
  try {
    let allowed = true;
    f.setWait(async () => {
      allowed = false;
    });
    await assert.rejects(
      f.manager.create('alice', { name: 'revoked' }, (publish) => {
        if (!allowed) throw Error('REVOKED');
        publish();
      }),
      /REVOKED/,
    );
    assert.deepEqual(await f.manager.list('alice'), []);
    assert.equal(f.allocations.size, 1);
    assert.deepEqual(await readdir(f.projectRoot), ['p100037']);
  } finally {
    await f.close();
  }
});

test('concurrent creators retain count-quota admission without competing project allocation', async () => {
  const f = await fixture(1);
  try {
    const gate = deferred();
    const entered = deferred();
    let waiting = 0;
    f.setWait(async () => {
      if (++waiting === 2) entered.resolve();
      await gate.promise;
    });
    const creating = Promise.allSettled([
      f.manager.create('alice', { name: 'one' }),
      f.manager.create('alice', { name: 'two' }),
    ]);
    await entered.promise;
    assert.deepEqual(await f.manager.list('alice'), [], 'pending native roots are not visible workspaces');
    gate.resolve();
    const outcomes = await creating;
    assert.equal(outcomes.filter((o) => o.status === 'fulfilled').length, 1);
    assert.match(
      String((outcomes.find((o) => o.status === 'rejected') as PromiseRejectedResult).reason),
      /QUOTA_WORKSPACES/,
    );
    assert.equal((await f.manager.list('alice')).length, 1);
    assert.equal(f.allocations.size, 2, 'denied publication cannot undo native allocation');
    assert.deepEqual((await readdir(f.projectRoot)).sort(), ['p100037', 'p100038']);
  } finally {
    await f.close();
  }
});

test('start preparation is not admission: revocation at the deferred native reply fences the actual spawn', async () => {
  const f = await fixture();
  try {
    const w = await f.manager.create('alice', { name: 'race' });
    const gate = deferred();
    const entered = deferred();
    let allowed = true;
    f.setWait(async () => {
      entered.resolve();
      await gate.promise;
    });
    const starting = f.manager.start('alice', w.id, (spawn) => {
      if (!allowed) throw Error('REVOKED');
      spawn();
    });
    const rejected = assert.rejects(starting, /REVOKED/);
    await entered.promise;
    allowed = false;
    gate.resolve();
    await rejected;
    assert.equal(f.specs.length, 0);
    assert.equal((await f.manager.get('alice', w.id)).state, 'stopped');
    f.setWait(undefined);
    allowed = true;
    await f.manager.start('alice', w.id, (spawn) => spawn());
    assert.equal(f.specs.length, 1);
  } finally {
    await f.close();
  }
});

const substitute = (dir: string) => {
  renameSync(dir, `${dir}-moved`);
  mkdirSync(dir);
  mkdirSync(join(dir, 'files'));
};

test('a p<ID> renamed and substituted after verification, before spawn, is never launched into', async () => {
  const f = await fixture();
  try {
    const w = await f.manager.create('alice', { name: 'swap before spawn' });
    const dir = join(f.projectRoot, 'p100037');
    f.setBeforeLaunch(() => substitute(dir));
    await assert.rejects(
      f.manager.start('alice', w.id, (spawn) => spawn()),
      /NATIVE_QUOTA_UNVERIFIED/,
    );
    assert.deepEqual(f.bound, [], 'nothing launched into the substitute');
    assert.equal(f.specs.length, 0);
    // The pin fails inside the spawn callback, so the manager conservatively records a failed start.
    assert.equal((await f.manager.get('alice', w.id)).state, 'failed');
  } finally {
    await f.close();
  }
});

test('a substitution after the pin is taken cannot redirect the launch: the verified inode is bound', async () => {
  const f = await fixture();
  try {
    const w = await f.manager.create('alice', { name: 'swap at spawn' });
    const dir = join(f.projectRoot, 'p100037');
    const original = String((await lstat(dir, { bigint: true })).ino);
    f.setAtSpawn(() => substitute(dir));
    assert.equal((await f.manager.start('alice', w.id, (spawn) => spawn())).state, 'running');
    assert.notEqual(
      String((await lstat(dir, { bigint: true })).ino),
      original,
      'the path now names a substitute',
    );
    assert.deepEqual(f.bound, [original]);
  } finally {
    await f.close();
  }
});

test('native composition refuses a driver that can only bind by pathname', () => {
  const driver: RuntimeDriver = {
    start: async () => {
      throw Error('unfenced launch');
    },
    startWithAdmission: async () => {
      throw Error('path launch');
    },
  };
  const options = {
    mode: 'synthetic-only',
    dataRoot: '/tmp/native-meta-unused',
    projectRoot: '/tmp/native-root-unused',
    ...limits,
    firstProjectId: 100000,
    lastProjectId: 100099,
    forOwner: () => ({ ensure: async () => ({}) }),
  } satisfies NativeQuotaOptions;
  assert.throws(() => nativeQuotaBoundary(options, driver), /RUNTIME_PINNED_LAUNCH_UNSUPPORTED/);
});

test('shutdown during deferred native provisioning cannot launch after shutdown', async () => {
  const f = await fixture();
  try {
    const w = await f.manager.create('alice', { name: 'shutdown race' });
    const gate = deferred();
    const entered = deferred();
    f.setWait(async () => {
      entered.resolve();
      await gate.promise;
    });
    const starting = f.manager.start('alice', w.id, (spawn) => spawn());
    const rejected = assert.rejects(starting, /RUNTIME_MANAGER_SHUTTING_DOWN/);
    await entered.promise;
    const shutdown = f.manager.shutdown();
    gate.resolve();
    await rejected;
    await shutdown;
    assert.equal(f.specs.length, 0);
  } finally {
    await f.close();
  }
});

test('native composition retains manager cleanup handles and failed state; receipts cannot bypass admission', async () => {
  const f = await fixture();
  try {
    const w = await f.manager.create('alice', { name: 'lifecycle' });
    await assert.rejects(f.manager.start('alice', w.id), /RUNTIME_START_FAILED/);
    assert.equal(f.specs.length, 0);
    await f.manager.start('alice', w.id, (spawn) => spawn());
    f.failCleanup(true);
    f.exits.at(-1)!(0, new WorkspaceError('RUNTIME_CLEANUP_FAILED'));
    assert.equal((await f.manager.get('alice', w.id)).state, 'failed');
    await assert.rejects(
      f.manager.start('alice', w.id, (spawn) => spawn()),
      /RUNTIME_NOT_RUNNING/,
    );
    await assert.rejects(f.manager.shutdown(), /RUNTIME_CLEANUP_FAILED/);
    assert.equal(f.manager.stats().failed, 1);
    f.failCleanup(false);
    await f.manager.shutdown();
    assert.equal(f.manager.stats().failed, 0);
    assert.equal(f.stops, 2);
    assert.equal(f.specs.length, 1);
  } finally {
    await f.close();
  }
});

test('create/start race hides unpublished workspace and concurrent starts share one native verification and spawn', async () => {
  const f = await fixture();
  try {
    const gate = deferred();
    const entered = deferred();
    f.setWait(async () => {
      entered.resolve();
      await gate.promise;
    });
    const creating = f.manager.create('alice', { name: 'publication race' });
    await entered.promise;
    const id = `ws_${f.requests[0].slice(9, 45).replaceAll('-', '')}`;
    await assert.rejects(
      f.manager.start('alice', id, (spawn) => spawn()),
      /WORKSPACE_NOT_FOUND/,
    );
    assert.equal(f.specs.length, 0);
    gate.resolve();
    const w = await creating;
    f.setWait(undefined);
    const starts = await Promise.all([
      f.manager.start('alice', w.id, (spawn) => spawn()),
      f.manager.start('alice', w.id, (spawn) => spawn()),
    ]);
    assert.ok(starts.every((value) => value.state === 'running'));
    assert.equal(f.requests.length, 2);
    assert.equal(f.specs.length, 1);
  } finally {
    await f.close();
  }
});

test('exit during deferred provider grant cannot become running and retains required cleanup capacity', async () => {
  const f = await fixture();
  const entered = deferred();
  const gate = deferred();
  await f.manager.shutdown();
  const manager = new RuntimeManager({
    dataRoot: f.dataRoot,
    workspacesPerUser: 2,
    maxRunning: 1,
    ...nativeQuotaBoundary(f.options, f.driver),
    grant: async () => {
      entered.resolve();
      await gate.promise;
      return undefined;
    },
  });
  try {
    const w = await manager.create('alice', { name: 'failed start' });
    const next = await manager.create('alice', { name: 'capacity check' });
    const starting = manager.start('alice', w.id, (spawn) => spawn());
    const rejected = assert.rejects(starting, /RUNTIME_START_FAILED/);
    await entered.promise;
    f.failCleanup(true);
    f.exits.at(-1)!(0, new WorkspaceError('RUNTIME_CLEANUP_FAILED'));
    gate.resolve();
    await rejected;
    assert.equal((await manager.get('alice', w.id)).state, 'failed');
    await assert.rejects(
      manager.start('alice', next.id, (spawn) => spawn()),
      /RUNTIME_CAPACITY/,
    );
    await assert.rejects(manager.shutdown(), /RUNTIME_CLEANUP_FAILED/);
    assert.equal(f.specs.length, 1);
    f.failCleanup(false);
    await manager.shutdown();
    assert.equal(manager.stats().failed, 0);
  } finally {
    gate.resolve();
    f.failCleanup(false);
    await manager.shutdown();
    await f.close();
  }
});

test('driver half rejects arbitrary paths and copied specs rather than treating a receipt as admission', async () => {
  const f = await fixture();
  try {
    const boundary = nativeQuotaBoundary(f.options, f.driver);
    const w = await f.manager.create('alice', { name: 'paired seam' });
    const spec = await boundary.storage.runtimePaths(w);
    await assert.rejects(
      boundary.driver.startWithAdmission!({ ...spec, dir: '/etc' }, (spawn) => spawn()),
      /NATIVE_QUOTA_UNSAFE_SPEC/,
    );
    await assert.rejects(
      boundary.driver.startWithAdmission!({ ...spec }, (spawn) => spawn()),
      /NATIVE_QUOTA_UNSAFE_SPEC/,
    );
    await boundary.driver.startWithAdmission!(spec, (spawn) => spawn());
    await assert.rejects(
      boundary.driver.startWithAdmission!(spec, (spawn) => spawn()),
      /NATIVE_QUOTA_UNSAFE_SPEC/,
    );
    assert.equal(f.specs.length, 1);
  } finally {
    await f.close();
  }
});

test('production mode, unsupported admission, and overlapping roots refuse composition', async () => {
  const f = await fixture();
  try {
    assert.throws(
      () =>
        nativeQuotaBoundary({ ...f.options, mode: 'production' } as unknown as NativeQuotaOptions, f.driver),
      /NATIVE_QUOTA_PRODUCTION_UNAVAILABLE/,
    );
    assert.throws(() =>
      nativeQuotaBoundary({ ...f.options, mountUuid: '00000000-0000-0000-0000-000000000000' }, f.driver),
    );
    assert.throws(
      () => nativeQuotaBoundary(f.options, { start: f.driver.start }),
      /RUNTIME_START_ADMISSION_UNSUPPORTED/,
    );
    assert.throws(
      () => nativeQuotaBoundary({ ...f.options, projectRoot: f.dataRoot }, f.driver),
      /NATIVE_QUOTA_UNSAFE_PATH/,
    );
  } finally {
    await f.close();
  }
});
