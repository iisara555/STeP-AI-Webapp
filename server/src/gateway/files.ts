// A person's own documents in Cloud Workspace: files kept in their Workspace's files folder, which the runtime's
// read-only tools already read (server/src/workspace-tools.ts). The Gateway is the only writer. Names are made safe
// on upload, never trusted on read; links, folders and hidden files are never served; sizes are capped per file and
// per person across all of their Workspaces.
import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { link, lstat, mkdir, readdir, rm } from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import { extname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import type { RuntimeManager } from '../workspace/manager.ts';
import { GatewayError } from './runs.ts';

export type StoredFile = { name: string; bytes: number; modifiedAt: string; mime: string };

export type FileLimits = {
  /** Largest single file. */
  fileBytes: number;
  /** All files of one person, across their Workspaces. */
  userBytes: number;
};

export const DEFAULT_FILE_LIMITS: FileLimits = { fileBytes: 25 * 1024 * 1024, userBytes: 1024 * 1024 * 1024 };

export const MIME_TYPES: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

const MAX_NAME = 120;
const UPLOAD_PREFIX = '.upload-';

/**
 * A name that is one plain file in one folder: no separators, `..`, control or invisible characters, no leading dot.
 * Unsafe characters become `_`, as the owner chose for imports; an empty result becomes `file`.
 */
export function safeFileName(raw: string): string {
  let name = raw
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g, '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s]+/, '')
    .replace(/[.\s]+$/, '');
  if (name.includes('..')) name = name.replace(/\.{2,}/g, '.');
  const ext = extname(name);
  if (name.length > MAX_NAME) name = name.slice(0, MAX_NAME - ext.length).trimEnd() + ext;
  return name || 'file';
}

export function mimeOf(name: string) {
  return MIME_TYPES[extname(name).toLowerCase()] ?? 'application/octet-stream';
}

async function folderBytes(dir: string): Promise<number> {
  let total = 0;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) total += await folderBytes(path);
    else if (entry.isFile()) total += (await lstat(path)).size;
  }
  return total;
}

export class FileStore {
  constructor(
    private readonly manager: RuntimeManager,
    private readonly limits: FileLimits = DEFAULT_FILE_LIMITS,
  ) {}

  async list(actor: string, workspaceId: string): Promise<StoredFile[]> {
    const dir = await this.manager.filesDir(actor, workspaceId);
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const files: StoredFile[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || entry.name.startsWith('.') || safeFileName(entry.name) !== entry.name) continue;
      const info = await lstat(join(dir, entry.name));
      files.push({
        name: entry.name,
        bytes: info.size,
        modifiedAt: info.mtime.toISOString(),
        mime: mimeOf(entry.name),
      });
    }
    return files.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
  }

  /** Saves the request body as a file; a name already in use gets " (2)", " (3)"… instead of replacing it. */
  async save(
    actor: string,
    workspaceId: string,
    rawName: string,
    body: IncomingMessage,
  ): Promise<StoredFile> {
    const dir = await this.manager.filesDir(actor, workspaceId);
    const name = safeFileName(rawName);
    if (!(extname(name).toLowerCase() in MIME_TYPES)) throw new GatewayError('FILE_UNSUPPORTED');
    const declared = Number(body.headers['content-length'] ?? NaN);
    if (Number.isFinite(declared) && declared > this.limits.fileBytes)
      throw new GatewayError('FILE_TOO_LARGE');
    const used = (await Promise.all((await this.manager.allFilesDirs(actor)).map(folderBytes))).reduce(
      (sum, bytes) => sum + bytes,
      0,
    );
    const room = Math.min(this.limits.fileBytes, this.limits.userBytes - used);
    if (room <= 0) throw new GatewayError('STORAGE_FULL');

    await mkdir(dir, { recursive: true, mode: 0o700 });
    const temp = join(dir, UPLOAD_PREFIX + randomUUID());
    const { fileBytes } = this.limits;
    let size = 0;
    const cap = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        size += chunk.length;
        if (size > room) return done(new GatewayError(size > fileBytes ? 'FILE_TOO_LARGE' : 'STORAGE_FULL'));
        done(null, chunk);
      },
    });
    try {
      await pipeline(body, cap, createWriteStream(temp, { flags: 'wx', mode: 0o600 }));
      if (size === 0) throw new GatewayError('FILE_EMPTY');
      const final = await this.place(dir, temp, name);
      const info = await lstat(join(dir, final));
      return { name: final, bytes: info.size, modifiedAt: info.mtime.toISOString(), mime: mimeOf(final) };
    } finally {
      await rm(temp, { force: true });
    }
  }

  /** The file to send, or FILE_NOT_FOUND for anything that is not a plain file of this Workspace. */
  async open(actor: string, workspaceId: string, name: string) {
    const path = await this.plainFile(actor, workspaceId, name);
    const info = await lstat(path);
    return { stream: createReadStream(path), bytes: info.size, mime: mimeOf(name) };
  }

  async remove(actor: string, workspaceId: string, name: string) {
    await rm(await this.plainFile(actor, workspaceId, name));
  }

  private async plainFile(actor: string, workspaceId: string, name: string) {
    if (!name || name.startsWith('.') || safeFileName(name) !== name)
      throw new GatewayError('FILE_NOT_FOUND');
    const path = join(await this.manager.filesDir(actor, workspaceId), name);
    const info = await lstat(path).catch(() => undefined);
    if (!info?.isFile()) throw new GatewayError('FILE_NOT_FOUND');
    return path;
  }

  /** Links the upload under the first free name; a hard link never replaces a file, even in a race. */
  private async place(dir: string, temp: string, name: string) {
    const ext = extname(name);
    const stem = name.slice(0, name.length - ext.length);
    for (let n = 1; n < 1000; n++) {
      const candidate = n === 1 ? name : `${stem} (${n})${ext}`;
      try {
        await link(temp, join(dir, candidate));
        return candidate;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    }
    throw new GatewayError('FILE_NAME_TAKEN');
  }
}
