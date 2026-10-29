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
  type ConversationSummary,
  type RuntimeDriver,
  type RuntimeHandle,
  type RuntimeHealth,
  type RuntimeState,
  type Workspace,
  type WorkspaceRecord,
} from './contract.ts';
import { createWorkspaceFolders, listRecords, readRecord, saveRecord, workspacePaths } from './storage.ts';

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
  stopping?: Promise<void>;
  lastActive: number;
  /** Requests in flight; a busy runtime is never stopped as idle, so work goes on after the browser closes. */
  busy: number;
  error?: string;
};

export class RuntimeManager {
  private readonly live = new Map<string, Live>();
  private readonly activeCalls = new Map<string, number>();
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
    if (current?.stopping) {
      await current.stopping;
      return this.start(actor, workspaceId);
    }
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
        entry.handle = handle;
        entry.state = 'running';
        handle.onExit(() => {
          if (this.live.get(key) !== entry) return;
          if (entry.state !== 'stopping')
            Object.assign(entry, { state: 'failed', handle: undefined, error: 'RUNTIME_EXITED' });
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
  async ask(actor: string, workspaceId: string, input: AskInput): Promise<AskResult> {
    const request = parse(AskInput, input, 'INVALID_INPUT');
    return this.call(actor, workspaceId, (handle) => handle.call('ask', request));
  }

  async conversations(actor: string, workspaceId: string): Promise<ConversationSummary[]> {
    return this.call(actor, workspaceId, (handle) => handle.call('conversations', {}));
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
    await Promise.all([...this.live.keys()].map((key) => this.stopKey(key)));
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

  private async stopKey(key: string) {
    const entry = this.live.get(key);
    if (!entry) return;
    if (entry.stopping) return entry.stopping;
    entry.stopping = (async () => {
      if (entry.starting) await entry.starting.catch(() => {});
      try {
        if (entry.handle) {
          entry.state = 'stopping';
          await entry.handle.stop();
        }
      } finally {
        if (this.live.get(key) === entry) this.live.delete(key);
      }
    })();
    return entry.stopping;
  }

  private async touchRecord(record: WorkspaceRecord, entry: Live) {
    entry.lastActive = this.now();
    record.lastActiveAt = new Date(entry.lastActive).toISOString();
    await saveRecord(this.dataRoot, record);
    return this.view(record);
  }

  private running() {
    return [...this.live.values()].filter(
      (entry) => entry.state === 'running' || entry.state === 'starting' || entry.state === 'stopping',
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
