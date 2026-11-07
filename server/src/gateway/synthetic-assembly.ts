// Optional composition for disposable synthetic rehearsals. Never imported by production main.ts.
import { RuntimeManager } from '../workspace/manager.ts';
import type { RuntimeDriver, RuntimeSpec } from '../workspace/contract.ts';
import { processDriver } from '../workspace/process-driver.ts';
import { stepRunnerDriver, type StepRunnerOptions } from '../workspace/step-runner-driver.ts';
import type { Authenticator } from './auth.ts';
import { createGateway } from './http.ts';
import { DEFAULT_QUOTAS, RunService } from './runs.ts';

export type SyntheticAssemblyOptions = {
  purpose: 'synthetic-only';
  /** Disposable, explicitly quota-provisioned root, not a production data directory. */
  dataRoot: string;
  workspacesPerUser: number;
  authenticate: Authenticator;
  runtime:
    | { kind: 'namespace'; socketRoot?: string }
    | {
        kind: 'step-runner';
        options: Omit<StepRunnerOptions, 'transport' | 'entry' | 'maxFrameBytes'>;
        /** Explicit disposable-fixture access provisioning; never widen production/home permissions. */
        prepareWorkspace: (spec: RuntimeSpec) => Promise<void>;
      };
};

/** Both paths run the real RuntimeManager and pinned engine; neither opens a listener automatically.
 * Bind server to loopback only. Inject an authenticator explicitly; there is no anonymous fallback.
 * Step-runner requires separately provisioned app/Node/workspace access; this factory changes no host policy. */
export function createSyntheticAssembly(options: SyntheticAssemblyOptions) {
  if (options.purpose !== 'synthetic-only' || typeof options.authenticate !== 'function')
    throw new Error('SYNTHETIC_ASSEMBLY_ONLY');
  const runtime = options.runtime;
  if (!runtime || !['namespace', 'step-runner'].includes(runtime.kind))
    throw new Error('INVALID_SYNTHETIC_RUNTIME');
  let driver: RuntimeDriver;
  if (runtime.kind === 'step-runner') {
    if (typeof runtime.prepareWorkspace !== 'function') throw new Error('SYNTHETIC_PROVISIONING_REQUIRED');
    const runner = stepRunnerDriver({
      ...runtime.options,
      transport: 'authenticated',
      entry: 'server/src/workspace/runtime-main.ts',
      maxFrameBytes: 1024 * 1024,
    });
    // Keep the runner's orphan recovery (#62): the manager journals through the wrapped driver it gets back.
    const wrap = (inner: typeof runner): RuntimeDriver => {
      const start: NonNullable<RuntimeDriver['startWithAdmission']> = async (spec, admit) => {
        await runtime.prepareWorkspace(spec);
        return inner.startWithAdmission(spec, admit);
      };
      return {
        start: (spec) => start(spec, (spawn) => spawn()),
        startWithAdmission: start,
        recovery: {
          kind: inner.recovery.kind,
          journaled: (journal) => wrap(inner.recovery.journaled(journal)),
          reap: inner.recovery.reap,
        },
      };
    };
    driver = wrap(runner);
  } else {
    driver = processDriver({ isolated: true, transport: 'unix', socketRoot: runtime.socketRoot });
  }
  const manager = new RuntimeManager({
    dataRoot: options.dataRoot,
    workspacesPerUser: options.workspacesPerUser,
    maxRunning: 10,
    driver,
    // Both drivers force their in-sandbox synthetic provider and disable public search.
    grant: () => ({ baseUrl: 'http://127.0.0.1:1/v1', model: 'synthetic' }),
  });
  const audit = () => {};
  const quotas = { ...DEFAULT_QUOTAS, workspacesPerUser: options.workspacesPerUser };
  const server = createGateway({
    manager,
    authenticate: options.authenticate,
    audit,
    quotas,
    runs: new RunService(manager, audit, quotas),
  });
  let closing: Promise<void> | undefined;
  return {
    server,
    manager,
    close: () =>
      (closing ??= (async () => {
        server.closeAllConnections();
        await new Promise<void>((done, fail) =>
          server.close((error) =>
            error && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING'
              ? fail(error)
              : done(),
          ),
        );
        await manager.shutdown();
      })().catch((error) => {
        closing = undefined;
        throw error;
      })),
  };
}
