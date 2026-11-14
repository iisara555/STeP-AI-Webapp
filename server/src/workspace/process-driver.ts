// Development driver: optionally runs the synthetic trial inside Linux namespaces with restricted mounts.
// The default is unsandboxed for CLI tests; the gateway opts into the sandbox and never falls back.
import { fork, type ChildProcess } from 'node:child_process';
import { prepareUnixRuntime } from './unix-channel.ts';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  RuntimeStartCleanupError,
  WorkspaceError,
  type RuntimeCalls,
  type RuntimeDriver,
  type RuntimeEvent,
  type RuntimeHealth,
  type RuntimeHandle,
  type RuntimeSpec,
} from './contract.ts';

const ENTRY = fileURLToPath(new URL('./runtime-main.ts', import.meta.url));
const TSX = import.meta.resolve('tsx');
// The engine's providers.ts imports the Copilot SDK statically; register.mjs stands in for it (see ../register.mjs).
const REGISTER = new URL('../register.mjs', import.meta.url).href;

/**
 * Only what a runtime needs to find itself. Provider keys, Supabase secrets and the manager's own environment are
 * never inherited; a runtime receives short-lived, scoped tokens from the Gateway instead (ADR 0001 §2).
 */
export function runtimeEnv(spec: RuntimeSpec): Record<string, string> {
  return {
    PATH: '/usr/local/bin:/usr/bin:/bin',
    LANG: 'C.UTF-8',
    NODE_ENV: 'production',
    STEP_WORKSPACE_ID: spec.workspaceId,
    STEP_WORKSPACE_DIR: spec.dir,
  };
}

/** The private channel between Manager and runtime: one request, one reply with the same nonce. */
export type RuntimeRequest = { type: 'call'; nonce: number; method: string; params: unknown };
export type RuntimeReply =
  /** `launchNonce` is required on the step-runner socket transport, where it must echo STEP_RUNTIME_NONCE. */
  | { type: 'ready'; launchNonce?: string }
  | { type: 'event'; event: RuntimeEvent }
  | { type: 'result'; nonce: number; ok: true; result: unknown }
  | { type: 'result'; nonce: number; ok: false; code: string };

// Limit only the private /tmp mount, not workspace disk, inode usage or total runtime memory.
// Page-aligned sizes avoid kernel rounding above the requested bound (Linux pages <= 64 KiB).
export function validateTmpfsBytes(bytes: number | undefined) {
  if (bytes !== undefined && (!Number.isSafeInteger(bytes) || bytes < 65536 || bytes % 65536 !== 0))
    throw new Error('INVALID_TMPFS_LIMIT');
}

/** Root of this checkout; other drivers may run the same files from a copy elsewhere. */
export const REPO_ROOT = resolve(import.meta.dirname, '../../..');

/** Namespace mounts for the synthetic-only sandbox. Missing prerequisites fail closed. */
export function isolatedRuntimeArgs(spec: RuntimeSpec, tmpfsBytes?: number): string[] {
  return [
    ...sandboxMounts(spec, { appRoot: REPO_ROOT, nodeDir: dirname(process.execPath), tmpfsBytes }),
    '--',
    process.execPath,
  ];
}

/** Every Bubblewrap option before the command: namespaces, read-only app and Node, the one writable workspace. */
export function sandboxMounts(
  spec: RuntimeSpec,
  {
    appRoot,
    nodeDir,
    tmpfsBytes,
    dirFd,
  }: { appRoot: string; nodeDir: string; tmpfsBytes?: number; dirFd?: number },
): string[] {
  if (dirFd !== undefined && !(Number.isSafeInteger(dirFd) && dirFd >= 0)) throw new Error('INVALID_DIR_FD');
  validateTmpfsBytes(tmpfsBytes);
  const binds = [
    '/usr',
    '/lib',
    '/lib64',
    '/bin',
    nodeDir,
    resolve(appRoot, 'node_modules'),
    resolve(appRoot, 'server/src'),
    resolve(appRoot, 'server/package.json'),
    resolve(appRoot, 'package.json'),
    resolve(appRoot, 'harness'),
  ];
  return [
    '--unshare-all',
    '--unshare-user',
    '--disable-userns',
    '--die-with-parent',
    '--new-session',
    ...(tmpfsBytes === undefined ? [] : ['--cap-drop', 'ALL']),
    '--proc',
    '/proc',
    '--dev',
    '/dev',
    ...(tmpfsBytes === undefined ? [] : ['--size', String(tmpfsBytes)]),
    '--tmpfs',
    '/tmp',
    ...binds.flatMap((path) => ['--ro-bind', path, path]),
    // With dirFd, bwrap mounts the already-open (identity-verified) directory and closes the descriptor before
    // exec; spec.dir is then only the mount point inside the sandbox, never re-resolved on the host.
    ...(dirFd === undefined ? ['--bind', spec.dir, spec.dir] : ['--bind-fd', String(dirFd), spec.dir]),
    '--chdir',
    spec.filesDir,
  ];
}

export function processDriver({
  startTimeoutMs = 30_000,
  isolated = false,
  stopTimeoutMs = 5_000,
  tmpfsBytes,
  transport = 'fork',
  socketRoot,
}: {
  startTimeoutMs?: number;
  isolated?: boolean;
  stopTimeoutMs?: number;
  tmpfsBytes?: number;
  transport?: 'fork' | 'unix';
  socketRoot?: string;
} = {}): RuntimeDriver {
  validateTmpfsBytes(tmpfsBytes);
  if (tmpfsBytes !== undefined && !isolated) throw new Error('TMPFS_REQUIRES_ISOLATION');
  const start: NonNullable<RuntimeDriver['startWithAdmission']> = async (spec, admit) => {
    const unix = transport === 'unix' ? await prepareUnixRuntime(socketRoot) : undefined;
    let child!: ChildProcess;
    let admissionError: unknown;
    let admissionFailed = false;
    let admitting = true;
    try {
      admit(() => {
        if (!admitting || child) throw new Error('RUNTIME_START_ADMISSION_REPEATED');
        const env = {
          ...runtimeEnv(spec),
          ...(isolated ? { STEP_SYNTHETIC_PROVIDER: '1' } : {}),
          ...(unix ? { STEP_RUNTIME_TRANSPORT: 'unix' } : {}),
        };
        const isolation = isolated ? isolatedRuntimeArgs(spec, tmpfsBytes) : [];
        // The sandbox sees only its own endpoint, never the socketRoot or other workspaces.
        if (isolated && unix)
          isolation.splice(isolation.length - 2, 0, '--ro-bind', unix.directory, unix.directory);
        const args = [...isolation, '--import', TSX, '--import', REGISTER];
        child = unix
          ? unix.spawn(isolated ? '/usr/bin/bwrap' : process.execPath, [...args, ENTRY], {
              cwd: spec.filesDir,
              env,
            })
          : fork(ENTRY, [], {
              cwd: spec.filesDir,
              env,
              ...(isolated ? { execPath: '/usr/bin/bwrap' } : {}),
              execArgv: args,
              stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
              serialization: 'json',
            });
      });
    } catch (error) {
      if (!child) {
        await unix?.dispose();
        throw error;
      }
      admissionError = error;
      admissionFailed = true;
    } finally {
      admitting = false;
    }
    if (!child) {
      await unix?.dispose();
      throw new Error('RUNTIME_START_ADMISSION_SKIPPED');
    }
    let nonce = 0;
    const exited = new Promise<number | null>((done) => {
      child.once('exit', (code) => done(code));
      child.on('error', () => {
        if (child.pid === undefined) done(null);
      });
    });
    const request = (method: string, params: unknown, timeoutMs?: number) =>
      new Promise<unknown>((done, fail) => {
        const id = ++nonce;
        if (!child.connected) return fail(new WorkspaceError('RUNTIME_NOT_RUNNING'));
        const timer = timeoutMs
          ? setTimeout(() => finish(new Error('RUNTIME_CALL_TIMEOUT')), timeoutMs)
          : undefined;
        const onMessage = (message: RuntimeReply) => {
          if (message.type !== 'result' || message.nonce !== id) return;
          if (message.ok) finish(undefined, message.result);
          else finish(Object.assign(new Error(message.code), { code: message.code }));
        };
        const onExit = () => finish(new WorkspaceError('RUNTIME_EXITED'));
        const finish = (error?: Error, result?: unknown) => {
          clearTimeout(timer);
          child.off('message', onMessage);
          child.off('exit', onExit);
          if (error) fail(error);
          else done(result);
        };
        child.on('message', onMessage);
        child.once('exit', onExit);
        try {
          child.send({ type: 'call', nonce: id, method, params } satisfies RuntimeRequest);
        } catch (error) {
          // Unix enqueue can reject locally without closing the healthy channel.
          finish(error as Error);
        }
      });
    const eventListeners = new Set<(event: RuntimeEvent) => void>();
    child.on('message', (message: RuntimeReply) => {
      if (message.type === 'event') for (const listener of eventListeners) listener(message.event);
    });
    const stopWithAdmission = async (admit: (signal: () => void) => void, force = false) => {
      let kill: ReturnType<typeof setTimeout> | undefined;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      let failStop!: (error: Error) => void;
      const failure = new Promise<never>((_, reject) => {
        failStop = reject;
      });
      void failure.catch(() => {});
      admit(() => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        try {
          if (force) child.kill('SIGKILL');
          else if (child.connected) child.disconnect();
          else child.kill('SIGTERM');
        } catch {
          /* still attempt the forced stop */
        }
        kill = setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch {
            /* timeout reports unconfirmed exit */
          }
        }, stopTimeoutMs);
        timeout = setTimeout(() => failStop(new WorkspaceError('RUNTIME_STOP_FAILED')), stopTimeoutMs * 2);
        // Admission can throw after signalling (for example if its transaction fails to commit).
        // Keep the escalation armed until exit even when stopWithAdmission rejects.
        void exited.then(() => {
          clearTimeout(kill);
          clearTimeout(timeout);
        });
      });
      try {
        await Promise.race([exited, failure]);
        await unix?.dispose();
      } finally {
        clearTimeout(kill);
        clearTimeout(timeout);
      }
    };
    const handle: RuntimeHandle = {
      pid: child.pid,
      onExit: (listener) => void exited.then(listener),
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
      await ready(child, startTimeoutMs);
    } catch (error) {
      try {
        await stopWithAdmission((signal) => signal(), true);
      } catch {
        throw new RuntimeStartCleanupError(handle);
      }
      throw error;
    }
    return handle;
  };
  return { start: (spec) => start(spec, (spawn) => spawn()), startWithAdmission: start };
}

function ready(child: ChildProcess, timeoutMs: number) {
  return new Promise<void>((done, fail) => {
    const failed = () => {
      cleanup();
      fail(new WorkspaceError('RUNTIME_START_FAILED'));
    };
    const timer = setTimeout(failed, timeoutMs);
    const onMessage = (message: RuntimeReply) => {
      if (message.type !== 'ready') return;
      cleanup();
      done();
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.off('message', onMessage);
      child.off('exit', failed);
      child.off('error', failed);
    };
    child.on('message', onMessage);
    child.once('exit', failed);
    child.once('error', failed);
  });
}
