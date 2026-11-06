// The step-runner driver: each Workspace runtime runs as the unprivileged `step-runner` account, inside Bubblewrap,
// inside its own limited systemd user scope, speaking over a per-sandbox Unix socket; stop is cgroup.kill plus proof.
// Host tests need the sudo rule of spikes/057-step-runner-sudo and run only with STEP_STEP_RUNNER_TESTS=1.
// Synthetic data only: the runtime is forced onto its in-sandbox synthetic provider.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import {
  chmodSync,
  closeSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  newWorkspaceId,
  RuntimeStartCleanupError,
  WorkspaceError,
  type RuntimeSpec,
} from '../src/workspace/contract.ts';
import { workspacePaths } from '../src/workspace/storage.ts';
import { parseRunnerPids, parseUnits } from './support/cleanup-observation.ts';
import { frameReader, encodeFrame } from '../src/workspace/frames.ts';
import {
  stepRunnerCommand,
  stepRunnerDriver,
  stepRunnerSandboxArgs,
  type StepRunnerHandle,
  type StepRunnerHooks,
  type StepRunnerOptions,
} from '../src/workspace/step-runner-driver.ts';

const REPO = resolve(import.meta.dirname, '../..');
const enabled = process.env.STEP_STEP_RUNNER_TESTS === '1';
const host = {
  skip: enabled
    ? false
    : 'host test: set STEP_STEP_RUNNER_TESTS=1 on a host with the step-runner sudo rule (spikes/057-step-runner-sudo)',
};
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

const pure: StepRunnerOptions = {
  appRoot: '/opt/step/app',
  nodePath: '/opt/step/node/bin/node',
  socketRoot: '/run/step/sockets',
  runnerUid: 995,
  memoryMaxBytes: 1024 * 1024 * 1024,
  tasksMax: 128,
  cpuQuotaPercent: 100,
};
const pureSpec = workspacePaths('/srv/step', 'alice', `ws_${'a'.repeat(32)}`);

test('frames: newline-delimited JSON, split across chunks, oversize rejected', () => {
  const seen: unknown[] = [];
  const errors: string[] = [];
  const push = frameReader(
    32,
    (v) => seen.push(v),
    (e) => errors.push(e),
  );
  const bytes = Buffer.from(encodeFrame({ a: 1 }) + encodeFrame({ b: 'สอง' }));
  push(bytes.subarray(0, 5));
  push(bytes.subarray(5));
  assert.deepEqual(seen, [{ a: 1 }, { b: 'สอง' }]);
  push(Buffer.from('x'.repeat(40)));
  assert.deepEqual(errors, ['FRAME_TOO_LARGE']);
  const bad: string[] = [];
  frameReader(
    64,
    () => {},
    (e) => bad.push(e),
  )(Buffer.from('{nope}\n'));
  assert.deepEqual(bad, ['FRAME_INVALID']);
  assert.equal(encodeFrame({ t: 'a\nb' }).split('\n').length, 2);
});

test('options fail closed: explicit absolute paths and bounded limits', () => {
  for (const bad of [
    { appRoot: 'relative' },
    { nodePath: 'node' },
    { socketRoot: '' },
    { runnerUid: 0 },
    { runnerUid: 1.5 },
    { memoryMaxBytes: 0 },
    { memoryMaxBytes: Infinity },
    { tasksMax: 0 },
    { cpuQuotaPercent: 0 },
    { cpuQuotaPercent: 1e9 },
    { maxFrameBytes: 10 },
    { entry: '../../etc/passwd' },
    { entry: '/abs.mjs' },
    // tmpfsBytes is checked at construction, not first at start().
    { tmpfsBytes: 1000 },
    { tmpfsBytes: 0 },
    { tmpfsBytes: -65536 },
    { tmpfsBytes: 65536.5 },
  ])
    assert.throws(() => stepRunnerDriver({ ...pure, ...bad } as StepRunnerOptions), /INVALID_STEP_RUNNER/);
  assert.throws(
    () => stepRunnerDriver({ ...pure, memoryMaxBytes: undefined } as unknown as StepRunnerOptions),
    /INVALID_STEP_RUNNER/,
  );
});

test('launch command: random scope with limits, sudo to step-runner only via bwrap, cleared environment', () => {
  const launch = {
    unit: `step-rt-${'b'.repeat(32)}.scope`,
    socketDir: '/run/step/sockets/x',
  };
  const argv = stepRunnerCommand(pureSpec, pure, launch);
  const at = argv.indexOf('sudo');
  assert.deepEqual(argv.slice(0, 5), [
    'systemd-run',
    '--user',
    '--scope',
    '--quiet',
    `--unit=${launch.unit}`,
  ]);
  const limits = argv.slice(5, at);
  for (const p of ['MemoryMax=1073741824', 'TasksMax=128', 'CPUQuota=100%']) assert.ok(limits.includes(p), p);
  assert.deepEqual(argv.slice(at, at + 6), [
    'sudo',
    '-n',
    '-u',
    'step-runner',
    '/usr/bin/bwrap',
    '--clearenv',
  ]);
  const env = Object.fromEntries(
    argv.flatMap((a, i) => (a === '--setenv' ? [[argv[i + 1], argv[i + 2]]] : [])) as [string, string][],
  );
  assert.equal(env.STEP_SYNTHETIC_PROVIDER, '1');
  // The launch nonce goes over stdin only: argv and the environment are readable by other local users.
  assert.ok(!argv.some((a) => /[0-9a-f]{64}/.test(a)));
  assert.equal(env.STEP_RUNTIME_SOCKET, '/run/step-runtime/rt.sock');
  assert.equal(env.STEP_WORKSPACE_DIR, pureSpec.dir);
  assert.deepEqual(Object.keys(env).sort(), [
    'LANG',
    'NODE_ENV',
    'PATH',
    'STEP_RUNTIME_SOCKET',
    'STEP_SYNTHETIC_PROVIDER',
    'STEP_WORKSPACE_DIR',
    'STEP_WORKSPACE_ID',
  ]);
  const ro = argv.flatMap((a, i) => (a === '--ro-bind' ? [`${argv[i + 1]}=>${argv[i + 2]}`] : []));
  assert.ok(ro.includes('/run/step/sockets/x=>/run/step-runtime'));
  assert.ok(ro.includes('/opt/step/node/bin=>/opt/step/node/bin'));
  assert.ok(ro.includes('/opt/step/app/server/src=>/opt/step/app/server/src'));
  assert.ok(!argv.some((a) => a.includes('/home/')));
  assert.equal(argv.filter((a) => a === '--bind').length, 1);
  assert.deepEqual(argv.slice(argv.indexOf('--bind'), argv.indexOf('--bind') + 3), [
    '--bind',
    pureSpec.dir,
    pureSpec.dir,
  ]);
  const tail = argv.slice(argv.lastIndexOf('--') + 1);
  assert.equal(tail[0], pure.nodePath);
  assert.equal(tail.at(-1), '/opt/step/app/server/src/workspace/runtime-main.ts');
  assert.ok(tail.includes('file:///opt/step/app/server/src/register.mjs'));
  assert.ok(tail.some((a) => a.startsWith('file:///opt/step/app/node_modules/tsx/')));
});

test('an unsafe socket root fails closed before anything is spawned', async () => {
  const root = mkdtempSync(join(tmpdir(), 'step-socket-root-'));
  try {
    for (const mode of [0o777, 0o755, 0o733]) {
      chmodSync(root, mode);
      let spawned = false;
      await assert.rejects(
        stepRunnerDriver({ ...pure, socketRoot: root }).startWithAdmission(pureSpec, () => {
          spawned = true;
        }),
        { code: 'RUNTIME_START_FAILED', cause: 'SOCKET_ROOT_UNSAFE' },
      );
      assert.equal(spawned, false);
    }
    await assert.rejects(stepRunnerDriver({ ...pure, socketRoot: join(root, 'absent') }).start(pureSpec), {
      cause: 'SOCKET_ROOT_UNSAFE',
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('step-runner host driver', host, () => {
  let root = '';
  let options: StepRunnerOptions;
  let baseline = new Set<number>();
  const specs: RuntimeSpec[] = [];
  const runnerUid = enabled ? Number(execFileSync('id', ['-u', 'step-runner'], { encoding: 'utf8' })) : 0;

  const runnerPids = () =>
    parseRunnerPids(spawnSync('pgrep', ['-u', 'step-runner'], { encoding: 'utf8', timeout: 2_000 }));
  const strays = () => [...runnerPids()].filter((pid) => !baseline.has(pid));
  const units = () =>
    parseUnits(
      spawnSync('systemctl', ['--user', 'list-units', '--all', '--plain', '--no-legend', 'step-rt-*'], {
        encoding: 'utf8',
        timeout: 2_000,
      }),
    );
  const emptied = (cgroup: string) => {
    try {
      return readFileSync(join(cgroup, 'cgroup.events'), 'utf8').includes('populated 0');
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ENOENT';
    }
  };
  const procs = (cgroup: string) =>
    readFileSync(join(cgroup, 'cgroup.procs'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((pid) => {
        const read = (file: string) => {
          try {
            return readFileSync(`/proc/${pid}/${file}`, 'utf8');
          } catch {
            return '';
          }
        };
        return {
          pid: Number(pid),
          uid: Number(/^Uid:\s+(\d+)/m.exec(read('status'))?.[1]),
          cmdline: read('cmdline').split('\0').join(' '),
        };
      });
  // The node process itself (not systemd-run/sudo, whose command lines also name the entry).
  const isRuntime = (p: { cmdline: string }) =>
    p.cmdline.startsWith(options.nodePath + ' ') && p.cmdline.includes('runtime-main.ts');
  // A second, unconfined-by-PID step-runner bubblewrap sees host PIDs: the only way this account can be signalled.
  const signalAsRunner = (signal: string, pid: number) => {
    const sys = ['/usr', '/lib', '/lib64', '/bin', '/proc'].flatMap((p) => ['--ro-bind', p, p]);
    const result = spawnSync(
      'sudo',
      [
        '-n',
        '-u',
        'step-runner',
        '/usr/bin/bwrap',
        ...sys,
        '--dev',
        '/dev',
        '--',
        '/bin/kill',
        `-${signal}`,
        String(pid),
      ],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr);
  };
  const assertClean = async () => {
    for (let i = 0; i < 50 && (strays().length || units()); i++) await sleep(100);
    assert.deepEqual(strays(), [], 'no step-runner process outlives its runtime');
    assert.equal(units(), '', 'no step-rt scope unit remains');
    assert.deepEqual(readdirSync(options.socketRoot), [], 'every socket directory is removed');
  };
  const workspace = () => {
    const spec = workspacePaths(join(root, 'data'), 'alice', newWorkspaceId());
    mkdirSync(spec.filesDir, { recursive: true });
    // Disposable test only: production gives the workspace to a shared group in a root-run setup step.
    for (let dir = spec.filesDir; dir !== root; dir = dirname(dir)) chmodSync(dir, 0o755);
    chmodSync(spec.dir, 0o777);
    chmodSync(spec.filesDir, 0o777);
    specs.push(spec);
    return spec;
  };
  const live: StepRunnerHandle[] = [];
  // Every handle is remembered so a failing assertion can never leak a sandbox past the suite.
  const driver = (extra: Partial<StepRunnerOptions> = {}, hooks?: StepRunnerHooks) => {
    const d = stepRunnerDriver({ ...options, ...extra }, hooks);
    const track = (h: StepRunnerHandle) => (live.push(h), h);
    return {
      start: (spec: RuntimeSpec) =>
        d.start(spec).then(track, (error) => {
          if (error instanceof RuntimeStartCleanupError) track(error.handle as StepRunnerHandle);
          throw error;
        }),
      startWithAdmission: (spec: RuntimeSpec, admit: (spawn: () => void) => void) =>
        d.startWithAdmission(spec, admit).then(track),
    };
  };
  const exited = (handle: StepRunnerHandle) => new Promise<number | null>((done) => handle.onExit(done));
  const stopFailed = (error: unknown) =>
    error instanceof WorkspaceError && error.code === 'RUNTIME_STOP_FAILED';

  // Hostile local peers. Each runs as its own process and connects while the driver is blocked inside admission,
  // i.e. before the runtime is even spawned: the kernel queues the connection, so it is accepted first.
  const attackers: ChildProcess[] = [];
  const attack = (as: 'self' | 'runner', socketPath: string, mode: 'forge' | 'idle' | 'flood') => {
    const log = join(root, `attacker-${attackers.length}.log`);
    const fd = openSync(log, 'w', 0o666);
    chmodSync(log, 0o666);
    const node = [options.nodePath, join(root, 'attacker.cjs'), socketPath, mode];
    // "runner" is uid step-runner outside any sandbox: host filesystem and host /proc.
    const argv =
      as === 'self'
        ? node
        : [
            'sudo',
            '-n',
            '-u',
            'step-runner',
            '/usr/bin/bwrap',
            '--ro-bind',
            '/',
            '/',
            '--proc',
            '/proc',
            '--dev',
            '/dev',
            '--',
            ...node,
          ];
    const child = spawn(argv[0]!, argv.slice(1), { stdio: ['ignore', fd, fd] });
    closeSync(fd);
    attackers.push(child);
    const done = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    // Synchronous on purpose: the event loop must not run (and accept) until the attacker is connected.
    const waited = spawnSync(
      '/bin/sh',
      [
        '-c',
        'for i in $(seq 400); do grep -q "^connected" "$1" && exit 0; sleep 0.025; done; exit 1',
        'sh',
        log,
      ],
      { encoding: 'utf8' },
    );
    assert.equal(waited.status, 0, `attacker did not connect: ${readFileSync(log, 'utf8')}`);
    return {
      done,
      lines: () =>
        readFileSync(log, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((line) => (line === 'connected' ? line : JSON.parse(line))),
    };
  };

  before(() => {
    baseline = runnerPids();
    root = mkdtempSync('/mnt/step-work/step-driver-test-');
    chmodSync(root, 0o755);
    // step-runner cannot read /home/itsara: copy exactly what the sandbox binds into a world-readable place.
    const app = join(root, 'app');
    for (const part of ['node_modules', 'harness', 'server/src', 'server/package.json', 'package.json'])
      cpSync(join(REPO, part), join(app, part), { recursive: true, verbatimSymlinks: true });
    mkdirSync(join(app, 'server/src/test-entries'));
    for (const name of ['fake-sleeper', 'fake-wrong-nonce', 'fake-flood', 'fake-stubborn', 'fake-resources'])
      cpSync(
        join(REPO, 'server/test/support/step-runner-entry.mjs'),
        join(app, `server/src/test-entries/${name}.mjs`),
      );
    const nodePath = join(root, 'node/bin/node');
    mkdirSync(dirname(nodePath), { recursive: true });
    cpSync(process.execPath, nodePath);
    execFileSync('chmod', ['-R', 'a+rX', root]);
    mkdirSync(join(root, 'sockets'), { mode: 0o711 });
    chmodSync(join(root, 'sockets'), 0o711);
    writeFileSync(
      join(root, 'attacker.cjs'),
      `const net = require('node:net');
const [path, mode] = process.argv.slice(2);
const out = (v) => process.stdout.write((typeof v === 'string' ? v : JSON.stringify(v)) + '\\n');
const forged = JSON.stringify({ type: 'ready', launchNonce: '0'.repeat(64) }) + '\\n';
const count = mode === 'flood' ? 40 : 1;
let connected = 0, closed = 0, received = 0;
for (let i = 0; i < count; i++) {
  const s = net.connect(path);
  s.on('connect', () => {
    if (mode !== 'idle') s.write(forged);
    if (++connected === count) out('connected');
  });
  s.on('data', (c) => (received += c.length));
  s.on('error', (e) => out({ error: e.code }));
  s.on('close', () => {
    if (++closed === count) {
      out({ closed: true, received });
      process.exit(0);
    }
  });
}
setTimeout(() => (out({ timeout: true, received }), process.exit(0)), 30000);
`,
      { mode: 0o644 },
    );
    options = {
      appRoot: app,
      nodePath,
      socketRoot: join(root, 'sockets'),
      runnerUid,
      memoryMaxBytes: 1024 * 1024 * 1024,
      tasksMax: 128,
      cpuQuotaPercent: 100,
      startTimeoutMs: 60_000,
      stopTimeoutMs: 3_000,
    };
  });

  after(async () => {
    for (const child of attackers) child.kill('SIGKILL');
    await Promise.allSettled(live.map((h) => h.stop()));
    // Runtime files belong to step-runner; only that account can remove them from the shared test folders.
    for (const spec of specs)
      spawnSync('sudo', [
        '-n',
        '-u',
        'step-runner',
        '/usr/bin/bwrap',
        ...['/usr', '/lib', '/lib64', '/bin'].flatMap((p) => ['--ro-bind', p, p]),
        '--bind',
        spec.dir,
        '/w',
        '--',
        '/usr/bin/find',
        '/w',
        '-mindepth',
        '1',
        '-delete',
      ]);
    if (root) rmSync(root, { recursive: true, force: true });
    assert.equal(existsSync(root), false);
    assert.deepEqual(strays(), []);
    assert.equal(units(), '');
  });

  test('runtime runs as step-runner inside its scope and answers calls', async () => {
    const spec = workspace();
    const handle = await driver().start(spec);
    const exit = exited(handle);
    try {
      const runtime = procs(handle.scope.cgroupPath).find((p) => isRuntime(p));
      assert.ok(runtime, 'runtime process is inside the scope');
      assert.equal(runtime.uid, runnerUid);
      assert.equal(handle.scope.peerUid, runnerUid);
      const health = await handle.health();
      assert.equal(health.ok, true);
      assert.equal(health.workspaceId, spec.workspaceId);
      assert.equal(health.cwd, spec.filesDir);
      await handle.call('connect', { baseUrl: 'https://provider.invalid/v1', model: 'synthetic' });
      const answer = await handle.call('ask', { text: 'ช่วยคิดชื่องานสัมมนาให้หน่อย' });
      assert.equal(answer.status, 'review');
      assert.equal(answer.answer, 'คำตอบจำลองจาก Desktop engine');
    } finally {
      await handle.stop();
    }
    assert.equal(emptied(handle.scope.cgroupPath), true);
    await exit;
    await assertClean();
  });

  test('limits are applied to the scope cgroup', async () => {
    const handle = await driver({
      memoryMaxBytes: 768 * 1024 * 1024,
      tasksMax: 96,
      cpuQuotaPercent: 50,
    }).start(workspace());
    try {
      const read = (file: string) => readFileSync(join(handle.scope.cgroupPath, file), 'utf8').trim();
      assert.match(handle.scope.cgroupPath, new RegExp(`/${handle.scope.unit.replaceAll('.', '\\.')}$`));
      assert.equal(read('memory.max'), String(768 * 1024 * 1024));
      assert.equal(read('pids.max'), '96');
      assert.equal(read('cpu.max'), '50000 100000');
      assert.equal(read('memory.swap.max'), '0');
    } finally {
      await handle.stop();
    }
    await assertClean();
  });

  test(
    'bounded memory exhaustion: kernel enforces MemoryMax and the workspace recovers',
    { timeout: 60_000 },
    async () => {
      const spec = workspace();
      const handle = await driver({
        entry: 'server/src/test-entries/fake-resources.mjs',
        memoryMaxBytes: 192 * 1024 * 1024,
        tasksMax: 32,
        cpuQuotaPercent: 50,
        startTimeoutMs: 10_000,
        stopTimeoutMs: 1_000,
      }).start(spec);
      const watchdog = setTimeout(() => void handle.stop().catch(() => {}), 15_000);
      try {
        // Never arm pressure based on requested options alone: read the kernel's effective hard limits first.
        const read = (name: string) => readFileSync(join(handle.scope.cgroupPath, name), 'utf8').trim();
        assert.equal(read('memory.max'), '201326592');
        assert.equal(read('memory.swap.max'), '0');
        assert.equal(read('pids.max'), '32');
        // Refuse to arm if this host cannot supply durable kernel evidence after systemd collects the scope.
        const kernelLog = () =>
          spawnSync(
            'journalctl',
            [
              '--dmesg',
              '--no-pager',
              '--output=cat',
              '--lines=1',
              `--grep=oom_memcg=${handle.scope.cgroupPath.slice('/sys/fs/cgroup'.length)},`,
            ],
            { encoding: 'utf8', timeout: 2_000 },
          );
        assert.equal(
          spawnSync('journalctl', ['--dmesg', '--no-pager', '--lines=1'], {
            encoding: 'utf8',
            timeout: 2_000,
          }).status,
          0,
          'read access to the kernel journal is required',
        );
        // Both behaviors are valid: the worker alone dies, or systemd ends the scope after the kernel OOM.
        const outcome = await handle.call('ask', { text: 'bounded-memory-pressure' }).then(
          (result) => result,
          (error: unknown) => {
            assert.ok(error instanceof WorkspaceError);
            assert.equal(error.code, 'RUNTIME_EXITED');
            return 'scope-exited';
          },
        );
        if (outcome !== 'scope-exited') assert.deepEqual(outcome, { code: null, signal: 'SIGKILL' });
        let evidence = '';
        for (let i = 0; i < 20; i++) {
          const log = kernelLog();
          assert.ok(log.status === 0 || (log.status === 1 && log.stderr === ''), log.stderr);
          evidence = log.stdout;
          if (evidence.includes('constraint=CONSTRAINT_MEMCG')) break;
          await sleep(50);
        }
        assert.ok(
          evidence.includes('constraint=CONSTRAINT_MEMCG'),
          'kernel reports a cgroup OOM, not host OOM',
        );
        assert.ok(evidence.includes(`oom_memcg=${handle.scope.cgroupPath.slice('/sys/fs/cgroup'.length)},`));
      } finally {
        clearTimeout(watchdog);
        await handle.stop();
      }
      assert.equal(emptied(handle.scope.cgroupPath), true);
      await assertClean();
      const recovered = await driver().start(spec);
      try {
        assert.notEqual(recovered.scope.unit, handle.scope.unit);
        assert.equal((await recovered.health()).workspaceId, spec.workspaceId);
        await recovered.call('connect', { baseUrl: 'https://provider.invalid/v1', model: 'synthetic' });
        assert.equal(
          (await recovered.call('ask', { text: 'synthetic recovery after OOM' })).status,
          'review',
        );
      } finally {
        await recovered.stop();
      }
      await assertClean();
    },
  );

  test(
    'bounded task exhaustion: TasksMax rejects spawning and capacity recovers',
    { timeout: 60_000 },
    async () => {
      const spec = workspace();
      const handle = await driver({
        entry: 'server/src/test-entries/fake-resources.mjs',
        memoryMaxBytes: 192 * 1024 * 1024,
        tasksMax: 32,
        cpuQuotaPercent: 50,
        startTimeoutMs: 10_000,
        stopTimeoutMs: 1_000,
      }).start(spec);
      const watchdog = setTimeout(() => void handle.stop().catch(() => {}), 15_000);
      try {
        const read = (name: string) => readFileSync(join(handle.scope.cgroupPath, name), 'utf8').trim();
        assert.equal(read('memory.max'), '201326592');
        assert.equal(read('memory.swap.max'), '0');
        assert.equal(read('pids.max'), '32');
        const counter = () => Number(/^max (\d+)$/m.exec(read('pids.events'))?.[1]);
        const before = counter();
        assert.ok(Number.isSafeInteger(before));
        const baselineTasks = Number(read('pids.current'));
        const result = await handle.call('ask', { text: 'bounded-task-pressure' });
        assert.equal((result as unknown as { denied: string }).denied, 'EAGAIN');
        assert.ok(counter() > before, 'kernel task denial counter increases in this scope');
        const current = Number(read('pids.current'));
        assert.ok(current > baselineTasks && current <= 32, `effective task usage ${current}`);
        assert.equal((await handle.health()).ok, true, 'IPC survives task exhaustion');
        await handle.call('conversations', {}); // Stop and reap the fixture's children through the RuntimeHandle seam.
        assert.ok(Number(read('pids.current')) <= baselineTasks, 'task slots are released');
        assert.deepEqual(await handle.call('ask', { text: 'bounded-task-recovery' }), {
          code: 0,
          signal: null,
        });
      } finally {
        clearTimeout(watchdog);
        await handle.stop();
      }
      assert.equal(emptied(handle.scope.cgroupPath), true);
      await assertClean();
      const recovered = await driver().start(spec);
      try {
        assert.notEqual(recovered.scope.unit, handle.scope.unit);
        assert.equal((await recovered.health()).workspaceId, spec.workspaceId);
      } finally {
        await recovered.stop();
      }
      await assertClean();
    },
  );

  test(
    'bounded CPU enforcement: effective quota throttles one finite worker and the workspace recovers',
    { timeout: 60_000 },
    async (t) => {
      // Explicit refusal, not a skip/pass, if this opt-in host is busy or short of headroom.
      const preflight = async () => {
        const mem = readFileSync('/proc/meminfo', 'utf8');
        assert.ok(
          Number(/^MemAvailable:\s+(\d+) kB$/m.exec(mem)?.[1]) >= 2 * 1024 * 1024,
          'CPU acceptance requires 2 GiB available host memory',
        );
        assert.ok(
          Number(readFileSync('/proc/loadavg', 'utf8').split(' ')[0]) < 1,
          'CPU acceptance requires one-minute host load below 1',
        );
        const threads = readdirSync('/proc')
          .filter((p) => /^\d+$/.test(p))
          .reduce((sum, pid) => {
            try {
              return (
                sum + Number(/^Threads:\s+(\d+)$/m.exec(readFileSync(`/proc/${pid}/status`, 'utf8'))?.[1])
              );
            } catch (error) {
              if (
                (error as NodeJS.ErrnoException).code === 'ENOENT' ||
                (error as NodeJS.ErrnoException).code === 'ESRCH'
              )
                return sum;
              throw error;
            }
          }, 0);
        assert.ok(Number.isSafeInteger(threads));
        assert.ok(
          Number(readFileSync('/proc/sys/kernel/threads-max', 'utf8')) - threads >= 256,
          'CPU acceptance requires 256 spare host task slots',
        );
        const ticks = () => {
          const values = readFileSync('/proc/stat', 'utf8')
            .split('\n')[0]!
            .trim()
            .split(/\s+/)
            .slice(1, 9)
            .map(Number);
          return { total: values.reduce((sum, n) => sum + n, 0), idle: values[3]! };
        };
        const a = ticks();
        await sleep(500);
        const b = ticks();
        assert.ok(
          b.total > a.total && (b.idle - a.idle) / (b.total - a.total) >= 0.8,
          'CPU acceptance requires at least 80% sampled host CPU idle',
        );
      };
      await preflight();
      const spec = workspace();
      const handle = await driver({
        entry: 'server/src/test-entries/fake-resources.mjs',
        memoryMaxBytes: 192 * 1024 * 1024,
        tasksMax: 32,
        cpuQuotaPercent: 25,
        startTimeoutMs: 10_000,
        stopTimeoutMs: 1_000,
      }).start(spec);
      const watchdog = setTimeout(() => void handle.stop().catch(() => {}), 10_000);
      try {
        const read = (name: string) => readFileSync(join(handle.scope.cgroupPath, name), 'utf8').trim();
        assert.equal(read('memory.max'), '201326592');
        assert.equal(read('memory.swap.max'), '0');
        assert.equal(read('pids.max'), '32');
        // Kernel state, not the requested CPUQuota property, authorizes arming the finite worker.
        assert.equal(read('cpu.max'), '25000 100000');
        await preflight();
        const stat = () => {
          const values = Object.fromEntries(
            read('cpu.stat')
              .split('\n')
              .map((line) => line.split(/\s+/)),
          );
          const result = Object.fromEntries(
            ['usage_usec', 'nr_periods', 'nr_throttled', 'throttled_usec'].map((key) => [
              key,
              Number(values[key]),
            ]),
          );
          for (const value of Object.values(result)) assert.ok(Number.isSafeInteger(value) && value >= 0);
          return result;
        };
        const before = stat();
        const result = await handle.call('ask', { text: 'bounded-cpu-pressure' });
        assert.deepEqual(result, { code: 0, signal: null });
        const after = stat();
        const delta = Object.fromEntries(Object.keys(before).map((key) => [key, after[key]! - before[key]!]));
        t.diagnostic(
          JSON.stringify({ cgroup: handle.scope.cgroupPath, cpuMax: read('cpu.max'), before, after, delta }),
        );
        assert.equal(read('cpu.max'), '25000 100000');
        assert.ok(delta.usage_usec! >= 100_000, 'scope consumed actual CPU during the worker');
        assert.ok(delta.nr_periods! >= 3, 'multiple quota periods elapsed');
        assert.ok(delta.nr_throttled! >= 3, 'kernel throttled this exact scope in multiple periods');
        assert.ok(delta.throttled_usec! > 0, 'kernel recorded throttled CPU time, not just wall time');
        assert.equal((await handle.health()).ok, true, 'IPC survives CPU throttling');
      } finally {
        clearTimeout(watchdog);
        await handle.stop();
        assert.equal(emptied(handle.scope.cgroupPath), true);
        await assertClean(); // Also prove cleanup when an enforcement assertion fails.
      }
      const recovered = await driver().start(spec);
      try {
        assert.notEqual(recovered.scope.unit, handle.scope.unit);
        assert.equal((await recovered.health()).workspaceId, spec.workspaceId);
        await recovered.call('connect', { baseUrl: 'https://provider.invalid/v1', model: 'synthetic' });
        assert.equal(
          (await recovered.call('ask', { text: 'synthetic recovery after CPU throttling' })).status,
          'review',
        );
      } finally {
        await recovered.stop();
      }
      await assertClean();
    },
  );

  test('a second workspace sandbox cannot see the first one’s socket or files', async () => {
    const a = workspace();
    const b = workspace();
    const d = driver();
    const first = await d.start(a);
    const second = await d.start(b);
    try {
      assert.notEqual(first.scope.socketDir, second.scope.socketDir);
      assert.notEqual(first.scope.unit, second.scope.unit);
      const script = `const fs=require('node:fs');const net=require('node:net');const seen=p=>{try{fs.statSync(p);return true}catch{return false}};const out={uid:process.getuid(),own:seen(${JSON.stringify(b.dir)}),ownSocketDir:seen('/run/step-runtime'),ownSocket:seen('/run/step-runtime/rt.sock'),other:seen(${JSON.stringify(a.dir)}),otherSocketDir:seen(${JSON.stringify(first.scope.socketDir)}),socketRoot:seen(${JSON.stringify(options.socketRoot)}),home:seen('/home/itsara')};const s=net.connect(${JSON.stringify(join(first.scope.socketDir, 'rt.sock'))});s.on('connect',()=>{out.connected=true;console.log(JSON.stringify(out));s.destroy()});s.on('error',()=>{out.connected=false;console.log(JSON.stringify(out))});`;
      const args = stepRunnerSandboxArgs(b, {
        ...options,
        socketDir: second.scope.socketDir,
        env: { PATH: '/usr/bin:/bin' },
      });
      const probe = spawnSync(
        'sudo',
        ['-n', '-u', 'step-runner', '/usr/bin/bwrap', ...args, '--', options.nodePath, '-e', script],
        { encoding: 'utf8', timeout: 20_000 },
      );
      assert.equal(probe.status, 0, probe.stderr);
      assert.deepEqual(JSON.parse(probe.stdout), {
        uid: runnerUid,
        own: true,
        ownSocketDir: true,
        // The listener accepted its one connection, closed, and Node unlinked the path: nobody can connect again.
        ownSocket: false,
        other: false,
        otherSocketDir: false,
        socketRoot: false,
        home: false,
        connected: false,
      });
      // The running sandboxes themselves: each mount table names only its own workspace and socket folder.
      for (const [self, other, otherHandle] of [
        [first, b, second],
        [second, a, first],
      ] as const) {
        const runtime = procs(self.scope.cgroupPath).find((p) => isRuntime(p))!;
        const mounts = readFileSync(`/proc/${runtime.pid}/mountinfo`, 'utf8');
        assert.ok(!mounts.includes(other.dir));
        assert.ok(!mounts.includes(otherHandle.scope.socketDir.split('/').at(-1)!));
      }
      assert.equal((await first.health()).workspaceId, a.workspaceId);
      assert.equal((await second.health()).workspaceId, b.workspaceId);
    } finally {
      await Promise.all([first.stop(), second.stop()]);
    }
    await assertClean();
  });

  test('hostile peers that connect first (uid 1000, out-of-sandbox step-runner) get nothing; the start succeeds', async () => {
    const spec = workspace();
    let hostile: ReturnType<typeof attack>[] = [];
    const handle = await driver().startWithAdmission(spec, (spawnRuntime) => {
      const dir = readdirSync(options.socketRoot).find((d) =>
        existsSync(join(options.socketRoot, d, 'rt.sock')),
      );
      assert.ok(dir, 'socket is listening before the spawn');
      const socketPath = join(options.socketRoot, dir, 'rt.sock');
      hostile = [
        // This test process's uid: refused by SO_PEERCRED before a single byte is read.
        attack('self', socketPath, 'forge'),
        // uid step-runner outside the sandbox (it can read the path from /proc): passes the uid check, has no nonce.
        attack('runner', socketPath, 'forge'),
        // ... and one that never sends a frame: it must not block the genuine runtime.
        attack('runner', socketPath, 'idle'),
      ];
      spawnRuntime();
    });
    try {
      await Promise.all(hostile.map((h) => h.done));
      // Dropped unread, so the kernel may report a reset: that is fine, a reply is not.
      for (const h of hostile)
        assert.deepEqual(
          h.lines().filter((l) => !['ECONNRESET', 'EPIPE'].includes(l.error)),
          ['connected', { closed: true, received: 0 }],
        );
      assert.equal(handle.scope.peerUid, runnerUid);
      const health = await handle.health();
      assert.equal(health.ok, true);
      assert.equal(health.workspaceId, spec.workspaceId);
      // Exactly one peer is accepted, then the listener closes and its path is gone.
      assert.equal(existsSync(join(handle.scope.socketDir, 'rt.sock')), false);
    } finally {
      await handle.stop();
    }
    await assertClean();
  });

  test('a flood of rejected peers is bounded: the start fails closed instead of checking forever', async () => {
    const start = driver().startWithAdmission(workspace(), (spawnRuntime) => {
      const dir = readdirSync(options.socketRoot).find((d) =>
        existsSync(join(options.socketRoot, d, 'rt.sock')),
      );
      attack('self', join(options.socketRoot, dir!, 'rt.sock'), 'flood');
      spawnRuntime();
    });
    await assert.rejects(start, { code: 'RUNTIME_START_FAILED', cause: 'TOO_MANY_REJECTED_PEERS' });
    await assertClean();
  });

  test('a step-runner peer with the wrong launch nonce is rejected and killed', async () => {
    await assert.rejects(
      driver({ entry: 'server/src/test-entries/fake-wrong-nonce.mjs' }).start(workspace()),
      { code: 'RUNTIME_START_FAILED', cause: 'NONCE_MISMATCH' },
    );
    await assertClean();
  });

  test('an oversized frame is rejected and the sandbox is killed', async () => {
    await assert.rejects(
      driver({ entry: 'server/src/test-entries/fake-flood.mjs', maxFrameBytes: 1024 * 1024 }).start(
        workspace(),
      ),
      { code: 'RUNTIME_START_FAILED', cause: 'FRAME_TOO_LARGE' },
    );
    await assertClean();
  });

  test('stop kills a detached TERM-ignoring descendant with cgroup.kill and proves emptiness', async () => {
    const handle = await driver({
      entry: 'server/src/test-entries/fake-stubborn.mjs',
      stopTimeoutMs: 500,
    }).start(workspace());
    const inside = procs(handle.scope.cgroupPath);
    const descendant = inside.find((p) => p.cmdline.startsWith('/bin/sh -c trap'));
    assert.ok(descendant, JSON.stringify(inside));
    assert.equal(descendant.uid, runnerUid);
    assert.equal((await handle.health()).ok, true);
    // The account boundary is real: this uid cannot signal step-runner processes at all.
    assert.throws(() => process.kill(descendant.pid, 'SIGTERM'), { code: 'EPERM' });
    const exit = exited(handle);
    await handle.stop();
    assert.equal(emptied(handle.scope.cgroupPath), true);
    assert.equal(existsSync(`/proc/${descendant.pid}`), false);
    await exit;
    await assertClean();
  });

  test('a crashed runtime surfaces RUNTIME_EXITED and its scope is emptied', async () => {
    const handle = await driver().start(workspace());
    const runtime = procs(handle.scope.cgroupPath).find((p) => isRuntime(p))!;
    const exit = exited(handle);
    signalAsRunner('STOP', runtime.pid);
    const pending = handle.call('conversations', {});
    const outcome = assert.rejects(pending, { code: 'RUNTIME_EXITED' });
    await sleep(100);
    signalAsRunner('KILL', runtime.pid);
    await outcome;
    await exit;
    assert.equal(emptied(handle.scope.cgroupPath), true);
    await assert.rejects(handle.call('conversations', {}), { code: 'RUNTIME_NOT_RUNNING' });
    assert.equal((await handle.health()).ok, false);
    await handle.stop();
    await assertClean();
  });

  test('admission: skipped or failing admission never leaves a runtime behind', async () => {
    const d = driver();
    const spec = workspace();
    let late!: () => void;
    await assert.rejects(
      d.startWithAdmission(spec, (spawn) => {
        late = spawn;
      }),
      /RUNTIME_START_ADMISSION_SKIPPED/,
    );
    assert.throws(late, /RUNTIME_START_ADMISSION_REPEATED/);
    await assertClean();
    await assert.rejects(
      d.startWithAdmission(spec, () => {
        throw new Error('UNAUTHENTICATED');
      }),
      /UNAUTHENTICATED/,
    );
    await assertClean();
    // Revocation that commits after the spawn: the admission error wins and the spawned sandbox is killed.
    const revoked = new Error('REVOKED_AFTER_SPAWN');
    let spawned = false;
    await assert.rejects(
      d.startWithAdmission(spec, (spawn) => {
        spawn();
        spawned = true;
        throw revoked;
      }),
      (error) => error === revoked,
    );
    assert.equal(spawned, true);
    await assertClean();
  });

  test('admission: a denied stop leaves the runtime running; an admitted stop proves it gone', async () => {
    const handle = await driver().start(workspace());
    await assert.rejects(
      handle.stopWithAdmission!(() => {
        throw new Error('denied');
      }),
      /denied/,
    );
    assert.equal((await handle.health()).ok, true);
    let inside = false;
    const exit = exited(handle);
    await handle.stopWithAdmission!((signal) => {
      inside = true;
      signal();
    });
    assert.equal(inside, true);
    assert.equal(emptied(handle.scope.cgroupPath), true);
    await exit;
    await assertClean();
  });

  test('a failing cgroup.kill is RUNTIME_STOP_FAILED (never a raw error) and a later stop retries', async () => {
    let deny = true;
    const handle = await driver(
      { entry: 'server/src/test-entries/fake-stubborn.mjs', stopTimeoutMs: 500 },
      {
        writeCgroupFile: (path, data) => {
          if (deny) throw Object.assign(new Error('synthetic EACCES'), { code: 'EACCES' });
          writeFileSync(path, data);
        },
      },
    ).start(workspace());
    let fired = false;
    handle.onExit(() => (fired = true));
    await assert.rejects(handle.stop(), stopFailed);
    // The channel is gone now, so this stop writes cgroup.kill inside the admission callback itself.
    await assert.rejects(
      handle.stopWithAdmission!((signal) => signal()),
      stopFailed,
    );
    assert.equal(emptied(handle.scope.cgroupPath), false);
    assert.equal(fired, false, 'no exit is reported without proof');
    deny = false;
    await handle.stop();
    assert.equal(emptied(handle.scope.cgroupPath), true);
    assert.equal(fired, true);
    await assertClean();
  });

  test('a failing `systemctl show` is unknown, never "gone": the start reports a cleanup failure', async () => {
    let failShow = true;
    const error = await driver(
      { entry: 'server/src/test-entries/fake-wrong-nonce.mjs', stopTimeoutMs: 1_000 },
      {
        systemctl: (args, real) =>
          failShow && args[0] === 'show' ? Promise.resolve({ code: 1, stdout: '' }) : real(args),
      },
    )
      .start(workspace())
      .then(
        () => assert.fail('start must fail'),
        (e: unknown) => e,
      );
    assert.ok(error instanceof RuntimeStartCleanupError, String(error));
    failShow = false;
    await (error.handle as StepRunnerHandle).stop();
    await assertClean();
  });

  test('failed systemctl stop/reset-failed are surfaced on the scope; the runtime is still proven stopped', async () => {
    let fail = false;
    const handle = await driver(
      {},
      {
        systemctl: (args, real) => (fail ? Promise.resolve({ code: 1, stdout: '' }) : real(args)),
      },
    ).start(workspace());
    const exit = exited(handle);
    fail = true;
    await handle.stop();
    await exit;
    assert.equal(emptied(handle.scope.cgroupPath), true);
    assert.equal(handle.scope.unitCleanup, 'failed');
    assert.ok(handle.scope.unitCleanupFailures?.some((f) => f.startsWith('stop')));
    assert.ok(handle.scope.unitCleanupFailures?.some((f) => f.startsWith('reset-failed')));
    fail = false;
    await handle.stop();
    assert.equal(handle.scope.unitCleanup, 'done');
    await assertClean();
  });

  test('a crash whose emptiness proof fails keeps the handle: onExit waits and a later stop retries', async () => {
    let blind = false;
    const handle = await driver(
      { stopTimeoutMs: 500 },
      {
        readCgroupFile: (path) =>
          blind ? Promise.resolve('populated 1\nfrozen 0\n') : readFile(path, 'utf8'),
      },
    ).start(workspace());
    const runtime = procs(handle.scope.cgroupPath).find((p) => isRuntime(p))!;
    let fired = false;
    handle.onExit(() => (fired = true));
    blind = true;
    signalAsRunner('STOP', runtime.pid);
    const pending = handle.call('conversations', {});
    await sleep(100);
    signalAsRunner('KILL', runtime.pid);
    await assert.rejects(pending, { code: 'RUNTIME_EXITED' });
    await sleep(1_500);
    assert.equal(fired, false, 'no exit is reported without proof');
    await assert.rejects(handle.call('conversations', {}), { code: 'RUNTIME_NOT_RUNNING' });
    blind = false;
    await handle.stop();
    assert.equal(fired, true);
    assert.equal(emptied(handle.scope.cgroupPath), true);
    await assertClean();
  });
});
