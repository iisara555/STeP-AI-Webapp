// Development driver: one Workspace runtime is one Node process with its own memory, working directory and a
// minimal environment. It is not a security boundary against the host (no namespace or cgroup); production uses a
// container driver behind the same RuntimeDriver contract (ADR 0001 §1.3, still to be chosen).
import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WorkspaceError, type RuntimeDriver, type RuntimeHealth, type RuntimeSpec } from './contract.ts';

const ENTRY = fileURLToPath(new URL('./runtime-main.ts', import.meta.url));
const TSX = import.meta.resolve('tsx');

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

type Message = { type: 'ready' } | ({ type: 'health'; nonce: number } & RuntimeHealth);

export function processDriver({ startTimeoutMs = 15_000 } = {}): RuntimeDriver {
  return {
    async start(spec) {
      const child = fork(ENTRY, [], {
        cwd: spec.filesDir,
        env: runtimeEnv(spec),
        execArgv: ['--import', TSX],
        stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
        serialization: 'json',
      });
      await ready(child, startTimeoutMs);
      let nonce = 0;
      const exited = new Promise<number | null>((done) => child.once('exit', (code) => done(code)));
      return {
        pid: child.pid,
        onExit: (listener) => void exited.then(listener),
        health: (timeoutMs = 2_000) =>
          new Promise<RuntimeHealth>((done) => {
            const id = ++nonce;
            const down = { ok: false, workspaceId: spec.workspaceId };
            if (!child.connected) return done(down);
            const timer = setTimeout(() => finish(down), timeoutMs);
            const onMessage = (message: Message) => {
              if (message.type === 'health' && message.nonce === id) {
                const { type: _, nonce: __, ...health } = message;
                finish(health);
              }
            };
            const finish = (health: RuntimeHealth) => {
              clearTimeout(timer);
              child.off('message', onMessage);
              done(health);
            };
            child.on('message', onMessage);
            child.send({ type: 'health', nonce: id });
          }),
        async stop() {
          if (child.exitCode !== null || child.signalCode !== null) return;
          const kill = setTimeout(() => child.kill('SIGKILL'), 5_000);
          if (child.connected) child.send({ type: 'stop' });
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
    const onMessage = (message: Message) => {
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
