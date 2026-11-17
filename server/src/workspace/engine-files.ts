// Engine files of a Workspace (workspace.sqlite and its SQLite side files) as seen by host-side writers such as
// the history and document importers. The workspace folder is mounted read-write into its runtime, so these
// paths are untrusted: a runtime can replace any of them with a symlink or hard link to a file elsewhere.
import { closeSync, constants, fchmodSync, fstatSync, lstatSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { WorkspaceError } from './contract.ts';

export const ENGINE_FILE = 'workspace.sqlite';
export const ENGINE_FILES = [ENGINE_FILE, `${ENGINE_FILE}-wal`, `${ENGINE_FILE}-shm`];

/**
 * The workspace folder is mounted read-write into its runtime, so a runtime can replace workspace.sqlite or a SQLite
 * side file with a symlink (or a hard link) to a database elsewhere. Opening, writing or chmod-ing such a path would
 * act on that other file. Every engine file that exists must be a single-link regular file inside a real directory.
 * No runtime can swap it after this check during an import: the writer fence is held and no launch is pending.
 */
export function requireRealEngineFiles(dir: string) {
  const unsafe = () => new WorkspaceError('WORKSPACE_PATH_UNSAFE');
  let folder;
  try {
    folder = lstatSync(dir);
  } catch {
    throw unsafe();
  }
  if (!folder.isDirectory()) throw unsafe();
  for (const name of ENGINE_FILES) {
    let file;
    try {
      file = lstatSync(join(dir, name));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw unsafe();
    }
    if (!file.isFile() || file.nlink !== 1) throw unsafe();
  }
}

/** Engine files are private to the service account, as runtime-main.ts's umask makes them. */
export function privateEngineFiles(dir: string) {
  for (const name of ENGINE_FILES) {
    let fd: number;
    try {
      // O_NOFOLLOW: never chmod through a symlink, even if one appeared after requireRealEngineFiles.
      fd = openSync(join(dir, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw new WorkspaceError('WORKSPACE_PATH_UNSAFE');
    }
    try {
      const file = fstatSync(fd);
      if (!file.isFile() || file.nlink !== 1) throw new WorkspaceError('WORKSPACE_PATH_UNSAFE');
      fchmodSync(fd, 0o600);
    } finally {
      closeSync(fd);
    }
  }
}
