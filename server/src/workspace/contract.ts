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

export type RuntimeHandle = {
  pid?: number;
  health(timeoutMs?: number): Promise<RuntimeHealth>;
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
  | 'RUNTIME_EXITED';

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
