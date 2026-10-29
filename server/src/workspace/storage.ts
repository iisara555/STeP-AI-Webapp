// Folder layout of ADR 0001 §2. Every path is built from validated ids under the data root, and a Workspace is
// looked up only under its owner's folder, so one user's request can never name another user's Workspace.
import { mkdir, readdir, readFile, rename, writeFile, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { parse, UserId, WorkspaceError, WorkspaceId, WorkspaceRecord, type RuntimeSpec } from './contract.ts';

const PRIVATE = 0o700;

export function workspacePaths(dataRoot: string, userId: string, workspaceId: string): RuntimeSpec {
  const ownerId = parse(UserId, userId, 'INVALID_ID');
  const id = parse(WorkspaceId, workspaceId, 'INVALID_ID');
  const dir = join(resolve(dataRoot), 'users', ownerId, 'workspaces', id);
  return { workspaceId: id, ownerId, dir, filesDir: join(dir, 'files') };
}

export async function createWorkspaceFolders(dataRoot: string, record: WorkspaceRecord) {
  const paths = workspacePaths(dataRoot, record.ownerId, record.id);
  // mkdir's mode applies only to folders it creates; users/<id> and workspaces/ are private too.
  for (const dir of [
    join(resolve(dataRoot), 'users', record.ownerId),
    join(resolve(dataRoot), 'users', record.ownerId, 'workspaces'),
    paths.dir,
    paths.filesDir,
    join(paths.dir, 'snapshots'),
  ])
    await mkdir(dir, { recursive: true, mode: PRIVATE });
  await saveRecord(dataRoot, record);
  return paths;
}

export async function saveRecord(dataRoot: string, record: WorkspaceRecord) {
  const { dir } = workspacePaths(dataRoot, record.ownerId, record.id);
  const file = join(dir, 'workspace.json');
  const temp = file + '.' + randomUUID() + '.tmp';
  try {
    await writeFile(temp, JSON.stringify(record, null, 2), { mode: 0o600 });
    await rename(temp, file);
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
