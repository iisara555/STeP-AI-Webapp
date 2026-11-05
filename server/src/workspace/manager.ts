// Runtime Manager (ADR 0001 §3, phases 1–2): create, start, stop, resume and health of Workspace runtimes. Every call
// names the acting user, and a Workspace is reachable only through its owner; sharing by ACL comes later and must
// be granted explicitly, never by being in the same tenant.
import {
  AskInput,
  newWorkspaceId,
  ProviderGrant,
  RuntimeStartCleanupError,
  parse,
  UserId,
  WorkspaceError,
  WorkspaceName,
  type AskResult,
  type ConversationMessage,
  type ConversationSummary,
  SessionRef,
  type RuntimeDriver,
  type RuntimeEvent,
  type RuntimeHandle,
  type RuntimeHealth,
  type RuntimeState,
  type Workspace,
  type WorkspaceRecord,
} from './contract.ts';
import {
  createWorkspaceFolders,
  listRecords,
  readConversationIndex,
  readRecord,
  saveRecord,
  workspacePaths,
} from './storage.ts';

export type RuntimeManagerOptions = {
  dataRoot: string;
  driver: RuntimeDriver;
  /** Admission control for the shared server: runtimes beyond this wait for the user to retry. */
  maxRunning?: number;
  /** A running Workspace with no activity for this long is stopped by sweepIdle(); its data stays. */
  idleMs?: number;
  /** Maximum wait for the provider connect IPC after the driver has returned a handle. */
  connectTimeoutMs?: number;
  now?: () => number;
  /**
   * The AI endpoint and short-lived token for one runtime start, asked for again at every start and resume so a
   * token never outlives the runtime it was issued to. The Gateway supplies this from its secret store (phase 3).
   */
  grant?: (
    ownerId: string,
    workspaceId: string,
  ) => ProviderGrant | undefined | Promise<ProviderGrant | undefined>;
};

type Live = {
  state: RuntimeState;
  handle?: RuntimeHandle;
  starting?: Promise<void>;
  stopping?: Promise<void>;
  stopAttempt?: { rejectedBeforeSignal: boolean };
  startupCleanupFailed?: boolean;
  lastActive: number;
  /** Requests in flight; a busy runtime is never stopped as idle, so work goes on after the browser closes. */
  busy: number;
  error?: string;
};

export type RuntimeStats = { running: number; starting: number; failed: number; max: number; busy: number };

export class RuntimeManager {
  private readonly live = new Map<string, Live>();
  private shuttingDown = false;
  private shutdownAttempt?: Promise<void>;
  private readonly activeCalls = new Map<string, number>();
  /** Event listeners by Workspace; they outlive a runtime so a resumed Workspace keeps reporting to them. */
  private readonly listeners = new Map<string, Set<(event: RuntimeEvent) => void>>();
  private readonly dataRoot: string;
  private readonly driver: RuntimeDriver;
  private readonly maxRunning: number;
  private readonly idleMs: number;
  private readonly connectTimeoutMs: number;
  private readonly now: () => number;
  private readonly grant: NonNullable<RuntimeManagerOptions['grant']>;

  constructor({
    dataRoot,
    driver,
    maxRunning = 8,
    idleMs = 30 * 60_000,
    connectTimeoutMs = 30_000,
    now = Date.now,
    grant = () => undefined,
  }: RuntimeManagerOptions) {
    this.dataRoot = dataRoot;
    this.driver = driver;
    this.maxRunning = maxRunning;
    this.idleMs = idleMs;
    if (!Number.isFinite(connectTimeoutMs) || connectTimeoutMs <= 0)
      throw new Error('INVALID_CONNECT_TIMEOUT');
    this.connectTimeoutMs = connectTimeoutMs;
    this.now = now;
    this.grant = grant;
  }

  async create(actor: string, input: { name: string }): Promise<Workspace> {
    const ownerId = parse(UserId, actor, 'INVALID_ID');
    const name = parse(WorkspaceName, input.name, 'INVALID_NAME');
    const at = new Date(this.now()).toISOString();
    const record: WorkspaceRecord = { id: newWorkspaceId(), ownerId, name, createdAt: at, lastActiveAt: at };
    await createWorkspaceFolders(this.dataRoot, record);
    return this.view(record);
  }

  async list(actor: string): Promise<Workspace[]> {
    return (await listRecords(this.dataRoot, actor)).map((record) => this.view(record));
  }

  async get(actor: string, workspaceId: string): Promise<Workspace> {
    return this.view(await readRecord(this.dataRoot, actor, workspaceId));
  }

  /** Starts the runtime, or resumes it from its folder after a stop, idle stop or crash. */
  async start(actor: string, workspaceId: string): Promise<Workspace> {
    if (this.shuttingDown) throw new Error('RUNTIME_MANAGER_SHUTTING_DOWN');
    const record = await readRecord(this.dataRoot, actor, workspaceId);
    if (this.shuttingDown) throw new Error('RUNTIME_MANAGER_SHUTTING_DOWN');
    const key = this.key(record);
    const current = this.live.get(key);
    if (current?.stopping) {
      const attempt = current.stopAttempt;
      try {
        await current.stopping;
      } catch (error) {
        // A different caller's rejected authority did not signal the runtime. Real stop failures still propagate.
        if (!attempt?.rejectedBeforeSignal) throw error;
      }
      return this.start(actor, workspaceId);
    }
    if (current?.state === 'running') return this.touchRecord(record, current);
    // A failed stop may have signalled the runtime. Do not reuse or replace it until exit or a retry.
    if (current?.state === 'failed' && current.handle) throw new WorkspaceError('RUNTIME_NOT_RUNNING');
    if (current?.starting) {
      await current.starting;
      return this.view(record);
    }
    if (this.running() >= this.maxRunning) throw new WorkspaceError('RUNTIME_CAPACITY');
    const entry: Live = { state: 'starting', lastActive: this.now(), busy: 0 };
    this.live.set(key, entry);
    entry.starting = (async () => {
      try {
        const handle = await this.driver.start(workspacePaths(this.dataRoot, record.ownerId, record.id));
        entry.handle = handle;
        handle.onExit(() => {
          if (this.live.get(key) !== entry || entry.handle !== handle) return;
          Object.assign(entry, { state: 'failed', handle: undefined, error: 'RUNTIME_EXITED' });
        });
        const provider = await this.grant(record.ownerId, record.id);
        if (provider) {
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([
              handle.call('connect', ProviderGrant.parse(provider)),
              new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error('RUNTIME_CONNECT_TIMEOUT')), this.connectTimeoutMs);
              }),
            ]);
          } finally {
            clearTimeout(timer);
          }
        }
        if (entry.handle !== handle) throw new Error('RUNTIME_EXITED');
        handle.onEvent?.((event) => {
          for (const listener of this.listeners.get(key) ?? []) listener(event);
        });
        if (entry.handle !== handle) throw new Error('RUNTIME_EXITED');
        entry.state = 'running';
      } catch (error) {
        if (error instanceof RuntimeStartCleanupError) {
          entry.handle = error.handle;
          entry.startupCleanupFailed = true;
          error.handle.onExit(() => {
            if (this.live.get(key) !== entry || entry.handle !== error.handle) return;
            Object.assign(entry, { state: 'failed', handle: undefined, error: 'RUNTIME_EXITED' });
          });
        }
        if (entry.handle) {
          const handle = entry.handle;
          try {
            await handle.stop();
            if (entry.handle === handle) entry.handle = undefined;
            entry.startupCleanupFailed = false;
          } catch {
            if (entry.handle === handle) entry.startupCleanupFailed = true;
          }
        }
        Object.assign(entry, {
          state: 'failed',
          error: entry.startupCleanupFailed ? 'RUNTIME_START_CLEANUP_FAILED' : 'RUNTIME_START_FAILED',
        });
        throw new WorkspaceError('RUNTIME_START_FAILED');
      } finally {
        entry.starting = undefined;
      }
    })();
    await entry.starting;
    return this.touchRecord(record, entry);
  }

  async stop(
    actor: string,
    workspaceId: string,
    admit?: (signal: () => void) => void,
    authorize?: () => Promise<void>,
  ): Promise<Workspace> {
    const record = await readRecord(this.dataRoot, actor, workspaceId);
    await this.stopKey(this.key(record), admit, authorize);
    return this.view(record);
  }

  async health(actor: string, workspaceId: string): Promise<RuntimeHealth & { state: RuntimeState }> {
    const record = await readRecord(this.dataRoot, actor, workspaceId);
    const entry = this.live.get(this.key(record));
    if (!entry?.handle || entry.state !== 'running')
      return { ok: false, workspaceId: record.id, state: entry?.state ?? 'stopped' };
    return { ...(await entry.handle.health()), state: entry.state };
  }

  /**
   * Runs one request in the Workspace's engine, resuming the runtime first when it is stopped. The request keeps
   * running if the caller goes away; its result stays in the Workspace's conversation history.
   */
  async ask(
    actor: string,
    workspaceId: string,
    input: AskInput,
    onDispatch?: () => void,
    dispatch: (send: () => Promise<AskResult>) => Promise<AskResult> = (send) => send(),
  ): Promise<AskResult> {
    const request = parse(AskInput, input, 'INVALID_INPUT');
    // onDispatch runs just before the request is sent; the channel keeps order, so a later cancel comes after it.
    return this.call(actor, workspaceId, (handle) =>
      dispatch(() => {
        onDispatch?.();
        return handle.call('ask', request);
      }),
    );
  }

  /** A running runtime answers itself; a stopped one is listed from its index, without being woken. */
  async conversations(actor: string, workspaceId: string): Promise<ConversationSummary[]> {
    const record = await readRecord(this.dataRoot, actor, workspaceId);
    const entry = this.live.get(this.key(record));
    if (entry?.handle && entry.state === 'running') return entry.handle.call('conversations', {});
    return readConversationIndex(this.dataRoot, record.ownerId, record.id);
  }

  async newConversation(
    actor: string,
    workspaceId: string,
    dispatch: (send: () => Promise<SessionRef>) => Promise<SessionRef> = (send) => send(),
  ): Promise<SessionRef> {
    return this.call(actor, workspaceId, (handle) => dispatch(() => handle.call('newConversation', {})));
  }

  async messages(actor: string, workspaceId: string, sessionId: string): Promise<ConversationMessage[]> {
    const ref = parse(SessionRef, { sessionId }, 'INVALID_INPUT');
    return this.call(actor, workspaceId, (handle) => handle.call('messages', ref));
  }

  /** Cancels a running answer. A stopped runtime has nothing running, so there is nothing to cancel. */
  async cancel(
    actor: string,
    workspaceId: string,
    sessionId: string,
    dispatch: (send: () => Promise<{ ok: true }>) => Promise<{ ok: true }> = (send) => send(),
  ) {
    const ref = parse(SessionRef, { sessionId }, 'INVALID_INPUT');
    const record = await readRecord(this.dataRoot, actor, workspaceId);
    const entry = this.live.get(this.key(record));
    if (!entry?.handle || entry.state !== 'running') throw new WorkspaceError('RUNTIME_NOT_RUNNING');
    await dispatch(() => entry.handle!.call('cancel', ref));
  }

  /** Receives the progress events of the owner's Workspace, across stops and resumes. Returns an unsubscribe. */
  async subscribe(actor: string, workspaceId: string, listener: (event: RuntimeEvent) => void) {
    const record = await readRecord(this.dataRoot, actor, workspaceId);
    const key = this.key(record);
    const set = this.listeners.get(key) ?? new Set();
    set.add(listener);
    this.listeners.set(key, set);
    return () => {
      set.delete(listener);
      if (!set.size && this.listeners.get(key) === set) this.listeners.delete(key);
    };
  }

  /** Counts only, for the administrators' health page: no Workspace names, owners or content. */
  stats(): RuntimeStats {
    const entries = [...this.live.values()];
    const count = (state: RuntimeState) => entries.filter((entry) => entry.state === state).length;
    return {
      running: count('running'),
      starting: count('starting'),
      failed: count('failed'),
      max: this.maxRunning,
      busy: entries.filter((entry) => entry.busy > 0).length,
    };
  }

  /** Records user or job activity so the idle policy leaves the runtime running. */
  async touch(actor: string, workspaceId: string) {
    const record = await readRecord(this.dataRoot, actor, workspaceId);
    const entry = this.live.get(this.key(record));
    if (entry) await this.touchRecord(record, entry);
  }

  /** Stops runtimes idle longer than idleMs; returns the ids it stopped. Call it on a timer. */
  async sweepIdle(): Promise<string[]> {
    const cutoff = this.now() - this.idleMs;
    const idle = [...this.live].filter(
      ([key, entry]) =>
        entry.state === 'running' && !entry.busy && !this.activeCalls.get(key) && entry.lastActive < cutoff,
    );
    await Promise.all(idle.map(([key]) => this.stopKey(key)));
    return idle.map(([key]) => key.split('/')[1]);
  }

  async shutdown() {
    this.shuttingDown = true;
    if (this.shutdownAttempt) return this.shutdownAttempt;
    const attempt = (async () => {
      const outcomes = await Promise.allSettled([...this.live.keys()].map((key) => this.stopKey(key)));
      const errors = outcomes.flatMap((outcome) => (outcome.status === 'rejected' ? [outcome.reason] : []));
      if (errors.length === 1) throw errors[0];
      if (errors.length) throw new AggregateError(errors, 'RUNTIME_SHUTDOWN_FAILED');
    })();
    this.shutdownAttempt = attempt;
    try {
      await attempt;
    } finally {
      if (this.shutdownAttempt === attempt) this.shutdownAttempt = undefined;
    }
  }

  private async call<T>(actor: string, workspaceId: string, fn: (handle: RuntimeHandle) => Promise<T>) {
    const record = await readRecord(this.dataRoot, actor, workspaceId);
    const key = this.key(record);
    this.activeCalls.set(key, (this.activeCalls.get(key) ?? 0) + 1);
    let entry: Live | undefined;
    try {
      await this.start(actor, workspaceId);
      entry = this.live.get(key);
      if (!entry?.handle || entry.state !== 'running') throw new WorkspaceError('RUNTIME_NOT_RUNNING');
      entry.busy++;
      try {
        return await fn(entry.handle);
      } finally {
        entry.busy--;
        await this.touchRecord(record, entry);
      }
    } finally {
      const remaining = (this.activeCalls.get(key) ?? 1) - 1;
      if (remaining) this.activeCalls.set(key, remaining);
      else this.activeCalls.delete(key);
    }
  }

  private async stopKey(
    key: string,
    admit?: (signal: () => void) => void,
    authorize?: () => Promise<void>,
  ): Promise<void> {
    // Each caller waits for an earlier attempt, then independently checks authority and retries if needed.
    while (this.live.get(key)?.stopping) {
      await this.live.get(key)!.stopping!.catch(() => {});
    }
    const entry = this.live.get(key);
    if (!entry) {
      await authorize?.();
      admit?.(() => {});
      return;
    }
    const attempt = { rejectedBeforeSignal: false, signalMayHaveOccurred: false };
    entry.stopAttempt = attempt;
    const stopping = (async () => {
      if (entry.starting) await entry.starting.catch(() => {});
      try {
        await authorize?.();
      } catch (error) {
        attempt.rejectedBeforeSignal = true;
        throw error;
      }
      const admitted = (signal: () => void) => {
        let signalled = false;
        try {
          admit!(() => {
            signalled = true;
            attempt.signalMayHaveOccurred = true;
            signal();
          });
        } catch (error) {
          if (!signalled) attempt.rejectedBeforeSignal = true;
          throw error;
        }
      };
      if (!entry.handle) {
        if (admit) admitted(() => {});
        if (this.live.get(key) === entry) this.live.delete(key);
        return;
      }
      const handle = entry.handle;
      if (admit && !handle.stopWithAdmission) {
        attempt.rejectedBeforeSignal = true;
        throw new Error('RUNTIME_STOP_ADMISSION_UNSUPPORTED');
      }
      const previousState = entry.state;
      entry.state = 'stopping';
      try {
        if (admit) await handle.stopWithAdmission!(admitted);
        else {
          attempt.signalMayHaveOccurred = true;
          await handle.stop();
        }
        if (this.live.get(key) === entry) this.live.delete(key);
      } catch (error) {
        if (this.live.get(key) === entry && entry.state === 'stopping') {
          entry.state = attempt.signalMayHaveOccurred ? 'failed' : previousState;
          if (attempt.signalMayHaveOccurred) entry.error = 'RUNTIME_STOP_FAILED';
        }
        if (entry.startupCleanupFailed && attempt.signalMayHaveOccurred)
          throw new WorkspaceError('RUNTIME_STOP_FAILED');
        throw error;
      }
    })();
    entry.stopping = stopping;
    try {
      await stopping;
    } finally {
      if (entry.stopping === stopping) {
        entry.stopping = undefined;
        entry.stopAttempt = undefined;
      }
    }
  }

  private async touchRecord(record: WorkspaceRecord, entry: Live) {
    entry.lastActive = this.now();
    record.lastActiveAt = new Date(entry.lastActive).toISOString();
    await saveRecord(this.dataRoot, record);
    return this.view(record);
  }

  private running() {
    return [...this.live.values()].filter(
      (entry) =>
        entry.state === 'running' ||
        entry.state === 'starting' ||
        entry.state === 'stopping' ||
        !!entry.handle,
    ).length;
  }

  private key(record: WorkspaceRecord) {
    return `${record.ownerId}/${record.id}`;
  }

  private view(record: WorkspaceRecord): Workspace {
    const entry = this.live.get(this.key(record));
    return { ...record, state: entry?.state ?? 'stopped', ...(entry?.error ? { error: entry.error } : {}) };
  }
}
