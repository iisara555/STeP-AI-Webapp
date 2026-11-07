// The Cloud Workspace contract (ADR 0001, phase 1). A Workspace belongs to one user, is private by default and owns
// one isolated runtime while it is open. Gateway, Runtime Manager and drivers speak only in these shapes.
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

/** Starts with a letter or digit, so `.`, `..` and hidden names can never become a folder. */
export const UserId = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/i);
export const WorkspaceId = z.string().regex(/^ws_[0-9a-f]{32}$/);
export const WorkspaceName = z.string().trim().min(1).max(120);

export const WorkspaceRecord = z.object({
  id: WorkspaceId,
  ownerId: UserId,
  name: WorkspaceName,
  createdAt: z.string(),
  lastActiveAt: z.string(),
});
export type WorkspaceRecord = z.infer<typeof WorkspaceRecord>;

export type RuntimeState = 'stopped' | 'starting' | 'running' | 'stopping' | 'failed';

export type Workspace = WorkspaceRecord & {
  state: RuntimeState;
  /** Error code of the last runtime failure; never message text from inside the runtime. */
  error?: string;
};

export type RuntimeHealth = {
  ok: boolean;
  workspaceId: string;
  pid?: number;
  uptimeMs?: number;
  cwd?: string;
};

/** What a driver is given to start one Workspace runtime: its own folders and nothing else. */
export type RuntimeSpec = {
  workspaceId: string;
  ownerId: string;
  /** Runtime content directory, not necessarily the control-metadata directory.
   * Default: /data/users/<user>/workspaces/<workspace>. Native composition: <protected-root>/p<project>.
   * Holds workspace.sqlite, files/ and snapshots/. Paths are never authority to launch.
   */
  dir: string;
  filesDir: string;
};

/**
 * The AI endpoint a runtime may use, issued per start by the Manager (later the Gateway). The token lives only in
 * the runtime's memory: it is never written to workspace.sqlite or passed in the environment (ADR 0001 §2, §7).
 */
export const ProviderGrant = z.object({
  baseUrl: z.url({ protocol: /^https?$/ }),
  model: z.string().min(1).max(160),
  token: z.string().max(4096).optional(),
  /** Public web retrieval needs the Workspace's consent (ADR 0001 §4); off unless granted. */
  publicSearch: z.boolean().default(false),
});
export type ProviderGrant = z.input<typeof ProviderGrant>;

export const AskInput = z.object({
  text: z.string().trim().min(1).max(20_000),
  /** Continue this conversation of the Workspace; a new one is created when absent. */
  sessionId: z.string().min(1).max(200).optional(),
});
export type AskInput = z.input<typeof AskInput>;

export type AskResult = {
  sessionId: string;
  /** The engine's task status; `review` means an answer is ready. */
  status: string;
  answer?: string;
  /** Engine error code when the run did not finish, never message text. */
  code?: string;
  /** Organization documents the answer was grounded on. */
  sources: string[];
};

export type ConversationSummary = { id: string; title: string; status: string; updatedAt?: string };

export const SessionRef = z.object({ sessionId: z.string().min(1).max(200) });
export type SessionRef = z.infer<typeof SessionRef>;

export type ConversationMessage = { role: 'user' | 'assistant'; text: string; at?: string };

/**
 * Progress of a run, pushed by the runtime while it works. `text` is the answer as it streams (delta) or a short
 * progress line (activity); it goes only to the Workspace's owner, never to logs or the audit trail.
 */
export type RuntimeEvent = {
  sessionId: string;
  type: 'delta' | 'discard' | 'activity' | 'status';
  text?: string;
  count?: number;
};

/** Requests a runtime answers over its private channel; the Manager is the only caller. */
export type RuntimeCalls = {
  connect: { params: ProviderGrant; result: { ok: true } };
  ask: { params: AskInput; result: AskResult };
  conversations: { params: Record<string, never>; result: ConversationSummary[] };
  /** A new, empty conversation, so a caller knows its id before the first answer arrives. */
  newConversation: { params: Record<string, never>; result: SessionRef };
  /** Stops the conversation's running answer; the run then ends as `cancelled`. */
  cancel: { params: SessionRef; result: { ok: true } };
  messages: { params: SessionRef; result: ConversationMessage[] };
};

export type RuntimeHandle = {
  pid?: number;
  health(timeoutMs?: number): Promise<RuntimeHealth>;
  /** Enqueue the request synchronously before returning its result Promise. No deferred enqueue is allowed:
   * callers fence this invocation with revocation; only the response may be asynchronous.
   */
  call<M extends keyof RuntimeCalls>(
    method: M,
    params: RuntimeCalls[M]['params'],
  ): Promise<RuntimeCalls[M]['result']>;
  stop(): Promise<void>;
  /**
   * Call admit exactly once with the synchronous operation that performs the initial stop signal/enqueue.
   * Never signal outside that callback. Admission may throw after invoking it, so the signal may have occurred.
   * Resolve only after the runtime has stopped;
   * drivers without this guarantee must omit the method and gateway stops will fail closed.
   */
  stopWithAdmission?(admit: (signal: () => void) => void): Promise<void>;
  /** Called once after process exit is proven, including stop(). A cleanup error means
   * non-process resources remain unconfirmed: retain the handle and retry stop(). */
  onExit(listener: (code: number | null, cleanupError?: WorkspaceError) => void): void;
  /** Progress events of runs inside this runtime. */
  onEvent?(listener: (event: RuntimeEvent) => void): void;
};

/** Docker, Podman or a systemd sandbox can replace the process driver without changing the contract. */
export type RuntimeDriver = {
  start(spec: RuntimeSpec): Promise<RuntimeHandle>;
  /** Invoke admit exactly once synchronously around the actual spawn, not around asynchronous preparation.
   * The spawn callback must run before admit returns; readiness must be awaited after admission returns.
   * A driver must clean up a spawned process if admission throws after invoking spawn.
   * Drivers unable to provide this guarantee must omit this method.
   */
  startWithAdmission?(spec: RuntimeSpec, admit: (spawn: () => void) => void): Promise<RuntimeHandle>;
  /** startWithAdmission whose workload directory is pinned by descriptor, not by pathname. Inside the spawn
   * callback, synchronously and immediately before spawning, the driver must call pin() exactly once; it returns
   * an owned O_DIRECTORY descriptor whose identity the caller has just verified (or throws, which must abort the
   * spawn). The driver must mount spec.dir from that descriptor only (never by resolving spec.dir again) and must
   * close it on every outcome. Drivers that cannot hand the descriptor to the sandbox must omit this method.
   */
  startPinnedWithAdmission?(
    spec: RuntimeSpec,
    pin: () => number,
    admit: (spawn: () => void) => void,
  ): Promise<RuntimeHandle>;
};

/** Startup failed with required process or non-process cleanup still unconfirmed. */
export class RuntimeStartCleanupError extends Error {
  constructor(readonly handle: RuntimeHandle) {
    super('RUNTIME_START_CLEANUP_FAILED');
  }
}

export type WorkspaceErrorCode =
  | 'INVALID_ID'
  | 'INVALID_NAME'
  | 'WORKSPACE_NOT_FOUND'
  | 'RUNTIME_CAPACITY'
  | 'RUNTIME_START_FAILED'
  | 'RUNTIME_STOP_FAILED'
  /** Processes are proven absent, but required non-process cleanup is unconfirmed. */
  | 'RUNTIME_CLEANUP_FAILED'
  | 'RUNTIME_EXITED'
  | 'RUNTIME_NOT_RUNNING'
  | 'RUNTIME_CALL_FAILED'
  /** The result exceeds the bounded transport frame; no partial result was returned. */
  | 'RUNTIME_RESULT_TOO_LARGE'
  | 'INVALID_INPUT';

export class WorkspaceError extends Error {
  constructor(readonly code: WorkspaceErrorCode) {
    super(code);
    this.name = 'WorkspaceError';
  }
}

export const newWorkspaceId = () => `ws_${randomUUID().replaceAll('-', '')}`;

export function parse<T>(schema: z.ZodType<T>, value: unknown, code: WorkspaceErrorCode): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new WorkspaceError(code);
  return result.data;
}
