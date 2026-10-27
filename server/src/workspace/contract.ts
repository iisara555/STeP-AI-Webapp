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
  /** /data/users/<user>/workspaces/<workspace>; holds workspace.sqlite, files/ and snapshots/. */
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

/** Requests a runtime answers over its private channel; the Manager is the only caller. */
export type RuntimeCalls = {
  connect: { params: ProviderGrant; result: { ok: true } };
  ask: { params: AskInput; result: AskResult };
  conversations: { params: Record<string, never>; result: ConversationSummary[] };
};

export type RuntimeHandle = {
  pid?: number;
  health(timeoutMs?: number): Promise<RuntimeHealth>;
  call<M extends keyof RuntimeCalls>(
    method: M,
    params: RuntimeCalls[M]['params'],
  ): Promise<RuntimeCalls[M]['result']>;
  stop(): Promise<void>;
  /** Called once when the runtime ends for any reason, including stop(). */
  onExit(listener: (code: number | null) => void): void;
};

/** Docker, Podman or a systemd sandbox can replace the process driver without changing the contract. */
export type RuntimeDriver = {
  start(spec: RuntimeSpec): Promise<RuntimeHandle>;
};

export type WorkspaceErrorCode =
  | 'INVALID_ID'
  | 'INVALID_NAME'
  | 'WORKSPACE_NOT_FOUND'
  | 'RUNTIME_CAPACITY'
  | 'RUNTIME_START_FAILED'
  | 'RUNTIME_EXITED'
  | 'RUNTIME_NOT_RUNNING'
  | 'RUNTIME_CALL_FAILED'
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
