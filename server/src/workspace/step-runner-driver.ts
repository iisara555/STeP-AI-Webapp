// Step-runner driver: each Workspace runtime runs as the unprivileged `step-runner` account, inside Bubblewrap,
// inside its own systemd user scope with memory, task and CPU limits. Synthetic providers only (like processDriver
// isolated mode): this driver is not wired into the Gateway entry, which stays fail-closed.
//
// Host facts this relies on (spikes/057-step-runner-sudo): the service account may run only `/usr/bin/bwrap` as
// step-runner through `sudo -n`; sudo-rs passes neither the environment nor fd 3, so the channel is a Unix socket in
// a fresh random directory that is bound into this one sandbox only. The directory name is NOT secret: it appears in
// the systemd-run/sudo/bwrap command lines, which every local user can read through /proc. Until the socket root can
// be made 0700 with a group or ACL for step-runner (needs a host change), anyone local can connect, so the listener
// treats every connection as hostile: SO_PEERCRED must be uid step-runner before a byte is read, and the first frame
// must echo an unguessable per-launch nonce the runtime received on stdin (never argv or environment). Refused peers
// are dropped without a reply while the driver keeps waiting for the genuine runtime, within bounds.
// `systemctl --user stop` cannot signal step-runner, so a stop is: graceful request over the socket, then
// cgroup.kill on the scope, then proof that the scope is empty.
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import net from 'node:net';
import { dirname, isAbsolute, join, normalize, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  RuntimeStartCleanupError,
  WorkspaceError,
  type RuntimeCalls,
  type RuntimeDriver,
  type RuntimeEvent,
  type RuntimeHandle,
  type RuntimeHealth,
  type RuntimeSpec,
} from './contract.ts';
import { DEFAULT_MAX_FRAME_BYTES, encodeFrame, frameReader } from './frames.ts';
import { authenticateRuntimePeer } from './unix-channel.ts';
import {
  REPO_ROOT,
  runtimeEnv,
  sandboxMounts,
  validateTmpfsBytes,
  type RuntimeReply,
  type RuntimeRequest,
} from './process-driver.ts';

/** Where the per-launch socket directory appears inside the sandbox. */
export const SANDBOX_SOCKET_DIR = '/run/step-runtime';
const SOCKET_NAME = 'rt.sock';
const DEFAULT_ENTRY = 'server/src/workspace/runtime-main.ts';
const TSX = relative(REPO_ROOT, fileURLToPath(import.meta.resolve('tsx')));
// Node has no API for SO_PEERCRED; a one-line Python helper reads it from the accepted socket handed over as stdin.
const PEERCRED = `import socket,struct;s=socket.socket(fileno=0);print(*struct.unpack('3i',s.getsockopt(socket.SOL_SOCKET,socket.SO_PEERCRED,12)));s.detach()`;
/** Connections waiting for their credential check or first frame; more are dropped unread. */
export const MAX_PENDING_PEERS = 8;
/** Refused connections per launch before the start fails closed (each costs a credential helper). */
export const MAX_REJECTED_PEERS = 32;
/** The first frame is only `ready` + nonce: a peer not yet trusted may not buffer more than this. */
const MAX_FIRST_FRAME_BYTES = 4096;

export type StepRunnerOptions = {
  /** Explicit compatibility mode for older nonce-only fixtures; synthetic assembly uses authenticated. */
  transport?: 'nonce' | 'authenticated';
  /** World-readable copy of the app (node_modules, harness, server/src, package.json files); never under /home. */
  appRoot: string;
  /** Node binary the runtime runs with; its directory is bound read-only. */
  nodePath: string;
  /** Directory (owner-only write, mode 0711) holding one random socket directory per launch. The names are visible
   * in /proc to every local user; 0700 + group/ACL for step-runner is pending a host change. */
  socketRoot: string;
  /** Numeric uid of the runner account; peers with any other uid are refused. */
  runnerUid: number;
  runnerUser?: string;
  memoryMaxBytes: number;
  tasksMax: number;
  cpuQuotaPercent: number;
  startTimeoutMs?: number;
  /** Grace for a graceful shutdown, and separately the bound on proving the scope empty after cgroup.kill. */
  stopTimeoutMs?: number;
  maxFrameBytes?: number;
  tmpfsBytes?: number;
  /** Runtime entry, relative to appRoot and under server/src (tests use synthetic stand-ins). */
  entry?: string;
  python?: string;
};

export type StepRunnerScope = {
  unit: string;
  cgroupPath: string;
  socketDir: string;
  peerUid: number;
  /** Removal of the systemd unit after the processes are proven gone. 'failed' never means the runtime may still
   * run (that is RUNTIME_STOP_FAILED); it means the unit may linger. A later stop() retries it. */
  unitCleanup: 'pending' | 'done' | 'failed';
  unitCleanupFailures?: string[];
};
type CommandResult = { code: number; stdout: string };
/** Host operations, replaceable for fault-injection tests only; never derived from configuration. */
export type StepRunnerHooks = {
  /** Arguments after `systemctl --user`; `real` runs the actual command. */
  systemctl?: (args: string[], real: (args: string[]) => Promise<CommandResult>) => Promise<CommandResult>;
  writeCgroupFile?: (path: string, data: string) => void;
  readCgroupFile?: (path: string) => Promise<string>;
};
export type StepRunnerHandle = RuntimeHandle & { scope: StepRunnerScope };
export type StepRunnerDriver = {
  start(spec: RuntimeSpec): Promise<StepRunnerHandle>;
  startWithAdmission(spec: RuntimeSpec, admit: (spawn: () => void) => void): Promise<StepRunnerHandle>;
};
type Launch = { unit: string; socketDir: string };

const invalid = (): never => {
  throw new Error('INVALID_STEP_RUNNER_OPTIONS');
};
const intIn = (value: unknown, min: number, max: number) =>
  Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max;
const absolute = (path: unknown) =>
  typeof path === 'string' && isAbsolute(path) && normalize(path) === path && path !== '/';

function validate(options: StepRunnerOptions) {
  const o = options ?? invalid();
  if (o.transport !== undefined && !['nonce', 'authenticated'].includes(o.transport)) invalid();
  if (o.transport === 'authenticated' && o.maxFrameBytes !== undefined && o.maxFrameBytes !== 1024 * 1024)
    invalid();
  if (!absolute(o.appRoot) || !absolute(o.nodePath) || !absolute(o.socketRoot)) invalid();
  if (!intIn(o.runnerUid, 1, 2 ** 31 - 2) || o.runnerUid === process.getuid?.()) invalid();
  if (o.runnerUser !== undefined && !/^[a-z_][a-z0-9_-]{0,31}$/.test(o.runnerUser)) invalid();
  if (!intIn(o.memoryMaxBytes, 16 * 1024 * 1024, Number.MAX_SAFE_INTEGER)) invalid();
  if (!intIn(o.tasksMax, 1, 100_000) || !intIn(o.cpuQuotaPercent, 1, 10_000)) invalid();
  if (o.maxFrameBytes !== undefined && !intIn(o.maxFrameBytes, 64 * 1024, 256 * 1024 * 1024)) invalid();
  for (const t of [o.startTimeoutMs, o.stopTimeoutMs])
    if (t !== undefined && !intIn(t, 1, 600_000)) invalid();
  const entry = o.entry ?? DEFAULT_ENTRY;
  if (isAbsolute(entry) || normalize(entry) !== entry || !entry.startsWith('server/src/')) invalid();
  if (o.python !== undefined && !absolute(o.python)) invalid();
  try {
    validateTmpfsBytes(o.tmpfsBytes);
  } catch {
    invalid();
  }
}

/** Bubblewrap options for one step-runner sandbox: cleared environment, the shared mounts and its socket folder. */
export function stepRunnerSandboxArgs(
  spec: RuntimeSpec,
  o: Pick<StepRunnerOptions, 'appRoot' | 'nodePath' | 'tmpfsBytes'> & {
    socketDir: string;
    env: Record<string, string>;
  },
): string[] {
  const mounts = sandboxMounts(spec, {
    appRoot: o.appRoot,
    nodeDir: dirname(o.nodePath),
    tmpfsBytes: o.tmpfsBytes,
  });
  return [
    '--clearenv',
    ...Object.entries(o.env).flatMap(([key, value]) => ['--setenv', key, value]),
    ...(mounts.includes('--cap-drop') ? [] : ['--cap-drop', 'ALL']),
    ...mounts,
    // Read-only: the runtime can connect to the socket but cannot create anything beside it.
    '--ro-bind',
    o.socketDir,
    SANDBOX_SOCKET_DIR,
  ];
}

/** The whole launch: a fresh scope with limits, sudo to the runner account (bwrap only), then the runtime. */
export function stepRunnerCommand(spec: RuntimeSpec, o: StepRunnerOptions, launch: Launch): string[] {
  const env = {
    ...runtimeEnv(spec),
    STEP_SYNTHETIC_PROVIDER: '1',
    ...(o.transport === 'authenticated'
      ? { STEP_RUNTIME_TRANSPORT: 'unix' }
      : { STEP_RUNTIME_SOCKET: `${SANDBOX_SOCKET_DIR}/${SOCKET_NAME}` }),
  };
  return [
    'systemd-run',
    '--user',
    '--scope',
    '--quiet',
    `--unit=${launch.unit}`,
    '-p',
    `MemoryMax=${o.memoryMaxBytes}`,
    '-p',
    'MemorySwapMax=0',
    '-p',
    `TasksMax=${o.tasksMax}`,
    '-p',
    `CPUQuota=${o.cpuQuotaPercent}%`,
    '--',
    'sudo',
    '-n',
    '-u',
    o.runnerUser ?? 'step-runner',
    '/usr/bin/bwrap',
    ...stepRunnerSandboxArgs(spec, { ...o, socketDir: launch.socketDir, env }),
    '--',
    o.nodePath,
    '--import',
    pathToFileURL(join(o.appRoot, TSX)).href,
    '--import',
    pathToFileURL(join(o.appRoot, 'server/src/register.mjs')).href,
    join(o.appRoot, o.entry ?? DEFAULT_ENTRY),
  ];
}

/** SO_PEERCRED of a connected Unix socket, read before any byte from the peer is trusted. */
export function readPeerCredentials(socket: net.Socket, python = '/usr/bin/python3', timeoutMs = 5_000) {
  return new Promise<{ pid: number; uid: number; gid: number }>((done, fail) => {
    const helper = spawn(python, ['-I', '-S', '-c', PEERCRED], {
      stdio: [socket, 'pipe', 'ignore'],
      env: {},
    });
    let out = '';
    const timer = setTimeout(() => helper.kill('SIGKILL'), timeoutMs);
    helper.stdout!.on('data', (chunk) => (out += chunk));
    helper.on('error', (error) => {
      clearTimeout(timer);
      fail(error);
    });
    helper.on('close', (code) => {
      clearTimeout(timer);
      const match = /^(\d+) (\d+) (\d+)\n$/.exec(out);
      if (code !== 0 || !match) return fail(new Error('PEER_CREDENTIALS_UNAVAILABLE'));
      done({ pid: Number(match[1]), uid: Number(match[2]), gid: Number(match[3]) });
    });
  });
}

const run = (file: string, args: string[], env: NodeJS.ProcessEnv) =>
  new Promise<{ code: number; stdout: string }>((done) =>
    execFile(file, args, { env, encoding: 'utf8', timeout: 10_000 }, (error, stdout) =>
      done({ code: error ? Number((error as { code?: unknown }).code) || 1 : 0, stdout: String(stdout) }),
    ),
  );
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

export function stepRunnerDriver(options: StepRunnerOptions, hooks: StepRunnerHooks = {}): StepRunnerDriver {
  validate(options);
  const o = { ...options };
  const startTimeoutMs = o.startTimeoutMs ?? 30_000;
  const stopTimeoutMs = o.stopTimeoutMs ?? 5_000;
  const maxFrameBytes = o.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
  const uid = process.getuid!();
  // systemd-run reaches this user's manager; nothing else of the caller's environment is passed on.
  const hostEnv: NodeJS.ProcessEnv = {
    PATH: '/usr/bin:/bin',
    XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR ?? `/run/user/${uid}`,
    ...(process.env.DBUS_SESSION_BUS_ADDRESS
      ? { DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS }
      : {}),
  };
  const realSystemctl = (args: string[]) => run('systemctl', ['--user', ...args], hostEnv);
  const systemctl = (...args: string[]) =>
    hooks.systemctl ? hooks.systemctl(args, realSystemctl) : realSystemctl(args);
  const writeCgroupFile =
    hooks.writeCgroupFile ?? ((path: string, data: string) => writeFileSync(path, data));
  const readCgroupFile = hooks.readCgroupFile ?? ((path: string) => readFile(path, 'utf8'));

  const start = async (spec: RuntimeSpec, admit: (spawn: () => void) => void): Promise<StepRunnerHandle> => {
    const launch: Launch = {
      unit: `step-rt-${randomBytes(16).toString('hex')}.scope`,
      socketDir: join(o.socketRoot, randomBytes(16).toString('hex')),
    };
    const launchNonce = randomBytes(32).toString('hex');
    // The socket root must be ours and not writable or listable by others. This does not hide the folder name (it is
    // in /proc/<pid>/cmdline); the peer check and nonce below are what keep other local users out.
    try {
      const root = statSync(o.socketRoot);
      if (!root.isDirectory() || root.uid !== uid || (root.mode & 0o066) !== 0) throw new Error();
    } catch {
      throw Object.assign(new WorkspaceError('RUNTIME_START_FAILED'), { cause: 'SOCKET_ROOT_UNSAFE' });
    }
    const argv = stepRunnerCommand(spec, o, launch);
    const socketPath = join(launch.socketDir, SOCKET_NAME);
    const server = net.createServer({ pauseOnConnect: true });
    const removeSocket = () => {
      server.close();
      rmSync(launch.socketDir, { recursive: true, force: true });
    };
    try {
      mkdirSync(launch.socketDir, { mode: 0o711 });
      chmodSync(launch.socketDir, 0o711);
      await new Promise<void>((done, fail) => {
        server.once('error', fail);
        server.listen(socketPath, () => {
          server.off('error', fail);
          done();
        });
      });
      // Connecting needs write permission on the socket. Any local user who reads the path from /proc can connect
      // too (0700 + group/ACL hardening is pending a host change), so every connection is checked as hostile.
      chmodSync(socketPath, 0o666);
    } catch {
      removeSocket();
      throw new WorkspaceError('RUNTIME_START_FAILED');
    }

    let child = undefined as ChildProcess | undefined;
    let admissionError: unknown;
    let admissionFailed = false;
    let admitting = true;
    try {
      admit(() => {
        if (!admitting || child) throw new Error('RUNTIME_START_ADMISSION_REPEATED');
        child = spawn(argv[0]!, argv.slice(1), { env: hostEnv, stdio: ['pipe', 'ignore', 'inherit'] });
        // sudo-rs passes stdin straight through (no pty): the nonce reaches only the runtime.
        child.stdin!.on('error', () => {});
        child.stdin!.end(
          o.transport === 'authenticated'
            ? JSON.stringify({ path: `${SANDBOX_SOCKET_DIR}/${SOCKET_NAME}`, key: launchNonce }) + '\n'
            : launchNonce + '\n',
        );
      });
    } catch (error) {
      if (!child) {
        removeSocket();
        throw error;
      }
      admissionError = error;
      admissionFailed = true;
    } finally {
      admitting = false;
    }
    if (!child) {
      removeSocket();
      throw new Error('RUNTIME_START_ADMISSION_SKIPPED');
    }
    const proc = child;

    // ---- process and channel state ----
    let childExit: number | null | undefined;
    const childExited = new Promise<void>((done) => {
      proc.once('exit', (code) => {
        childExit = code;
        done();
      });
      proc.on('error', () => {
        if (proc.pid === undefined) {
          childExit = null;
          done();
        }
      });
    });
    let socket: net.Socket | undefined;
    let authenticatedWrite: ((value: unknown) => void) | undefined;
    let ready = false;
    let channelOpen = false;
    let stopping = false;
    let lostChannel!: () => void;
    const channelLost = new Promise<void>((done) => (lostChannel = done));
    let nonce = 0;
    const pending = new Map<number, { done: (v: unknown) => void; fail: (e: Error) => void }>();
    const eventListeners = new Set<(event: RuntimeEvent) => void>();
    const exitListeners: ((code: number | null) => void)[] = [];
    let exitCode: number | null | undefined;
    let rejectReady!: (error: Error) => void;
    let resolveReady!: () => void;
    const readyPromise = new Promise<void>((done, fail) => {
      resolveReady = done;
      rejectReady = fail;
    });
    void readyPromise.catch(() => {});

    const scope: StepRunnerScope = {
      unit: launch.unit,
      cgroupPath: '',
      socketDir: launch.socketDir,
      peerUid: -1,
      unitCleanup: 'pending',
    };

    // Any loss of the channel or of the process ends the runtime: fail what is in flight, then kill and prove.
    // Why the launch was refused or the channel ended; attached as `cause` to a start failure.
    let reason: string | undefined;
    // Not yet trusted connections, and why the last refused one was refused (the cause if the launch then fails).
    const candidates = new Set<net.Socket>();
    let refusedCount = 0;
    let lastRefusal: string | undefined;
    const lose = (why = 'CHANNEL_CLOSED') => {
      reason ??= why;
      channelOpen = false;
      socket?.destroy();
      for (const peer of candidates) peer.destroy();
      candidates.clear();
      lostChannel();
      rejectReady(Object.assign(new WorkspaceError('RUNTIME_START_FAILED'), { cause: reason }));
      for (const [id, entry] of pending) {
        pending.delete(id);
        entry.fail(new WorkspaceError('RUNTIME_EXITED'));
      }
      if (ready && !stopping) void teardown(true).catch(() => {});
    };
    void childExited.then(() => lose(ready ? 'LAUNCHER_EXITED' : (lastRefusal ?? 'LAUNCHER_EXITED')));

    const onFrame = (value: unknown) => {
      const message = value as RuntimeReply;
      if (message?.type === 'event' && message.event) {
        for (const listener of eventListeners) listener(message.event);
        return;
      }
      if (message?.type === 'result' && typeof message.nonce === 'number') {
        const entry = pending.get(message.nonce);
        if (!entry) return;
        pending.delete(message.nonce);
        if (message.ok) entry.done(message.result);
        else
          entry.fail(Object.assign(new Error(String(message.code)), { code: String(message.code) }) as Error);
        return;
      }
      lose('PROTOCOL_VIOLATION');
    };

    const isReady = (line: Buffer) => {
      let message: { type?: unknown; launchNonce?: unknown } | undefined;
      try {
        message = JSON.parse(line.toString('utf8'));
      } catch {
        return false;
      }
      const echoed = Buffer.from(typeof message?.launchNonce === 'string' ? message.launchNonce : '');
      const expected = Buffer.from(launchNonce);
      return (
        message?.type === 'ready' && echoed.length === expected.length && timingSafeEqual(echoed, expected)
      );
    };
    // Drop a not-yet-trusted peer without a reply. Too many refusals end the launch: each one cost a helper process.
    const refuse = (peer: net.Socket, why: string) => {
      const counted = candidates.delete(peer) || !peer.destroyed;
      peer.destroy();
      if (!counted || socket || reason) return;
      lastRefusal = why;
      if (++refusedCount >= MAX_REJECTED_PEERS) lose('TOO_MANY_REJECTED_PEERS');
    };
    // The first peer that is uid step-runner AND echoes the nonce wins; then the listener closes (Node unlinks the
    // path) and every other candidate is dropped.
    const accept = (peer: net.Socket, rest: Buffer) => {
      candidates.delete(peer);
      socket = peer;
      server.close();
      for (const other of candidates) other.destroy();
      candidates.clear();
      scope.peerUid = o.runnerUid;
      channelOpen = true;
      ready = true;
      peer.on('close', () => lose('CHANNEL_CLOSED'));
      const push = frameReader(maxFrameBytes, onFrame, (error) => lose(error));
      resolveReady();
      if (rest.length) push(rest);
      return push;
    };
    server.on('connection', (peer) => {
      peer.on('error', () => {});
      // pauseOnConnect: nothing is read from a peer before its credentials are known.
      if (socket || reason) return void peer.destroy();
      if (candidates.size >= MAX_PENDING_PEERS) return refuse(peer, 'TOO_MANY_PENDING_PEERS');
      candidates.add(peer);
      peer.once('close', () => peer !== socket && refuse(peer, 'PEER_CLOSED'));
      readPeerCredentials(peer, o.python).then(
        (cred) => {
          if (!candidates.has(peer)) return;
          if (cred.uid !== o.runnerUid) return refuse(peer, 'PEER_REJECTED');
          if (o.transport === 'authenticated') {
            const write = authenticateRuntimePeer(
              peer,
              launchNonce,
              (message) => {
                if (socket === peer) return onFrame(message);
                if (!candidates.has(peer) || socket || message.type !== 'ready')
                  return refuse(peer, 'PROTOCOL_VIOLATION');
                authenticatedWrite = write;
                accept(peer, Buffer.alloc(0));
              },
              () => refuse(peer, 'AUTHENTICATION_FAILED'),
            );
            peer.resume();
            return;
          }
          const parts: Buffer[] = [];
          let size = 0;
          let trusted: ((chunk: Buffer) => void) | undefined;
          peer.on('data', (chunk: Buffer) => {
            if (trusted) return trusted(chunk);
            if (!candidates.has(peer)) return;
            const at = chunk.indexOf(0x0a);
            if (size + (at < 0 ? chunk.length : at) > MAX_FIRST_FRAME_BYTES)
              return refuse(peer, 'FRAME_TOO_LARGE');
            if (at < 0) {
              parts.push(chunk);
              size += chunk.length;
              return;
            }
            const line = Buffer.concat([...parts, chunk.subarray(0, at)]);
            if (!isReady(line)) return refuse(peer, 'NONCE_MISMATCH');
            trusted = accept(peer, chunk.subarray(at + 1));
          });
          peer.resume();
        },
        () => refuse(peer, 'PEER_CREDENTIALS_UNAVAILABLE'),
      );
    });

    // The scope's cgroup, from the user manager. Unit names are random and never reused.
    const cgroupPattern = new RegExp(
      `^/user\\.slice/user-${uid}\\.slice/user@${uid}\\.service/(?:[A-Za-z0-9@._-]+/)*${launch.unit.replaceAll('.', '\\.')}$`,
    );
    const discover = async (deadline: number): Promise<string | 'gone'> => {
      for (;;) {
        const exitedBefore = childExit !== undefined;
        const query = await systemctl('show', launch.unit, '-p', 'ControlGroup', '--value');
        // A failed query says nothing: retry until the deadline, never conclude 'gone' from it.
        if (query.code === 0) {
          const shown = query.stdout.trim();
          if (shown) {
            if (!cgroupPattern.test(shown)) throw new WorkspaceError('RUNTIME_START_FAILED');
            return (scope.cgroupPath = '/sys/fs/cgroup' + shown);
          }
          // The launcher is gone and the manager knows no scope: nothing of this launch can be running.
          if (exitedBefore) return 'gone';
        }
        if (Date.now() > deadline) throw new WorkspaceError('RUNTIME_START_FAILED');
        await sleep(25);
      }
    };
    const discovered = discover(Date.now() + startTimeoutMs);
    void discovered.catch(() => {});

    const stopFailed = (cause: string) => Object.assign(new WorkspaceError('RUNTIME_STOP_FAILED'), { cause });
    const killScope = (cgroup: string) => {
      try {
        writeCgroupFile(join(cgroup, 'cgroup.kill'), '1');
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT') throw stopFailed(`CGROUP_KILL_${code ?? 'FAILED'}`);
      }
    };
    /** Proof of emptiness: `populated 0`, or the kernel removed the (never reused) cgroup. */
    const provenEmpty = async (cgroup: string) => {
      try {
        return (await readCgroupFile(join(cgroup, 'cgroup.events'))).includes('populated 0');
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'ENOENT';
      }
    };

    // After the processes are proven gone: remove the unit. `stop`/`reset-failed` fail harmlessly when systemd has
    // already collected the empty scope, so the outcome is judged by asking afterwards, and recorded on the scope.
    const cleanupUnit = async () => {
      const failures: string[] = [];
      for (const verb of ['stop', 'reset-failed']) {
        const result = await systemctl(verb, launch.unit);
        if (result.code !== 0) failures.push(`${verb}: exit ${result.code}`);
      }
      const state = await systemctl('show', launch.unit, '-p', 'LoadState', '-p', 'ActiveState');
      const props = Object.fromEntries(
        state.stdout
          .split('\n')
          .filter((line) => line.includes('='))
          .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
      );
      const collected =
        state.code === 0 && (props.LoadState === 'not-found' || props.ActiveState === 'inactive');
      if (state.code !== 0) failures.push(`show: exit ${state.code}`);
      else if (!collected) failures.push(`show: ${props.LoadState}/${props.ActiveState}`);
      scope.unitCleanup = collected ? 'done' : 'failed';
      scope.unitCleanupFailures = collected ? undefined : failures;
    };

    let tearing: Promise<void> | undefined;
    const teardown = (force: boolean) =>
      (tearing ??= (async () => {
        stopping = true;
        if (!force && channelOpen)
          await Promise.race([Promise.all([channelLost, childExited]), sleep(stopTimeoutMs)]);
        let where: string | 'gone';
        try {
          where = scope.cgroupPath || (await discover(Date.now() + stopTimeoutMs));
        } catch {
          throw stopFailed('SCOPE_UNKNOWN');
        }
        if (where !== 'gone') {
          const deadline = Date.now() + stopTimeoutMs;
          let empty = false;
          while (!(empty = await provenEmpty(where)) && Date.now() < deadline) {
            killScope(where);
            await sleep(25);
          }
          if (!empty) throw stopFailed('NOT_PROVEN_EMPTY');
        }
        await cleanupUnit();
        removeSocket();
        lose('STOPPED');
        await Promise.race([childExited, sleep(2_000)]);
        exitCode = childExit ?? null;
        for (const listener of exitListeners.splice(0)) listener(exitCode);
      })().catch((error) => {
        // Not proven: keep everything (handle, onExit listeners) so a later stop() retries from the start.
        tearing = undefined;
        throw error instanceof WorkspaceError ? error : stopFailed('TEARDOWN_FAILED');
      }));

    const request = (method: string, params: unknown, timeoutMs?: number) =>
      new Promise<unknown>((done, fail) => {
        if (!channelOpen || !ready || stopping || !socket)
          return fail(new WorkspaceError('RUNTIME_NOT_RUNNING'));
        const id = ++nonce;
        const timer = timeoutMs
          ? setTimeout(() => {
              pending.delete(id);
              fail(new Error('RUNTIME_CALL_TIMEOUT'));
            }, timeoutMs)
          : undefined;
        pending.set(id, {
          done: (v) => {
            clearTimeout(timer);
            done(v);
          },
          fail: (e) => {
            clearTimeout(timer);
            fail(e);
          },
        });
        try {
          const message = { type: 'call', nonce: id, method, params } satisfies RuntimeRequest;
          if (authenticatedWrite) authenticatedWrite(message);
          else socket.write(encodeFrame(message));
        } catch (error) {
          pending.delete(id);
          clearTimeout(timer);
          fail(error as Error);
        }
      });

    const stopWithAdmission = async (admitStop: (signal: () => void) => void, force = false) => {
      let signalled = false;
      try {
        admitStop(() => {
          if (signalled) return;
          signalled = true;
          stopping = true;
          if (force || !channelOpen) {
            // A failing kill here is retried, and reported as RUNTIME_STOP_FAILED, by the teardown below.
            try {
              if (scope.cgroupPath) killScope(scope.cgroupPath);
            } catch {}
          } else socket?.end();
        });
      } catch (error) {
        if (signalled) void teardown(force).catch(() => {});
        throw error;
      }
      if (!signalled) throw new Error('RUNTIME_STOP_ADMISSION_SKIPPED');
      await teardown(force);
      // The runtime is proven gone; only a unit removal that failed earlier is retried.
      if (scope.unitCleanup === 'failed') await cleanupUnit();
    };

    const handle: StepRunnerHandle = {
      pid: proc.pid,
      scope,
      onExit: (listener) => {
        if (exitCode !== undefined) queueMicrotask(() => listener(exitCode!));
        else exitListeners.push(listener);
      },
      onEvent: (listener) => void eventListeners.add(listener),
      health: (timeoutMs = 2_000) =>
        (request('health', {}, timeoutMs) as Promise<RuntimeHealth>).catch(() => ({
          ok: false,
          workspaceId: spec.workspaceId,
        })),
      call: <M extends keyof RuntimeCalls>(method: M, params: RuntimeCalls[M]['params']) =>
        request(method, params) as Promise<RuntimeCalls[M]['result']>,
      stop: () => stopWithAdmission((signal) => signal()),
      stopWithAdmission,
    };

    try {
      if (admissionFailed) throw admissionError;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.all([readyPromise, discovered]),
          new Promise<never>((_, fail) => {
            timer = setTimeout(
              () =>
                fail(Object.assign(new WorkspaceError('RUNTIME_START_FAILED'), { cause: 'START_TIMEOUT' })),
              startTimeoutMs,
            );
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
      if (!scope.cgroupPath) throw new WorkspaceError('RUNTIME_START_FAILED');
    } catch (error) {
      try {
        await teardown(true);
      } catch {
        throw new RuntimeStartCleanupError(handle);
      }
      throw admissionFailed
        ? admissionError
        : error instanceof WorkspaceError
          ? error
          : new WorkspaceError('RUNTIME_START_FAILED');
    }
    return handle;
  };
  return { start: (spec) => start(spec, (spawn) => spawn()), startWithAdmission: start };
}

/** Typed as the generic contract for callers that do not need the scope details. */
export const asRuntimeDriver = (driver: StepRunnerDriver): RuntimeDriver => driver;
