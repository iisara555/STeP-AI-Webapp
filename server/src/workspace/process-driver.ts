// Development driver: optionally runs the synthetic trial inside Linux namespaces with restricted mounts.
// The default is unsandboxed for CLI tests; the gateway opts into the sandbox and never falls back.
import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  WorkspaceError,
  type RuntimeCalls,
  type RuntimeDriver,
  type RuntimeHealth,
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
  | { type: 'ready' }
  | { type: 'result'; nonce: number; ok: true; result: unknown }
  | { type: 'result'; nonce: number; ok: false; code: string };

/** Namespace mounts for the synthetic-only sandbox. Missing prerequisites fail closed. */
export function isolatedRuntimeArgs(spec: RuntimeSpec): string[] {
  const appRoot = resolve(import.meta.dirname, '../../..');
  const nodeDir = dirname(process.execPath);
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
    '--cap-drop',
    'ALL',
    '--die-with-parent',
    '--new-session',
    '--proc',
    '/proc',
    '--dev',
    '/dev',
    '--tmpfs',
    '/tmp',
    ...binds.flatMap((path) => ['--ro-bind', path, path]),
    '--bind',
    spec.dir,
    spec.dir,
    '--chdir',
    spec.filesDir,
    '--',
    process.execPath,
  ];
}

export function processDriver({ startTimeoutMs = 30_000, isolated = false } = {}): RuntimeDriver {
  return {
    async start(spec) {
      const child = fork(ENTRY, [], {
        cwd: spec.filesDir,
        env: { ...runtimeEnv(spec), ...(isolated ? { STEP_SYNTHETIC_PROVIDER: '1' } : {}) },
        ...(isolated ? { execPath: '/usr/bin/bwrap' } : {}),
        execArgv: [...(isolated ? isolatedRuntimeArgs(spec) : []), '--import', TSX, '--import', REGISTER],
        stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
        serialization: 'json',
      });
      await ready(child, startTimeoutMs);
      let nonce = 0;
      const exited = new Promise<number | null>((done) => child.once('exit', (code) => done(code)));
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
          child.send({ type: 'call', nonce: id, method, params } satisfies RuntimeRequest);
        });
      return {
        pid: child.pid,
        onExit: (listener) => void exited.then(listener),
        health: (timeoutMs = 2_000) =>
          (request('health', {}, timeoutMs) as Promise<RuntimeHealth>).catch(() => ({
            ok: false,
            workspaceId: spec.workspaceId,
          })),
        call: <M extends keyof RuntimeCalls>(method: M, params: RuntimeCalls[M]['params']) =>
          request(method, params) as Promise<RuntimeCalls[M]['result']>,
        async stop() {
          if (child.exitCode !== null || child.signalCode !== null) return;
          const kill = setTimeout(() => child.kill('SIGKILL'), 5_000);
          if (child.connected) child.disconnect();
          else child.kill('SIGTERM');
          await exited;
          clearTimeout(kill);
        },
      };
    },
  };
}

function ready(child: ChildProcess, timeoutMs: number) {
  return new Promise<void>((done, fail) => {
    const failed = () => {
      cleanup();
      child.kill('SIGKILL');
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
