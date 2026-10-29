// Development driver: one Workspace runtime is one Node process with its own memory, working directory and a
// minimal environment. It is not a security boundary against the host (no namespace or cgroup); production uses a
// container driver behind the same RuntimeDriver contract (ADR 0001 §1.3, still to be chosen).
import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  WorkspaceError,
  type RuntimeCalls,
  type RuntimeDriver,
  type RuntimeEvent,
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
  | { type: 'event'; event: RuntimeEvent }
  | { type: 'result'; nonce: number; ok: true; result: unknown }
  | { type: 'result'; nonce: number; ok: false; code: string };

export function processDriver({ startTimeoutMs = 30_000 } = {}): RuntimeDriver {
  return {
    async start(spec) {
      const child = fork(ENTRY, [], {
        cwd: spec.filesDir,
        env: runtimeEnv(spec),
        execArgv: ['--import', TSX, '--import', REGISTER],
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
      const eventListeners = new Set<(event: RuntimeEvent) => void>();
      child.on('message', (message: RuntimeReply) => {
        if (message.type === 'event') for (const listener of eventListeners) listener(message.event);
      });
      return {
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
