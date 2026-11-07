// #62 residual: the writer fence hands a data root to a successor as soon as the previous holder dies, but runtimes
// it launched can outlive it (a SIGKILLed manager does not stop its step-runner scopes). Every launch is journalled
// durably under the data root before its spawn; a successor reaps and proves gone every open entry before it admits
// any start, and fails closed while it cannot. Fake drivers and host hooks only: nothing here spawns a sandbox.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  WorkspaceError,
  type RuntimeDriver,
  type RuntimeHandle,
  type RuntimeLaunchJournal,
} from '../src/workspace/contract.ts';
import { LAUNCH_JOURNAL_DIR, LaunchJournal } from '../src/workspace/launch-journal.ts';
import { RuntimeManager } from '../src/workspace/manager.ts';
import {
  stepRunnerDriver,
  type StepRunnerHooks,
  type StepRunnerOptions,
} from '../src/workspace/step-runner-driver.ts';
import { workspacePaths } from '../src/workspace/storage.ts';
import { provisionTestQuota } from './support/quota.ts';
import type { AddressInfo } from 'node:net';
import { createGateway } from '../src/gateway/http.ts';
import { DEFAULT_QUOTAS, RunService } from '../src/gateway/runs.ts';

const UNIT = (c: string) => `step-rt-${c.repeat(32)}.scope`;
const root = (prefix: string) => provisionTestQuota(mkdtempSync(join(tmpdir(), prefix)), 2);
const journalDir = (dataRoot: string) => join(dataRoot, LAUNCH_JOURNAL_DIR);
const entries = (dataRoot: string) => readdirSync(journalDir(dataRoot)).sort();
const deferred = <T = void>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => ((resolve = done), (reject = fail)));
  return { promise, resolve, reject };
};

const handle = (): RuntimeHandle => ({
  health: async () => ({ ok: true, workspaceId: '' }),
  call: (async () => ({ ok: true })) as RuntimeHandle['call'],
  stop: async () => {},
  stopWithAdmission: async (admit) => admit(() => {}),
  onExit: () => {},
});

/** A fake recovering driver: records every launch in its journal before the spawn, as the contract requires. */
function recoveringDriver(reap: (unit: string) => Promise<void>, kind = 'step-runner') {
  const log: string[] = [];
  let launches = 0;
  const make = (journal?: RuntimeLaunchJournal): RuntimeDriver => {
    const startWithAdmission: NonNullable<RuntimeDriver['startWithAdmission']> = async (spec, admit) => {
      const unit = UNIT(String(++launches % 10));
      const record = journal?.record({ kind, unit, workspaceId: spec.workspaceId });
      log.push(`record ${unit}`);
      admit(() => log.push(`spawn ${unit}`));
      const h = handle();
      return {
        ...h,
        stop: async () => {
          log.push(`stop ${unit}`);
          record?.resolve();
        },
        stopWithAdmission: async (admitStop) => {
          admitStop(() => {});
          log.push(`stop ${unit}`);
          record?.resolve();
        },
      };
    };
    return {
      start: (spec) => startWithAdmission(spec, (spawnIt) => spawnIt()),
      startWithAdmission,
      recovery: {
        kind,
        journaled: (j) => make(j),
        reap: async (unit) => {
          log.push(`reap ${unit}`);
          await reap(unit);
          log.push(`reaped ${unit}`);
        },
      },
    };
  };
  return { driver: make(), log };
}

/** An open entry exactly as a crashed previous holder leaves it: recorded, never resolved. */
function orphanEntry(dataRoot: string, unit: string, kind = 'step-runner') {
  LaunchJournal.open(dataRoot).record({ kind, unit, workspaceId: `ws_${'0'.repeat(32)}` });
}

test('launch journal: a record is durable before it returns and resolve removes exactly that entry', () => {
  const dataRoot = root('step-journal-');
  try {
    const journal = LaunchJournal.open(dataRoot);
    const a = journal.record({ kind: 'step-runner', unit: UNIT('a'), workspaceId: `ws_${'1'.repeat(32)}` });
    assert.equal(lstatSync(journalDir(dataRoot)).mode & 0o777, 0o700);
    journal.record({ kind: 'step-runner', unit: UNIT('b'), workspaceId: `ws_${'2'.repeat(32)}` });
    assert.deepEqual(
      journal.pending().map((p) => p.unit),
      [UNIT('a'), UNIT('b')],
    );
    const meta = JSON.parse(readFileSync(join(journalDir(dataRoot), `step-runner~${UNIT('a')}`), 'utf8'));
    assert.equal(meta.workspaceId, `ws_${'1'.repeat(32)}`);
    assert.equal(meta.unit, UNIT('a'));
    a.resolve();
    a.resolve();
    assert.deepEqual(
      journal.pending().map((p) => p.unit),
      [UNIT('b')],
    );
    // The same identity can never be recorded twice while open.
    assert.throws(() =>
      journal.record({ kind: 'step-runner', unit: UNIT('b'), workspaceId: `ws_${'2'.repeat(32)}` }),
    );
    assert.throws(
      () => journal.record({ kind: 'step-runner', unit: '../escape', workspaceId: 'x' }),
      /LAUNCH_JOURNAL/,
    );
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('launch journal: the identity is the entry name, so an entry truncated by a crash still names its unit', () => {
  const dataRoot = root('step-journal-trunc-');
  try {
    assert.deepEqual(LaunchJournal.open(dataRoot).pending(), [], 'no directory until the first record');
    assert.ok(!readdirSync(dataRoot).includes(LAUNCH_JOURNAL_DIR));
    mkdirSync(journalDir(dataRoot), { mode: 0o700 });
    writeFileSync(join(journalDir(dataRoot), `step-runner~${UNIT('c')}`), '', { mode: 0o600 });
    assert.deepEqual(LaunchJournal.open(dataRoot).pending(), [{ kind: 'step-runner', unit: UNIT('c') }]);
    // Anything the journal did not write fails closed instead of being skipped.
    writeFileSync(join(journalDir(dataRoot), 'unexpected'), '', { mode: 0o600 });
    assert.throws(() => LaunchJournal.open(dataRoot).pending(), /LAUNCH_JOURNAL_UNSAFE/);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('launch journal: a journal directory others can write fails closed', () => {
  const dataRoot = root('step-journal-mode-');
  try {
    mkdirSync(journalDir(dataRoot), { mode: 0o700 });
    chmodSync(journalDir(dataRoot), 0o777);
    assert.throws(() => LaunchJournal.open(dataRoot), /LAUNCH_JOURNAL_UNSAFE/);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('a fresh manager journals each launch through its driver and a proven stop resolves it', async () => {
  const dataRoot = root('step-orphan-journal-');
  try {
    const { driver, log } = recoveringDriver(async () => {});
    const manager = new RuntimeManager({ dataRoot, workspacesPerUser: 2, driver });
    const ws = await manager.create('alice', { name: 'journalled' });
    let entriesAtSpawn: string[] | undefined;
    await manager.start('alice', ws.id, (spawnIt) => {
      spawnIt();
      // The manager's own pre-check admission spawns nothing; capture at the driver's spawn.
      if (log.at(-1)?.startsWith('spawn')) entriesAtSpawn ??= entries(dataRoot);
    });
    assert.deepEqual(entriesAtSpawn, [`step-runner~${UNIT('1')}`], 'recorded before the spawn');
    await manager.stop('alice', ws.id);
    assert.deepEqual(entries(dataRoot), []);
    await manager.shutdown();
    assert.deepEqual(log, [`record ${UNIT('1')}`, `spawn ${UNIT('1')}`, `stop ${UNIT('1')}`]);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('recovery before admission: a start waits until every previous launch is reaped, then proceeds', async () => {
  const dataRoot = root('step-orphan-order-');
  try {
    const seed = new RuntimeManager({
      dataRoot,
      workspacesPerUser: 2,
      driver: recoveringDriver(async () => {}).driver,
    });
    const ws = await seed.create('alice', { name: 'after crash' });
    await seed.shutdown();
    orphanEntry(dataRoot, UNIT('e'));
    orphanEntry(dataRoot, UNIT('f'));
    const gate = deferred();
    const { driver, log } = recoveringDriver(() => gate.promise);
    const successor = new RuntimeManager({ dataRoot, workspacesPerUser: 2, driver });
    let admitted = 0;
    const started = successor.start('alice', ws.id, (spawnIt) => {
      admitted++;
      spawnIt();
    });
    await new Promise((done) => setTimeout(done, 50));
    assert.equal(admitted, 0, 'no admission while a previous launch is unproven');
    assert.ok(!log.some((line) => line.startsWith('record')), 'nothing launched while recovering');
    assert.deepEqual(log.filter((l) => l.startsWith('reap ')).sort(), [
      `reap ${UNIT('e')}`,
      `reap ${UNIT('f')}`,
    ]);
    gate.resolve();
    assert.equal((await started).state, 'running');
    assert.ok(admitted > 0);
    assert.equal(log.filter((line) => line.startsWith('spawn')).length, 1);
    const firstLaunch = log.findIndex((line) => line.startsWith('record'));
    assert.ok(log.lastIndexOf(`reaped ${UNIT('e')}`) < firstLaunch);
    assert.ok(log.lastIndexOf(`reaped ${UNIT('f')}`) < firstLaunch);
    assert.deepEqual(entries(dataRoot), [`step-runner~${UNIT('1')}`], 'only the new launch is open');
    await successor.shutdown();
    assert.deepEqual(entries(dataRoot), []);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('an unresolved entry blocks every start with an explicit error; a later start retries recovery', async () => {
  const dataRoot = root('step-orphan-block-');
  try {
    const seed = new RuntimeManager({
      dataRoot,
      workspacesPerUser: 2,
      driver: recoveringDriver(async () => {}).driver,
    });
    const ws = await seed.create('alice', { name: 'blocked' });
    await seed.shutdown();
    orphanEntry(dataRoot, UNIT('d'));
    let proven = false;
    const { driver, log } = recoveringDriver(async () => {
      if (!proven) throw new WorkspaceError('RUNTIME_STOP_FAILED');
    });
    const successor = new RuntimeManager({ dataRoot, workspacesPerUser: 2, driver });
    let admitted = 0;
    const admit = (spawnIt: () => void) => {
      admitted++;
      spawnIt();
    };
    for (let i = 0; i < 2; i++)
      await assert.rejects(successor.start('alice', ws.id, admit), (error: unknown) => {
        assert.ok(error instanceof WorkspaceError);
        assert.equal(error.code, 'RUNTIME_RECOVERY_PENDING');
        return true;
      });
    await assert.rejects(successor.start('alice', ws.id), { code: 'RUNTIME_RECOVERY_PENDING' });
    assert.equal(admitted, 0);
    assert.equal((await successor.get('alice', ws.id)).state, 'stopped');
    assert.deepEqual(entries(dataRoot), [`step-runner~${UNIT('d')}`], 'the unproven entry stays open');
    assert.ok(!log.some((line) => line.startsWith('record')));
    proven = true;
    assert.equal((await successor.start('alice', ws.id, admit)).state, 'running');
    assert.ok(admitted > 0);
    assert.equal(log.filter((line) => line.startsWith('spawn')).length, 1);
    await successor.shutdown();
    assert.deepEqual(entries(dataRoot), []);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('an entry no configured driver can reap fails closed (other kind, or a driver without recovery)', async () => {
  const dataRoot = root('step-orphan-kind-');
  try {
    const seed = new RuntimeManager({
      dataRoot,
      workspacesPerUser: 2,
      driver: recoveringDriver(async () => {}).driver,
    });
    const ws = await seed.create('alice', { name: 'kind' });
    await seed.shutdown();
    orphanEntry(dataRoot, UNIT('9'), 'other-driver');
    const { driver } = recoveringDriver(async () => {});
    const first = new RuntimeManager({ dataRoot, workspacesPerUser: 2, driver });
    await assert.rejects(first.start('alice', ws.id), { code: 'RUNTIME_RECOVERY_PENDING' });
    await first.shutdown();
    const plain = new RuntimeManager({
      dataRoot,
      workspacesPerUser: 2,
      driver: { start: async () => assert.fail('must not start') },
    });
    await assert.rejects(plain.start('alice', ws.id), { code: 'RUNTIME_RECOVERY_PENDING' });
    await plain.shutdown();
    assert.deepEqual(entries(dataRoot), [`other-driver~${UNIT('9')}`]);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('recovery is eager: orphans are reaped right after the fence is taken, without waiting for a start', async () => {
  const dataRoot = root('step-orphan-eager-');
  try {
    orphanEntry(dataRoot, UNIT('7'));
    const reaped = deferred();
    const { driver } = recoveringDriver(async () => reaped.resolve());
    const successor = new RuntimeManager({ dataRoot, workspacesPerUser: 2, driver });
    await reaped.promise;
    for (let i = 0; i < 20 && entries(dataRoot).length; i++) await new Promise((d) => setTimeout(d, 10));
    assert.deepEqual(entries(dataRoot), []);
    await successor.shutdown();
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('gateway: a start refused for pending recovery is 503 RUNTIME_RECOVERY_PENDING, not a generic failure', async () => {
  const dataRoot = root('step-orphan-gateway-');
  try {
    const seed = new RuntimeManager({
      dataRoot,
      workspacesPerUser: 2,
      driver: recoveringDriver(async () => {}).driver,
    });
    const ws = await seed.create('alice', { name: 'gateway' });
    await seed.shutdown();
    orphanEntry(dataRoot, UNIT('5'));
    const { driver } = recoveringDriver(async () => {
      throw new WorkspaceError('RUNTIME_STOP_FAILED');
    });
    const manager = new RuntimeManager({ dataRoot, workspacesPerUser: 2, driver });
    const audit = () => {};
    const quotas = { ...DEFAULT_QUOTAS, workspacesPerUser: 2 };
    const server = createGateway({
      manager,
      quotas,
      runs: new RunService(manager, audit, quotas),
      authenticate: async (header) =>
        header === 'Bearer alice' ? { userId: 'alice', email: 'alice@step.example', admin: false } : null,
      audit,
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    try {
      const response = await fetch(
        `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/workspaces/${ws.id}/start`,
        {
          method: 'POST',
          headers: { authorization: 'Bearer alice', 'content-type': 'application/json' },
          body: '{}',
        },
      );
      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), { code: 'RUNTIME_RECOVERY_PENDING' });
    } finally {
      server.closeAllConnections();
      await new Promise((done) => server.close(done));
      await manager.shutdown();
    }
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

// ---- the step-runner driver: journal-before-spawn and reap, with host operations replaced by fakes ----

const pure: StepRunnerOptions = {
  appRoot: '/opt/step/app',
  nodePath: '/opt/step/node/bin/node',
  socketRoot: '/run/step/sockets',
  runnerUid: 995,
  memoryMaxBytes: 1024 * 1024 * 1024,
  tasksMax: 128,
  cpuQuotaPercent: 100,
  stopTimeoutMs: 300,
};
const pureSpec = workspacePaths('/srv/step', 'alice', `ws_${'a'.repeat(32)}`);
const uid = process.getuid!();
const userCgroup = `/user.slice/user-${uid}.slice/user@${uid}.service/app.slice`;

function memoryJournal(fail = false) {
  const log: string[] = [];
  const open = new Set<string>();
  const journal: RuntimeLaunchJournal = {
    record: ({ kind, unit, workspaceId }) => {
      if (fail) throw new Error('ENOSPC');
      log.push(`record ${kind} ${unit} ${workspaceId}`);
      open.add(unit);
      return { resolve: () => void (open.delete(unit) && log.push(`resolve ${unit}`)) };
    },
  };
  return { journal, log, open };
}

test('step-runner: the launch is journalled before admission, and resolved when nothing was spawned', async () => {
  const sockets = mkdtempSync(join(tmpdir(), 'step-socket-root-'));
  try {
    chmodSync(sockets, 0o700);
    const { journal, log, open } = memoryJournal();
    const driver = stepRunnerDriver({ ...pure, socketRoot: sockets }).recovery.journaled(journal);
    await assert.rejects(
      driver.startPinnedWithAdmission(
        pureSpec,
        () => {
          log.push('pin');
          throw new Error('PIN_REFUSED');
        },
        (spawnIt) => {
          log.push('admit');
          spawnIt();
        },
      ),
      /PIN_REFUSED/,
    );
    assert.match(
      log[0]!,
      new RegExp(`^record step-runner step-rt-[0-9a-f]{32}\\.scope ${pureSpec.workspaceId}$`),
    );
    assert.deepEqual(log.slice(1, 3), ['admit', 'pin']);
    assert.match(log[3]!, /^resolve step-rt-/);
    assert.equal(open.size, 0);
    // A denied admission, too, spawned nothing: the record is resolved.
    await assert.rejects(
      driver.startWithAdmission(pureSpec, () => {
        throw new Error('DENIED');
      }),
      /DENIED/,
    );
    assert.equal(open.size, 0);
    assert.deepEqual(readdirSync(sockets), []);
  } finally {
    rmSync(sockets, { recursive: true, force: true });
  }
});

test('step-runner: a launch whose journal record fails is never admitted or spawned', async () => {
  const sockets = mkdtempSync(join(tmpdir(), 'step-socket-root-'));
  try {
    chmodSync(sockets, 0o700);
    let admitted = false;
    const driver = stepRunnerDriver({ ...pure, socketRoot: sockets }).recovery.journaled(
      memoryJournal(true).journal,
    );
    await assert.rejects(
      driver.startWithAdmission(pureSpec, () => {
        admitted = true;
      }),
      { code: 'RUNTIME_START_FAILED', cause: 'LAUNCH_JOURNAL_FAILED' },
    );
    assert.equal(admitted, false);
    assert.deepEqual(readdirSync(sockets), []);
  } finally {
    rmSync(sockets, { recursive: true, force: true });
  }
});

/** Host fakes: a user manager, a cgroup tree and a process table, all in memory. */
function fakeHost(state: {
  units?: Record<string, string>;
  cgroups?: Record<string, number>;
  procs?: { pid: number; uid: number; argv: string[] }[];
  showFails?: boolean;
  stuck?: boolean;
}) {
  const calls: string[] = [];
  const cgroups = state.cgroups ?? {};
  const procs = state.procs ?? [];
  const hooks: StepRunnerHooks = {
    systemctl: async (args) => {
      calls.push(`systemctl ${args.join(' ')}`);
      if (args[0] === 'show' && args.includes('ControlGroup')) {
        if (state.showFails) return { code: 1, stdout: '' };
        return { code: 0, stdout: (state.units?.[args[1]!] ?? '') + '\n' };
      }
      if (args[0] === 'show') return { code: 0, stdout: 'LoadState=not-found\nActiveState=inactive\n' };
      return { code: 0, stdout: '' };
    },
    writeCgroupFile: (path) => {
      calls.push(`kill ${path}`);
      const cgroup = path.replace(/\/cgroup\.kill$/, '');
      if (!(cgroup in cgroups)) throw Object.assign(new Error('gone'), { code: 'ENOENT' });
      if (!state.stuck) cgroups[cgroup] = 0;
    },
    readCgroupFile: async (path) => {
      const cgroup = path.replace(/\/cgroup\.events$/, '');
      if (!(cgroup in cgroups)) throw Object.assign(new Error('gone'), { code: 'ENOENT' });
      return `populated ${cgroups[cgroup]}\nfrozen 0\n`;
    },
    listProcesses: async () => procs.map((p) => ({ ...p })),
    killProcess: (pid) => {
      calls.push(`sigkill ${pid}`);
      const at = procs.findIndex((p) => p.pid === pid);
      if (at >= 0) procs.splice(at, 1);
    },
    listScopeCgroups: async (unit) => Object.keys(cgroups).filter((c) => c.endsWith('/' + unit)),
  };
  return { hooks, calls, cgroups, procs };
}

test('step-runner reap: a recorded unit that never started (crash before spawn) is proven absent', async () => {
  const sockets = mkdtempSync(join(tmpdir(), 'step-socket-root-'));
  try {
    chmodSync(sockets, 0o700);
    // The dead launch's socket folder shares the unit's launch id and is removed once the launch is proven gone.
    mkdirSync(join(sockets, 'a'.repeat(32)));
    mkdirSync(join(sockets, 'b'.repeat(32)));
    const host = fakeHost({});
    await stepRunnerDriver({ ...pure, socketRoot: sockets }, host.hooks).recovery.reap(UNIT('a'));
    assert.ok(host.calls.includes(`systemctl show ${UNIT('a')} -p ControlGroup --value`));
    assert.ok(!host.calls.some((c) => c.startsWith('kill ')));
    assert.deepEqual(readdirSync(sockets), ['b'.repeat(32)]);
  } finally {
    rmSync(sockets, { recursive: true, force: true });
  }
});

test('step-runner reap: a live orphan scope is killed with cgroup.kill and proven empty', async () => {
  const cgroup = `/sys/fs/cgroup${userCgroup}/${UNIT('b')}`;
  const host = fakeHost({ units: { [UNIT('b')]: `${userCgroup}/${UNIT('b')}` }, cgroups: { [cgroup]: 1 } });
  await stepRunnerDriver(pure, host.hooks).recovery.reap(UNIT('b'));
  assert.ok(host.calls.includes(`kill ${cgroup}/cgroup.kill`));
  assert.equal(host.cgroups[cgroup], 0);
  assert.ok(host.calls.includes(`systemctl stop ${UNIT('b')}`), 'the emptied unit is removed too');
});

test('step-runner reap: a cgroup systemd no longer reports is still found in the cgroup tree and killed', async () => {
  const cgroup = `/sys/fs/cgroup${userCgroup}/${UNIT('c')}`;
  const host = fakeHost({ cgroups: { [cgroup]: 1 } });
  await stepRunnerDriver(pure, host.hooks).recovery.reap(UNIT('c'));
  assert.equal(host.cgroups[cgroup], 0);
});

test('step-runner reap: a pre-scope launcher still alive is killed before the scope is judged absent', async () => {
  const host = fakeHost({
    procs: [
      {
        pid: 4242,
        uid,
        argv: ['systemd-run', '--user', '--scope', '--quiet', `--unit=${UNIT('d')}`, '--', 'sudo'],
      },
      // Same command line under another uid, or another unit: never touched.
      { pid: 4343, uid: uid + 1, argv: ['systemd-run', `--unit=${UNIT('d')}`] },
      { pid: 4444, uid, argv: ['systemd-run', `--unit=${UNIT('e')}`] },
    ],
  });
  await stepRunnerDriver(pure, host.hooks).recovery.reap(UNIT('d'));
  assert.deepEqual(
    host.calls.filter((c) => c.startsWith('sigkill')),
    ['sigkill 4242'],
  );
  assert.ok(
    host.calls.indexOf('sigkill 4242') <
      host.calls.indexOf(`systemctl show ${UNIT('d')} -p ControlGroup --value`),
  );
});

test('step-runner reap fails closed: unknown systemd state, a scope that never empties, a foreign cgroup, a bad name', async () => {
  const driver = (state: Parameters<typeof fakeHost>[0]) => stepRunnerDriver(pure, fakeHost(state).hooks);
  await assert.rejects(driver({ showFails: true }).recovery.reap(UNIT('a')), { code: 'RUNTIME_STOP_FAILED' });
  const cgroup = `/sys/fs/cgroup${userCgroup}/${UNIT('b')}`;
  await assert.rejects(driver({ cgroups: { [cgroup]: 1 }, stuck: true }).recovery.reap(UNIT('b')), {
    code: 'RUNTIME_STOP_FAILED',
    cause: 'NOT_PROVEN_EMPTY',
  });
  await assert.rejects(
    driver({ units: { [UNIT('c')]: `/system.slice/${UNIT('c')}` } }).recovery.reap(UNIT('c')),
    { code: 'RUNTIME_STOP_FAILED' },
  );
  const host = fakeHost({});
  await assert.rejects(stepRunnerDriver(pure, host.hooks).recovery.reap('ssh.service'), {
    code: 'RUNTIME_STOP_FAILED',
  });
  assert.deepEqual(host.calls, [], 'an invalid name is refused before any host operation');
});

// ---- a real crash between the journal write and the spawn, in another process ----

test('crash between journal write and spawn: the successor proves the launch absent and admits the start', async () => {
  const dataRoot = root('step-orphan-crash-');
  const sockets = mkdtempSync(join(tmpdir(), 'step-socket-root-'));
  try {
    chmodSync(sockets, 0o700);
    const options = { ...pure, socketRoot: sockets };
    const seed = new RuntimeManager({
      dataRoot,
      workspacesPerUser: 2,
      driver: recoveringDriver(async () => {}).driver,
    });
    const ws = await seed.create('alice', { name: 'crashed launch' });
    await seed.shutdown();
    // The holder dies (SIGKILL) inside admission: after the journal write, before anything is spawned.
    const script = `
      import { RuntimeManager } from './server/src/workspace/manager.ts';
      import { stepRunnerDriver } from './server/src/workspace/step-runner-driver.ts';
      const [dataRoot, options, id] = process.argv.slice(1);
      const manager = new RuntimeManager({ dataRoot, workspacesPerUser: 2, driver: stepRunnerDriver(JSON.parse(options)) });
      // The manager's own pre-check admission comes first; the second call is the driver's spawn admission.
      let calls = 0;
      await manager.start('alice', id, (spawnIt) => (++calls === 2 ? process.kill(process.pid, 'SIGKILL') : spawnIt()));
    `;
    const child = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        '--import',
        './server/src/register.mjs',
        '--input-type=module',
        '-e',
        script,
        dataRoot,
        JSON.stringify(options),
        ws.id,
      ],
      { cwd: process.cwd(), stdio: ['ignore', 'inherit', 'inherit'] },
    );
    const signal = await new Promise((done) => child.once('exit', (_code, sig) => done(sig)));
    assert.equal(signal, 'SIGKILL');
    const open = entries(dataRoot);
    assert.equal(open.length, 1);
    assert.match(open[0]!, /^step-runner~step-rt-[0-9a-f]{32}\.scope$/);
    const unit = open[0]!.slice('step-runner~'.length);

    // Fail closed while the user manager cannot answer...
    const failing = fakeHost({ showFails: true });
    const blocked = new RuntimeManager({
      dataRoot,
      workspacesPerUser: 2,
      driver: stepRunnerDriver(options, failing.hooks),
    });
    let admitted = 0;
    await assert.rejects(
      blocked.start('alice', ws.id, () => admitted++),
      { code: 'RUNTIME_RECOVERY_PENDING' },
    );
    assert.equal(admitted, 0);
    await blocked.shutdown();
    assert.deepEqual(entries(dataRoot), open);

    // ...and admit once the launch is proven absent.
    const host = fakeHost({});
    const successor = new RuntimeManager({
      dataRoot,
      workspacesPerUser: 2,
      driver: stepRunnerDriver(options, host.hooks),
    });
    await assert.rejects(
      successor.start('alice', ws.id, () => {
        admitted++;
        throw new Error('DENIED_AFTER_RECOVERY');
      }),
      /DENIED_AFTER_RECOVERY/,
    );
    assert.equal(admitted, 1, 'admission is reached, and only after recovery');
    assert.ok(host.calls.includes(`systemctl show ${unit} -p ControlGroup --value`));
    assert.deepEqual(entries(dataRoot), [], 'the recovered entry and the denied launch are both resolved');
    await successor.shutdown();
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
    rmSync(sockets, { recursive: true, force: true });
  }
});
