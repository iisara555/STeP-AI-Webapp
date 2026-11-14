// Operator-authored metadata only. Never derived from a receipt, request or gateway database.
import { constants } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { CanonicalUuid, parseBrokerPolicy } from './native-quota-socket.ts';

const Grant = z.strictObject({
  userUuid: CanonicalUuid.refine((s) => /[1-9a-f]/.test(s)),
  projectId: z.number().int().min(100000).max(199999),
  bytesHard: z.number().int().min(4096).max(1099511627776).multipleOf(4096),
  inodesHard: z.number().int().min(1).max(10000000),
});
const Document = z.strictObject({
  version: z.literal(1),
  epoch: z.string().regex(/^[0-9a-f]{32}$/),
  mountUuid: CanonicalUuid,
  rootDevice: z.string().regex(/^[1-9][0-9]{0,19}$/),
  rootInode: z.string().regex(/^[1-9][0-9]{0,19}$/),
  users: z.array(Grant).min(1).max(512),
});
const issued = new WeakSet<object>();
export type QuotaExpectationSource = ReturnType<typeof brokerQuotaExpectations>;
export function isQuotaExpectationSource(source: object): boolean {
  return issued.has(source);
}

/** Production anchors at / and requires uid 0 throughout. The explicit synthetic mode anchors
 * at a disposable directory owned by the test uid; it must never be used for production composition.
 * Paths are configuration, not browser/request input. Files are reopened on every operation.
 */
export function brokerQuotaExpectations(options: {
  mode: 'protected' | 'synthetic-only';
  trustRoot?: string;
  policyPath: string;
  expectationsPath: string;
}) {
  if (options.mode !== 'protected' && options.mode !== 'synthetic-only')
    throw Error('NATIVE_QUOTA_EXPECTATIONS_UNSAFE');
  const synthetic = options.mode === 'synthetic-only';
  if (!synthetic && options.trustRoot !== undefined) throw Error('NATIVE_QUOTA_EXPECTATIONS_UNSAFE');
  const root = synthetic ? resolve(options.trustRoot!) : '/';
  const owner = synthetic ? process.getuid!() : 0;
  const paths = [options.policyPath, options.expectationsPath].map((path) => {
    const parts = path.split('/');
    if (parts.some((p) => !p || p === '.' || p === '..')) throw Error('NATIVE_QUOTA_EXPECTATIONS_UNSAFE');
    return parts;
  });
  async function read(parts: string[]) {
    const handles: FileHandle[] = [];
    try {
      // Walk relative to pinned descriptors. O_NOFOLLOW on EVERY component, including trust root.
      const roots = root === '/' ? ['/'] : ['/', ...root.slice(1).split(sep)];
      let dir: FileHandle | undefined;
      for (let i = 0; i < roots.length; i++) {
        const path = dir ? `/proc/self/fd/${dir.fd}/${roots[i]}` : '/';
        dir = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        handles.push(dir);
        // Synthetic tests deliberately stop ancestor trust checks at their explicit scratch root.
        if (!synthetic || i === roots.length - 1) {
          const s = await dir.stat();
          if (s.uid !== owner || s.mode & 0o022) throw Error('NATIVE_QUOTA_EXPECTATIONS_UNSAFE');
        }
      }
      for (let i = 0; i < parts.length; i++) {
        const final = i === parts.length - 1;
        const file = await open(
          `/proc/self/fd/${dir!.fd}/${parts[i]}`,
          constants.O_RDONLY | constants.O_NOFOLLOW | (final ? constants.O_NONBLOCK : constants.O_DIRECTORY),
        );
        handles.push(file);
        const s = await file.stat();
        if (s.uid !== owner || s.mode & 0o022) throw Error('NATIVE_QUOTA_EXPECTATIONS_UNSAFE');
        if (final) {
          if (
            !s.isFile() ||
            s.nlink !== 1 ||
            ![0o600, 0o644].includes(s.mode & 0o7777) ||
            s.size < 1 ||
            s.size > 131072
          )
            throw Error('NATIVE_QUOTA_EXPECTATIONS_UNSAFE');
          // Bounded read even if a trusted operator accidentally grows the file concurrently.
          const buffer = Buffer.alloc(131073);
          const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
          if (bytesRead > 131072) throw Error('NATIVE_QUOTA_EXPECTATIONS_UNSAFE');
          return buffer.subarray(0, bytesRead).toString('utf8');
        }
        dir = file;
      }
      throw Error('NATIVE_QUOTA_EXPECTATIONS_UNSAFE');
    } finally {
      for (const h of handles.reverse()) await h.close();
    }
  }
  const source = Object.freeze({
    async read(userUuid: string) {
      const [policyText, text] = await Promise.all(paths.map(read));
      const policy = parseBrokerPolicy(policyText!);
      const document = Document.parse(JSON.parse(text!));
      const epoch = /^epoch=([0-9a-f]{32})$/m.exec(policyText!)?.[1];
      if (
        document.epoch !== epoch ||
        document.mountUuid !== policy.mountUuid ||
        document.rootDevice !== policy.rootDevice ||
        document.rootInode !== policy.rootInode
      )
        throw Error('NATIVE_QUOTA_EXPECTATIONS_UNVERIFIED');
      const users = new Set<string>();
      const projects = new Set<number>();
      for (const grant of document.users) {
        if (
          users.has(grant.userUuid) ||
          projects.has(grant.projectId) ||
          grant.projectId < policy.firstProjectId ||
          grant.projectId > policy.lastProjectId ||
          grant.bytesHard < policy.bytesHard ||
          grant.inodesHard < policy.inodesHard
        )
          throw Error('NATIVE_QUOTA_EXPECTATIONS_UNVERIFIED');
        users.add(grant.userUuid);
        projects.add(grant.projectId);
      }
      const grant = document.users.find((g) => g.userUuid === CanonicalUuid.parse(userUuid));
      if (!grant) throw Error('NATIVE_QUOTA_NO_USER_POOL');
      return {
        policy,
        grant,
        revision: createHash('sha256').update(policyText!).update('\0').update(text!).digest('hex'),
      };
    },
  });
  issued.add(source);
  return source;
}
