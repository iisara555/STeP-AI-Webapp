// Runtime Manager (ADR 0001 §3, phases 1–2): create, start, stop, resume and health of Workspace runtimes. Every call
// names the acting user, and a Workspace is reachable only through its owner; sharing by ACL comes later and must
// be granted explicitly, never by being in the same tenant.
import {
  AskInput,
  newWorkspaceId,
  ProviderGrant,
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
  lastActive: number;
  /** Requests in flight; a busy runtime is never stopped as idle, so work goes on after the browser closes. */
  busy: number;
  error?: string;
};

export type RuntimeStats = { running: number; starting: number; failed: number; max: number; busy: number };

export class RuntimeManager {
  private readonly live = new Map<string, Live>();
  /** Event listeners by Workspace; they outlive a runtime so a resumed Workspace keeps reporting to them. */
  private readonly listeners = new Map<string, Set<(event: RuntimeEvent) => void>>();
  private readonly dataRoot: string;
  private readonly driver: RuntimeDriver;
  private readonly maxRunning: number;
  private readonly idleMs: number;
  private readonly now: () => number;
  private readonly grant: NonNullable<RuntimeManagerOptions['grant']>;

  constructor({
    dataRoot,
    driver,
    maxRunning = 8,
    idleMs = 30 * 60_000,
    now = Date.now,
    grant = () => undefined,
  }: RuntimeManagerOptions) {
    this.dataRoot = dataRoot;
    this.driver = driver;
    this.maxRunning = maxRunning;
    this.idleMs = idleMs;
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
    const record = await readRecord(this.dataRoot, actor, workspaceId);
    const key = this.key(record);
    const current = this.live.get(key);
    if (current?.state === 'running') return this.touchRecord(record, current);
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
        try {
          const provider = await this.grant(record.ownerId, record.id);
          if (provider) await handle.call('connect', ProviderGrant.parse(provider));
        } catch (error) {
          await handle.stop();
          throw error;
        }
        handle.onEvent?.((event) => {
          for (const listener of this.listeners.get(key) ?? []) listener(event);
        });
        entry.handle = handle;
        entry.state = 'running';
        handle.onExit(() => {
          if (this.live.get(key) !== entry) return;
          if (entry.state === 'stopping') this.live.delete(key);
          else Object.assign(entry, { state: 'failed', handle: undefined, error: 'RUNTIME_EXITED' });
        });
      } catch {
        Object.assign(entry, { state: 'failed', error: 'RUNTIME_START_FAILED' });
        throw new WorkspaceError('RUNTIME_START_FAILED');
      } finally {
        entry.starting = undefined;
      }
    })();
    await entry.starting;
    return this.touchRecord(record, entry);
  }

  async stop(actor: string, workspaceId: string): Promise<Workspace> {
    const record = await readRecord(this.dataRoot, actor, workspaceId);
    await this.stopKey(this.key(record));
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
  ): Promise<AskResult> {
    const request = parse(AskInput, input, 'INVALID_INPUT');
    // onDispatch runs just before the request is sent; the channel keeps order, so a later cancel comes after it.
    return this.call(actor, workspaceId, (handle) => {
      onDispatch?.();
      return handle.call('ask', request);
    });
  }

  /** A running runtime answers itself; a stopped one is listed from its index, without being woken. */
  async conversations(actor: string, workspaceId: string): Promise<ConversationSummary[]> {
    const record = await readRecord(this.dataRoot, actor, workspaceId);
    const entry = this.live.get(this.key(record));
    if (entry?.handle && entry.state === 'running') return entry.handle.call('conversations', {});
    return readConversationIndex(this.dataRoot, record.ownerId, record.id);
  }

  async newConversation(actor: string, workspaceId: string): Promise<SessionRef> {
    return this.call(actor, workspaceId, (handle) => handle.call('newConversation', {}));
  }

  async messages(actor: string, workspaceId: string, sessionId: string): Promise<ConversationMessage[]> {
    const ref = parse(SessionRef, { sessionId }, 'INVALID_INPUT');
    return this.call(actor, workspaceId, (handle) => handle.call('messages', ref));
  }

  /** Cancels a running answer. A stopped runtime has nothing running, so there is nothing to cancel. */
  async cancel(actor: string, workspaceId: string, sessionId: string) {
    const ref = parse(SessionRef, { sessionId }, 'INVALID_INPUT');
    const record = await readRecord(this.dataRoot, actor, workspaceId);
    const entry = this.live.get(this.key(record));
    if (!entry?.handle || entry.state !== 'running') throw new WorkspaceError('RUNTIME_NOT_RUNNING');
    await entry.handle.call('cancel', ref);
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
      ([, entry]) => entry.state === 'running' && !entry.busy && entry.lastActive < cutoff,
    );
    await Promise.all(idle.map(([key]) => this.stopKey(key)));
    return idle.map(([key]) => key.split('/')[1]);
  }

  async shutdown() {
    await Promise.all([...this.live.keys()].map((key) => this.stopKey(key)));
  }

  private async call<T>(actor: string, workspaceId: string, fn: (handle: RuntimeHandle) => Promise<T>) {
    const record = await readRecord(this.dataRoot, actor, workspaceId);
    await this.start(actor, workspaceId);
    const entry = this.live.get(this.key(record));
    if (!entry?.handle) throw new WorkspaceError('RUNTIME_NOT_RUNNING');
    entry.busy++;
    try {
      return await fn(entry.handle);
    } finally {
      entry.busy--;
      await this.touchRecord(record, entry);
    }
  }

  private async stopKey(key: string) {
    const entry = this.live.get(key);
    if (!entry) return;
    if (entry.starting) await entry.starting.catch(() => {});
    if (!entry.handle) {
      this.live.delete(key);
      return;
    }
    entry.state = 'stopping';
    await entry.handle.stop();
    this.live.delete(key);
  }

  private async touchRecord(record: WorkspaceRecord, entry: Live) {
    entry.lastActive = this.now();
    record.lastActiveAt = new Date(entry.lastActive).toISOString();
    await saveRecord(this.dataRoot, record);
    return this.view(record);
  }

  private running() {
    return [...this.live.values()].filter((entry) => entry.state === 'running' || entry.state === 'starting')
      .length;
  }

  private key(record: WorkspaceRecord) {
    return `${record.ownerId}/${record.id}`;
  }

  private view(record: WorkspaceRecord): Workspace {
    const entry = this.live.get(this.key(record));
    return { ...record, state: entry?.state ?? 'stopped', ...(entry?.error ? { error: entry.error } : {}) };
  }
}
