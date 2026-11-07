// Protected launcher mode of the step-runner driver (native/runner-launcher): the gateway may run only
// `/usr/local/libexec/step-runner-launch/launch v1 p<ID>/<uuid> <launch-id> <tmpfs-bytes>` as step-runner, and the
// launcher execs bwrap with its own compiled-in vector. These tests are unprivileged:
//  - option and request validation on the TS side (nothing is spawned for an unsupported launch);
//  - a contract test that runs the TESTING build of the native launcher (scratch-prefixed layout, a fake bwrap that
//    reports what it received) with exactly the argv the driver generates, and requires the resulting bwrap vector
//    to equal the existing raw-bwrap sandbox (guarded by sandbox-userns.test.ts) except for the socket bind by fd.
// The host tests through the real sudo rule are in step-runner-launcher-host.test.ts (gated, owner install first).
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import {
  chmodSync,
  closeSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { WorkspaceError, type RuntimeSpec } from '../src/workspace/contract.ts';
import {
  PROTECTED_LAUNCHER,
  stepRunnerCommand,
  stepRunnerDriver,
  type StepRunnerOptions,
} from '../src/workspace/step-runner-driver.ts';

const REPO = resolve(import.meta.dirname, '../..');
const NATIVE = join(REPO, 'native/runner-launcher');
const UUID = '0f8e7d6c-5b4a-4392-8170-6a5b4c3d2e1f';
const LAUNCH_ID = '00112233445566778899aabbccddeeff';
const dirOf = (project: number, uuid = UUID) => `${PROTECTED_LAUNCHER.brokerRoot}/p${project}/${uuid}`;
const specOf = (project = 100000, uuid = UUID): RuntimeSpec =>
  ({
    ownerId: 'u',
    workspaceId: `ws_${uuid.replaceAll('-', '')}`,
    dir: dirOf(project, uuid),
    filesDir: `${dirOf(project, uuid)}/files`,
  }) as unknown as RuntimeSpec;

const protectedOptions: StepRunnerOptions = {
  launcher: 'protected',
  transport: 'authenticated',
  appRoot: PROTECTED_LAUNCHER.appRoot,
  nodePath: PROTECTED_LAUNCHER.nodePath,
  socketRoot: PROTECTED_LAUNCHER.socketRoot,
  runnerUid: 995,
  memoryMaxBytes: 512 * 1024 * 1024,
  tasksMax: 64,
  cpuQuotaPercent: 100,
  tmpfsBytes: 16 * 1024 * 1024,
};
const launch = {
  unit: `step-rt-${LAUNCH_ID}.scope`,
  socketDir: `${PROTECTED_LAUNCHER.socketRoot}/${LAUNCH_ID}`,
  pinned: true,
};

test('protected mode accepts only the fixed layout, authenticated transport and a bounded tmpfs', () => {
  assert.doesNotThrow(() => stepRunnerDriver(protectedOptions));
  for (const bad of [
    { transport: 'nonce' },
    { transport: undefined },
    { appRoot: '/srv/step/app' },
    { nodePath: '/usr/bin/node' },
    { socketRoot: '/run/step/sockets' },
    { runnerUser: 'nobody' },
    { entry: 'server/src/test-entries/fake-sleeper.mjs' },
    { tmpfsBytes: undefined },
    { tmpfsBytes: 2 * 1024 * 1024 * 1024 },
    { launcher: 'other' },
  ] as Partial<StepRunnerOptions>[])
    assert.throws(() => stepRunnerDriver({ ...protectedOptions, ...bad } as StepRunnerOptions), {
      message: 'INVALID_STEP_RUNNER_OPTIONS',
    });
  // The default stays the raw bwrap rule until the owner switches (existing gated suite).
  assert.doesNotThrow(() =>
    stepRunnerDriver({ ...protectedOptions, launcher: undefined, appRoot: '/srv/a' }),
  );
});

test('protected command is the fixed request only: no bwrap flag, path or environment from the gateway', () => {
  const argv = stepRunnerCommand(specOf(), protectedOptions, launch);
  const at = argv.indexOf('sudo');
  assert.deepEqual(argv.slice(at), [
    'sudo',
    '-n',
    '-u',
    'step-runner',
    PROTECTED_LAUNCHER.path,
    'v1',
    `p100000/${UUID}`,
    LAUNCH_ID,
    String(16 * 1024 * 1024),
  ]);
  // The scope limits are unchanged: systemd-run still sets them for the whole launch.
  assert.ok(argv.slice(0, at).includes(`MemoryMax=${512 * 1024 * 1024}`));
  assert.ok(
    !argv.includes('/usr/bin/bwrap') && !argv.some((a) => a.startsWith('--bind') || a === '--setenv'),
  );
});

test('protected command refuses every launch the launcher would refuse', () => {
  const refuse = (spec: RuntimeSpec, l = launch) =>
    assert.throws(() => stepRunnerCommand(spec, protectedOptions, l), {
      message: 'PROTECTED_LAUNCH_UNSUPPORTED',
    });
  refuse(specOf(), { ...launch, pinned: false }); // only --bind-fd 1; never a path bind
  refuse(specOf(99999));
  refuse(specOf(200000));
  refuse(specOf(100000, UUID.toUpperCase()));
  refuse({ ...specOf(), dir: `/mnt/step-work/step-ai/p100000/${UUID}` } as RuntimeSpec);
  refuse({ ...specOf(), filesDir: `${dirOf(100000)}/snapshots` } as RuntimeSpec);
  refuse({ ...specOf(), workspaceId: 'ws_ffffffffffffffffffffffffffffffff' } as RuntimeSpec);
  refuse({
    ...specOf(),
    dir: `${dirOf(100000)}/files`,
    filesDir: `${dirOf(100000)}/files/files`,
  } as RuntimeSpec);
  refuse(specOf(), { ...launch, socketDir: `/tmp/${LAUNCH_ID}` });
  refuse(specOf(), { ...launch, socketDir: `${PROTECTED_LAUNCHER.socketRoot}/x` });
});

test('unpinned starts in protected mode fail before any socket, journal entry or spawn', async () => {
  let journaled = 0;
  let admitted = 0;
  const driver = stepRunnerDriver(protectedOptions).recovery.journaled({
    record: () => {
      journaled++;
      return { resolve() {} };
    },
  } as never);
  for (const start of [
    () => driver.start(specOf()),
    () => driver.startWithAdmission(specOf(), () => void admitted++),
  ])
    await assert.rejects(start(), (error: unknown) => {
      assert.ok(error instanceof WorkspaceError);
      assert.equal((error as WorkspaceError & { cause?: unknown }).cause, 'LAUNCH_SPEC_UNSUPPORTED');
      return true;
    });
  assert.equal(journaled, 0);
  assert.equal(admitted, 0);
});

// ---- contract with the native launcher (TESTING build: scratch prefix, caller's uid as every principal) ----

function buildTree(prefix: string) {
  const dirs: [string, number][] = [
    ['/usr', 0o755],
    ['/usr/bin', 0o755],
    ['/mnt', 0o755],
    ['/mnt/step-work', 0o755],
    ['/mnt/step-work/step-ai-broker', 0o755],
    ['/mnt/step-work/step-ai-broker/root', 0o710],
    ['/mnt/step-work/step-ai-broker/root/p100000', 0o750],
    [`/mnt/step-work/step-ai-broker/root/p100000/${UUID}`, 0o2750],
    [`/mnt/step-work/step-ai-broker/root/p100000/${UUID}/files`, 0o2750],
    ['/var', 0o755],
    ['/var/lib', 0o755],
    ['/var/lib/step-runner-launch', 0o755],
    ['/var/lib/step-runner-launch/sockets', 0o711],
    [`/var/lib/step-runner-launch/sockets/${LAUNCH_ID}`, 0o711],
    ['/opt', 0o755],
    ['/opt/step', 0o755],
    ['/opt/step/app', 0o755],
    ['/opt/step/app/node_modules', 0o755],
    ['/opt/step/app/server', 0o755],
    ['/opt/step/app/server/src', 0o755],
    ['/opt/step/app/harness', 0o755],
    ['/opt/step/node', 0o755],
    ['/opt/step/node/bin', 0o755],
  ];
  for (const [path, mode] of dirs) {
    mkdirSync(prefix + path);
    chmodSync(prefix + path, mode);
  }
  copyFileSync(join(NATIVE, 'fake-bwrap'), `${prefix}/usr/bin/bwrap`);
  copyFileSync(join(NATIVE, 'fake-bwrap'), `${prefix}/opt/step/node/bin/node`);
  copyFileSync(join(NATIVE, 'fake-bwrap'), `${prefix}/opt/step/app/package.json`);
  copyFileSync(join(NATIVE, 'fake-bwrap'), `${prefix}/opt/step/app/server/package.json`);
  chmodSync(`${prefix}/usr/bin/bwrap`, 0o755);
  chmodSync(`${prefix}/opt/step/node/bin/node`, 0o755);
  chmodSync(`${prefix}/opt/step/app/package.json`, 0o644);
  chmodSync(`${prefix}/opt/step/app/server/package.json`, 0o644);
}

function runLauncher(prefix: string, args: string[], fd1: number, stdin: string) {
  return new Promise<{ code: number | null; report: string }>((done, fail) => {
    const child = spawn(join(NATIVE, 'launch-testing'), args, {
      env: { SRL_TEST_ROOT: prefix, NODE_OPTIONS: '--require=/tmp/evil.js' },
      stdio: ['pipe', fd1, 'pipe'],
    });
    let report = '';
    child.stderr!.on('data', (chunk) => (report += chunk));
    child.on('error', fail);
    child.on('close', (code) => done({ code, report }));
    // A refused launch exits without reading its stdin (as in the driver, the write may then fail).
    child.stdin!.on('error', () => {});
    child.stdin!.end(stdin);
  });
}

test('the native launcher accepts the driver request and execs exactly the guarded sandbox vector', async () => {
  execFileSync('make', ['-s', '-C', NATIVE, 'launch-testing', 'fake-bwrap'], { stdio: 'ignore' });
  const base = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'srl-contract-'));
  const prefix = join(base, 'root');
  mkdirSync(prefix, { mode: 0o755 });
  chmodSync(prefix, 0o755);
  try {
    buildTree(prefix);
    const argv = stepRunnerCommand(specOf(), protectedOptions, launch);
    const request = argv.slice(argv.indexOf(PROTECTED_LAUNCHER.path) + 1);
    const key = JSON.stringify({ path: '/run/step-runtime/rt.sock', key: 'k'.repeat(64) }) + '\n';

    const ws = openSync(prefix + dirOf(100000), 'r');
    let result;
    try {
      result = await runLauncher(prefix, request, ws, key);
    } finally {
      closeSync(ws);
    }
    assert.equal(result.code, 0, result.report);
    const lines = result.report.split('\n');
    const execd = lines.filter((l) => l.startsWith('arg=')).map((l) => l.slice(4).replaceAll(prefix, ''));
    assert.ok(lines.includes('envc=0'), 'bwrap gets an empty environment');
    assert.ok(lines.includes('extra_fds=0'), 'no descriptor beyond 0-3 reaches bwrap');
    assert.ok(lines.includes(`fd3=${prefix}${PROTECTED_LAUNCHER.socketRoot}/${LAUNCH_ID}`));
    assert.ok(
      lines.includes(`stdin=${Buffer.from(key).toString('hex')}`),
      'the key passes through unchanged',
    );

    // The same launch through the raw bwrap path (what sandbox-userns.test.ts guards), with the socket by path.
    const raw = stepRunnerCommand(specOf(), { ...protectedOptions, launcher: undefined }, launch);
    const sandbox = raw.slice(raw.indexOf('/usr/bin/bwrap') + 1);
    const socketBind = sandbox.indexOf('--ro-bind', sandbox.indexOf('--chdir'));
    assert.deepEqual(sandbox.slice(socketBind, socketBind + 3), [
      '--ro-bind',
      launch.socketDir,
      '/run/step-runtime',
    ]);
    sandbox.splice(socketBind, 3, '--ro-bind-fd', '3', '/run/step-runtime');
    assert.deepEqual(execd, sandbox);

    // A refused request never reaches bwrap.
    const filesFd = openSync(`${prefix}${dirOf(100000)}/files`, 'r');
    try {
      const refused = await runLauncher(prefix, request, filesFd, key);
      assert.equal(refused.code, 2);
      assert.match(refused.report, /REFUSED location/);
      assert.doesNotMatch(refused.report, /envc=/);
    } finally {
      closeSync(filesFd);
    }
    symlinkSync(LAUNCH_ID, `${prefix}${PROTECTED_LAUNCHER.socketRoot}/${'f'.repeat(32)}`);
    const ws2 = openSync(prefix + dirOf(100000), 'r');
    try {
      const swapped = await runLauncher(
        prefix,
        [request[0]!, request[1]!, 'f'.repeat(32), request[3]!],
        ws2,
        key,
      );
      assert.equal(swapped.code, 2);
      assert.match(swapped.report, /REFUSED socket/);
    } finally {
      closeSync(ws2);
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('the launcher entry paths match what the driver resolves (tsx loader, register, runtime entry)', () => {
  const header = execFileSync(
    'grep',
    ['-E', '^#define SRL_(TSX_LOADER|REGISTER|ENTRY) ', join(NATIVE, 'launcher.h')],
    {
      encoding: 'utf8',
    },
  );
  const value = (name: string) => new RegExp(`#define SRL_${name} "([^"]+)"`).exec(header)?.[1];
  const raw = stepRunnerCommand(specOf(), { ...protectedOptions, launcher: undefined }, launch);
  const node = raw.slice(raw.indexOf(PROTECTED_LAUNCHER.nodePath));
  assert.deepEqual(node, [
    PROTECTED_LAUNCHER.nodePath,
    '--import',
    `file://${PROTECTED_LAUNCHER.appRoot}/${value('TSX_LOADER')}`,
    '--import',
    `file://${PROTECTED_LAUNCHER.appRoot}/${value('REGISTER')}`,
    `${PROTECTED_LAUNCHER.appRoot}/${value('ENTRY')}`,
  ]);
});
