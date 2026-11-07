// Nonprivileged integration boundary, NOT a root transport or a native launch capability.
// Never compose DiskQuotaAuthority/DiskQuotaLedger here: qb_ensure owns allocation and p<ID> creation.
import { closeSync, constants, fstatSync, openSync } from 'node:fs';
import { lstat, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { UserId, WorkspaceId, type RuntimeDriver, type RuntimeSpec } from './contract.ts';
import {
  createWorkspaceFolders,
  readConversationIndexAt,
  workspaceStorage,
  type WorkspaceStorage,
} from './storage.ts';

const CanonicalUuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const Uint64 = z
  .string()
  .regex(/^[1-9][0-9]{0,19}$/)
  .refine((s) => BigInt(s) <= 18446744073709551615n);
const Limits = z.strictObject({
  mountUuid: CanonicalUuid.refine((uuid) => /[1-9a-f]/.test(uuid)),
  bytesHard: z.number().int().min(4096).max(1099511627776).multipleOf(4096),
  inodesHard: z.number().int().min(1).max(10000000),
});
const Receipt = Limits.extend({
  workspaceUuid: CanonicalUuid,
  projectId: z.number().int().min(100000).max(199999),
  device: Uint64,
  inode: Uint64,
  projectInherit: z.literal(true),
  quotaEnforced: z.literal(true),
}).strict();

/** Application-side seam, NOT a wire response format. A future trusted transport must bind
 * workspaceUuid to this exact request, limits/mount/enforcement to protected broker policy,
 * and device/inode/project to qb_receipt + its retained FD. qb_receipt alone lacks the
 * UUID/enforcement fields. No manager-supplied owner/UID/path/project/limits cross the wire.
 * The transport must close received FDs even on errors. No such transport ships here.
 */
export type NativeQuotaRpc = { ensure(frame: string): Promise<unknown> };
export type NativeQuotaOptions = {
  /** Required: this adapter reopens paths and cannot safely consume a root-owned FD for launch.
   * Only disposable, unprivileged synthetic fixtures are supported. Not a production switch.
   */
  mode: 'synthetic-only';
  dataRoot: string;
  projectRoot: string;
  mountUuid: string;
  bytesHard: number;
  inodesHard: number;
  firstProjectId: number;
  lastProjectId: number;
  /** Trusted out-of-band owner -> authenticated peer binding; never a request field. */
  forOwner(ownerId: string): NativeQuotaRpc;
};

/** A lossless bijection, not UUID repair: validate the original ws_ token before encoding it. */
export function nativeWorkspaceUuid(workspaceId: string): string {
  const hex = WorkspaceId.parse(workspaceId).slice(3);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// Synthetic path consistency check at preparation; launch identity is fenced separately by pin().
async function checkedDirectory(path: string) {
  let current = path;
  while (true) {
    const stat = await lstat(current, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('NATIVE_QUOTA_UNSAFE_PATH');
    const parent = dirname(current);
    if (current === path && parent === current) throw Error('NATIVE_QUOTA_UNSAFE_PATH');
    if (parent === current) return;
    current = parent;
  }
}

/** Explicit paired storage/driver composition for RuntimeManager. Native project directories are
 * never mkdir'd, renamed, removed, adopted or allocated by TS. Only workload-owned children
 * files/ and snapshots/ are prepared inside the broker-created root, after verified provisioning.
 * users/... holds bounded control metadata ONLY; it is never a runtime cwd or a project alias.
 */
export function nativeQuotaBoundary(
  input: NativeQuotaOptions,
  driver: RuntimeDriver,
): {
  storage: WorkspaceStorage;
  driver: RuntimeDriver;
} {
  if (input.mode !== 'synthetic-only') throw Error('NATIVE_QUOTA_PRODUCTION_UNAVAILABLE');
  const options = Object.freeze({ ...input });
  const limits = Limits.parse({
    mountUuid: options.mountUuid,
    bytesHard: options.bytesHard,
    inodesHard: options.inodesHard,
  });
  const range = z
    .object({
      first: z.number().int().min(100000).max(199999),
      last: z.number().int().min(100000).max(199999),
    })
    .refine((r) => r.first <= r.last)
    .parse({ first: options.firstProjectId, last: options.lastProjectId });
  const dataRoot = resolve(options.dataRoot);
  const projectRoot = resolve(options.projectRoot);
  // Control metadata cannot become quota-managed workload content (or vice versa).
  if (
    dataRoot === projectRoot ||
    dataRoot.startsWith(projectRoot + '/') ||
    projectRoot.startsWith(dataRoot + '/')
  )
    throw Error('NATIVE_QUOTA_UNSAFE_PATH');
  if (!driver.startWithAdmission) throw Error('RUNTIME_START_ADMISSION_UNSUPPORTED');
  // A pathname bind re-resolves p<ID> at spawn: a rename+substitute after verification would be launched into.
  const pinned = driver.startPinnedWithAdmission?.bind(driver);
  if (!pinned) throw Error('RUNTIME_PINNED_LAUNCH_UNSUPPORTED');
  const metadata = workspaceStorage(dataRoot);
  // Pair the storage and driver halves: arbitrary or copied paths are never accepted.
  // This is a one-use internal consistency marker, NOT authorization (admit is still required).
  // Maps each one-use spec to the identity the receipt and lstat agreed on.
  const preparedSpecs = new WeakMap<RuntimeSpec, { device: string; inode: string }>();
  async function prepare(owner: string, id: string) {
    const ownerId = UserId.parse(owner);
    const workspaceId = WorkspaceId.parse(id);
    const workspaceUuid = nativeWorkspaceUuid(workspaceId);
    const rpc = options.forOwner(ownerId);
    const result = Receipt.safeParse(await rpc.ensure(`ENSURE/1 ${workspaceUuid}\n`));
    if (
      !result.success ||
      result.data.workspaceUuid !== workspaceUuid ||
      result.data.projectId < range.first ||
      result.data.projectId > range.last ||
      result.data.mountUuid !== limits.mountUuid ||
      result.data.bytesHard !== limits.bytesHard ||
      result.data.inodesHard !== limits.inodesHard
    )
      throw Error('NATIVE_QUOTA_UNVERIFIED');
    const receipt = result.data;
    const dir = join(projectRoot, `p${receipt.projectId}`);
    await checkedDirectory(dir);
    const stat = await lstat(dir, { bigint: true });
    if (String(stat.dev) !== receipt.device || String(stat.ino) !== receipt.inode)
      throw Error('NATIVE_QUOTA_UNVERIFIED');
    // No recursive mkdir: a missing p<ID> must fail, not recreate protected native state.
    for (const name of ['files', 'snapshots']) {
      const child = join(dir, name);
      try {
        await mkdir(child, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      await checkedDirectory(child);
    }
    const spec: RuntimeSpec = Object.freeze({ ownerId, workspaceId, dir, filesDir: join(dir, 'files') });
    return { spec, identity: { device: receipt.device, inode: receipt.inode } };
  }
  /** Synchronous pin taken inside admission right before spawn: open without following a final symlink, then
   * re-verify the descriptor (not the path) against the receipt. The returned FD is owned by the driver. */
  function pin(dir: string, identity: { device: string; inode: string }) {
    // libuv always adds O_CLOEXEC; only the driver's explicit stdio mapping hands this FD to a child.
    const fd = openSync(dir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      const stat = fstatSync(fd, { bigint: true });
      if (!stat.isDirectory() || String(stat.dev) !== identity.device || String(stat.ino) !== identity.inode)
        throw Error('NATIVE_QUOTA_UNVERIFIED');
      return fd;
    } catch (error) {
      closeSync(fd);
      throw error;
    }
  }
  return {
    storage: {
      ...metadata,
      async create(record, admit) {
        await prepare(record.ownerId, record.id);
        // Provisioning completion is NOT admission: manager's synchronous quota/publication
        // fence still runs after this await. Denial leaves native reservations untouched.
        return createWorkspaceFolders(dataRoot, record, admit, false);
      },
      async runtimePaths(record) {
        const { spec, identity } = await prepare(record.ownerId, record.id);
        preparedSpecs.set(spec, identity);
        return spec;
      },
      conversations: async (record) =>
        readConversationIndexAt((await prepare(record.ownerId, record.id)).spec.dir),
    },
    driver: {
      async start() {
        throw Error('NATIVE_QUOTA_ADMISSION_REQUIRED');
      },
      // Never move admit before the async preparation, manufacture admission, wrap handles,
      // swallow cleanup errors or turn receipts into reusable launch authorization.
      async startWithAdmission(spec, admit) {
        const identity = preparedSpecs.get(spec);
        if (!identity || !preparedSpecs.delete(spec)) throw Error('NATIVE_QUOTA_UNSAFE_SPEC');
        // A failed pin throws inside the spawn callback, so admission fails and nothing is spawned.
        return pinned(spec, () => pin(spec.dir, identity), admit);
      },
    },
  };
}
