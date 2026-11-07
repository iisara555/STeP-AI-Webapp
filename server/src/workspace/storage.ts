// Folder layout of ADR 0001 §2. Every path is built from validated ids under the data root, and a Workspace is
// looked up only under its owner's folder, so one user's request can never name another user's Workspace.
import { randomUUID } from 'node:crypto';
import { renameSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  parse,
  UserId,
  WorkspaceError,
  WorkspaceId,
  WorkspaceRecord,
  type ConversationSummary,
  type RuntimeSpec,
} from './contract.ts';

const PRIVATE = 0o700;

export function workspacePaths(dataRoot: string, userId: string, workspaceId: string): RuntimeSpec {
  const ownerId = parse(UserId, userId, 'INVALID_ID');
  const id = parse(WorkspaceId, workspaceId, 'INVALID_ID');
  const dir = join(resolve(dataRoot), 'users', ownerId, 'workspaces', id);
  return { workspaceId: id, ownerId, dir, filesDir: join(dir, 'files') };
}

export async function createWorkspaceFolders(
  dataRoot: string,
  record: WorkspaceRecord,
  admit: (publish: () => void) => void = (publish) => publish(),
  runtimeFolders = true,
) {
  const paths = workspacePaths(dataRoot, record.ownerId, record.id);
  const parent = join(resolve(dataRoot), 'users', record.ownerId, 'workspaces');
  await mkdir(parent, { recursive: true, mode: PRIVATE });
  // An invalid workspace ID keeps the prepared directory invisible to listRecords.
  const staging = await mkdtemp(join(parent, '.creating-'));
  try {
    if (runtimeFolders) {
      await mkdir(join(staging, 'files'), { mode: PRIVATE });
      await mkdir(join(staging, 'snapshots'), { mode: PRIVATE });
    }
    await writeFile(join(staging, 'workspace.json'), JSON.stringify(record, null, 2), { mode: 0o600 });
    // Rename is the publication point. The admission callback must run it synchronously.
    admit(() => renameSync(staging, paths.dir));
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  return paths;
}

export async function saveRecord(
  dataRoot: string,
  record: WorkspaceRecord,
  admit: (publish: () => void) => void = (publish) => publish(),
) {
  const { dir } = workspacePaths(dataRoot, record.ownerId, record.id);
  const file = join(dir, 'workspace.json');
  const temp = file + '.' + randomUUID() + '.tmp';
  try {
    await writeFile(temp, JSON.stringify(record, null, 2), { mode: 0o600 });
    admit(() => renameSync(temp, file));
  } finally {
    await rm(temp, { force: true });
  }
}

/** The owner's own Workspace, or WORKSPACE_NOT_FOUND; a foreign id looks exactly like one that does not exist. */
export async function readRecord(dataRoot: string, userId: string, workspaceId: string) {
  const { dir, ownerId, workspaceId: id } = workspacePaths(dataRoot, userId, workspaceId);
  let raw: string;
  try {
    raw = await readFile(join(dir, 'workspace.json'), 'utf8');
  } catch {
    throw new WorkspaceError('WORKSPACE_NOT_FOUND');
  }
  const record = WorkspaceRecord.safeParse(JSON.parse(raw));
  if (!record.success || record.data.ownerId !== ownerId || record.data.id !== id)
    throw new WorkspaceError('WORKSPACE_NOT_FOUND');
  return record.data;
}

export async function listRecords(dataRoot: string, userId: string) {
  const ownerId = parse(UserId, userId, 'INVALID_ID');
  let names: string[];
  try {
    names = await readdir(join(resolve(dataRoot), 'users', ownerId, 'workspaces'));
  } catch {
    return [];
  }
  const records: WorkspaceRecord[] = [];
  for (const name of names) {
    if (!WorkspaceId.safeParse(name).success) continue;
    try {
      records.push(await readRecord(dataRoot, ownerId, name));
    } catch {
      // A half-created folder is not a Workspace.
    }
  }
  return records.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** The runtime's own list of its conversations, written in its folder so a stopped Workspace can be listed. */
export const CONVERSATION_INDEX = 'conversations.json';

export async function readConversationIndex(dataRoot: string, userId: string, workspaceId: string) {
  const { dir } = workspacePaths(dataRoot, userId, workspaceId);
  return readConversationIndexAt(dir);
}

export async function readConversationIndexAt(dir: string) {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(join(dir, CONVERSATION_INDEX), 'utf8'));
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (c): c is ConversationSummary =>
        typeof c?.id === 'string' && typeof c.title === 'string' && typeof c.status === 'string',
    )
    .map(({ id, title, status, updatedAt }) => ({
      id,
      title,
      status,
      ...(typeof updatedAt === 'string' ? { updatedAt } : {}),
    }));
}

/** Explicit manager storage seam: control metadata and runtime contents may have different roots. */
export function workspaceStorage(dataRoot: string) {
  return {
    create: (record: WorkspaceRecord, admit: (publish: () => void) => void) =>
      createWorkspaceFolders(dataRoot, record, admit),
    list: (ownerId: string) => listRecords(dataRoot, ownerId),
    read: (ownerId: string, workspaceId: string) => readRecord(dataRoot, ownerId, workspaceId),
    save: (record: WorkspaceRecord, admit: (publish: () => void) => void) =>
      saveRecord(dataRoot, record, admit),
    runtimePaths: async (record: WorkspaceRecord): Promise<RuntimeSpec> =>
      workspacePaths(dataRoot, record.ownerId, record.id),
    conversations: (record: WorkspaceRecord) => readConversationIndex(dataRoot, record.ownerId, record.id),
  };
}
export type WorkspaceStorage = ReturnType<typeof workspaceStorage>;
