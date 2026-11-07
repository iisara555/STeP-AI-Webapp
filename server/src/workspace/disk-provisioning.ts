// Disk/inode quota protocol. No sudo, shell helper or privileged implementation lives here.
import { z } from 'zod';
import type { DatabaseSync } from 'node:sqlite';
import { UserId, WorkspaceId, type RuntimeDriver, type RuntimeSpec } from './contract.ts';
import { workspacePaths } from './storage.ts';

const Policy = z
  .strictObject({
    mountUuid: z.uuid(),
    firstProjectId: z.number().int().min(100000).max(199999),
    lastProjectId: z.number().int().min(100000).max(199999),
  })
  .refine((p) => p.firstProjectId <= p.lastProjectId);
export type DiskQuotaPolicy = z.infer<typeof Policy>;
const Reservation = z.object({
  ownerId: UserId,
  workspaceId: WorkspaceId,
  bytesHard: z.number().int().min(4096).max(1099511627776).multipleOf(4096),
  inodesHard: z.number().int().min(1).max(10000000),
});
export type DiskQuotaReservation = z.infer<typeof Reservation>;
export type DiskQuotaAllocation = DiskQuotaReservation & { projectId: number; mountUuid: string };

function configure(db: DatabaseSync) {
  db.exec('PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL; PRAGMA trusted_schema=OFF;');
}

/** Explicit broker bootstrap ONLY, after an administrator has exclusively reserved/censused the range.
 * The caller must supply an independently protected DB, never a gateway/workload-owned file.
 */
export function initializeDiskQuotaLedger(db: DatabaseSync, input: DiskQuotaPolicy): void {
  const policy = Policy.parse(input);
  configure(db);
  db.exec('BEGIN IMMEDIATE');
  try {
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").get())
      throw new Error('DISK_QUOTA_LEDGER_EXISTS');
    db.exec(`
      CREATE TABLE disk_policy (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL,
        mount_uuid TEXT NOT NULL, first_id INTEGER NOT NULL, last_id INTEGER NOT NULL) STRICT;
      CREATE TABLE disk_allocations (project_id INTEGER PRIMARY KEY, owner_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL, bytes_hard INTEGER NOT NULL, inodes_hard INTEGER NOT NULL,
        UNIQUE(owner_id, workspace_id)) STRICT;
    `);
    db.prepare('INSERT INTO disk_policy VALUES (1, 1, ?, ?, ?)').run(
      policy.mountUuid,
      policy.firstProjectId,
      policy.lastProjectId,
    );
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/** Permanent reservations; no delete, clear, caller-selected ID or automatic reinitialization API. */
export class DiskQuotaLedger {
  private readonly policy: DiskQuotaPolicy;
  constructor(
    private readonly db: DatabaseSync,
    input: DiskQuotaPolicy,
  ) {
    this.policy = Policy.parse(input);
    configure(db);
    this.checkPolicy();
  }
  private checkPolicy() {
    let row;
    try {
      row = this.db.prepare('SELECT * FROM disk_policy WHERE id=1').get();
    } catch (cause) {
      throw new Error('DISK_QUOTA_LEDGER_REQUIRED', { cause });
    }
    if (!row) throw new Error('DISK_QUOTA_LEDGER_REQUIRED');
    if (
      row.version !== 1 ||
      row.mount_uuid !== this.policy.mountUuid ||
      row.first_id !== this.policy.firstProjectId ||
      row.last_id !== this.policy.lastProjectId
    )
      throw new Error('DISK_QUOTA_POLICY_MISMATCH');
  }
  reserve(input: DiskQuotaReservation): DiskQuotaAllocation {
    const request = Reservation.parse(input);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.checkPolicy();
      const row = this.db
        .prepare('SELECT * FROM disk_allocations WHERE owner_id=? AND workspace_id=?')
        .get(request.ownerId, request.workspaceId);
      let projectId: number;
      if (row) {
        projectId = Number(row.project_id);
        if (row.bytes_hard !== request.bytesHard || row.inodes_hard !== request.inodesHard)
          throw new Error('DISK_QUOTA_POLICY_MISMATCH');
      } else {
        const last = this.db.prepare('SELECT MAX(project_id) AS last FROM disk_allocations').get()!;
        projectId = last.last === null ? this.policy.firstProjectId : Number(last.last) + 1;
        if (projectId > this.policy.lastProjectId) throw new Error('DISK_QUOTA_CAPACITY');
        this.db
          .prepare('INSERT INTO disk_allocations VALUES (?, ?, ?, ?, ?)')
          .run(projectId, request.ownerId, request.workspaceId, request.bytesHard, request.inodesHard);
      }
      if (
        !Number.isSafeInteger(projectId) ||
        projectId < this.policy.firstProjectId ||
        projectId > this.policy.lastProjectId
      )
        throw new Error('DISK_QUOTA_LEDGER_INVALID');
      this.db.exec('COMMIT');
      return { ...request, projectId, mountUuid: this.policy.mountUuid };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
}

const Grant = Reservation.omit({ workspaceId: true }).strict();
const Evidence = Reservation.extend({
  projectId: z.number().int().min(100000).max(199999),
  mountUuid: z.uuid(),
  projectInherit: z.literal(true),
  quotaEnforced: z.literal(true),
}).strict();
export type DiskQuotaEvidence = z.infer<typeof Evidence>;

export type DiskQuotaAuthorityOptions = {
  ledger: DiskQuotaLedger;
  /** Broker-local policy, resolved from authenticated transport credentials, NOT request fields. */
  authorize: (subject: string, request: { workspaceId: string }) => Promise<z.infer<typeof Grant>>;
  /** Trusted native broker seam, NOT a client callback or shell helper. Must serialize per allocation,
   * pin/verify mount+directory FDs, apply only this permanent allocation, and independently read back
   * both hard limits + project inheritance/enforcement. See docs/workspace-disk-provisioning.md.
   */
  provisionAndVerify: (allocation: Readonly<DiskQuotaAllocation>) => Promise<unknown>;
};

/** Broker-side protocol core. Does not open a socket or claim to implement privileged kernel operations. */
export class DiskQuotaAuthority {
  constructor(private readonly options: DiskQuotaAuthorityOptions) {}
  async ensure(subject: string, input: unknown): Promise<DiskQuotaEvidence> {
    const request = Object.freeze(validateDiskQuotaRequest(input));
    if (typeof subject !== 'string' || !subject.length || subject.length > 256)
      throw new Error('DISK_QUOTA_UNAUTHENTICATED');
    const grant = Grant.parse(await this.options.authorize(subject, request));
    const allocation = Object.freeze(this.options.ledger.reserve({ ...grant, ...request }));
    // COMMIT precedes the first possible kernel mutation. Unknown outcomes keep the ID forever.
    const evidence = Evidence.safeParse(await this.options.provisionAndVerify(allocation));
    if (
      !evidence.success ||
      Object.entries(allocation).some(
        ([key, value]) => evidence.data[key as keyof DiskQuotaEvidence] !== value,
      )
    )
      throw new Error('DISK_QUOTA_UNVERIFIED');
    const current = Grant.parse(await this.options.authorize(subject, request));
    if (Object.entries(grant).some(([key, value]) => current[key as keyof typeof current] !== value))
      throw new Error('DISK_QUOTA_POLICY_MISMATCH');
    return evidence.data;
  }
}

export type DiskQuotaDriverOptions = {
  dataRoot: string;
  mountUuid: string;
  bytesHard: number;
  inodesHard: number;
  /** An authenticated, bounded broker transport bound to its trusted subject out of band.
   * No default/local-success fallback is provided. Receipts are not transferable launch tokens.
   */
  provision: (request: { workspaceId: string }) => Promise<unknown>;
};

/** Explicit composition at the existing runtime seam. Not enabled by ordinary startup.
 * The production broker/launcher must additionally prevent all alternate launch paths.
 */
export function withDiskQuota(driver: RuntimeDriver, input: DiskQuotaDriverOptions): RuntimeDriver {
  const options = Object.freeze({ ...input });
  const expected = Reservation.pick({ bytesHard: true, inodesHard: true })
    .extend({ mountUuid: z.uuid() })
    .parse({ bytesHard: options.bytesHard, inodesHard: options.inodesHard, mountUuid: options.mountUuid });
  if (typeof options.provision !== 'function') throw new Error('DISK_QUOTA_BROKER_REQUIRED');
  async function prepare(spec: RuntimeSpec) {
    const paths = workspacePaths(options.dataRoot, spec.ownerId, spec.workspaceId);
    if (spec.dir !== paths.dir || spec.filesDir !== paths.filesDir) throw new Error('DISK_QUOTA_UNSAFE_SPEC');
    const result = Evidence.safeParse(await options.provision({ workspaceId: paths.workspaceId }));
    if (
      !result.success ||
      result.data.ownerId !== paths.ownerId ||
      result.data.workspaceId !== paths.workspaceId ||
      Object.entries(expected).some(([key, value]) => result.data[key as keyof DiskQuotaEvidence] !== value)
    )
      throw new Error('DISK_QUOTA_UNVERIFIED');
    return Object.freeze(paths);
  }
  const start = driver.start.bind(driver);
  const wrapped: RuntimeDriver = {
    async start(spec) {
      return start(await prepare(spec));
    },
  };
  const admitted = driver.startWithAdmission?.bind(driver);
  if (admitted)
    wrapped.startWithAdmission = async (spec, admit) => {
      const prepared = await prepare(spec);
      // The underlying driver still fences the actual synchronous spawn, AFTER asynchronous provisioning.
      return admitted(prepared, admit);
    };
  return wrapped;
}

const Request = z.strictObject({ workspaceId: WorkspaceId });
export function validateDiskQuotaRequest(input: unknown): { workspaceId: string } {
  const result = Request.safeParse(input);
  if (!result.success) throw new Error('DISK_QUOTA_INVALID_REQUEST');
  return result.data;
}
