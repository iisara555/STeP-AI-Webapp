// #63: lossless, owner-safe import of migrated conversation history into one Cloud Workspace.
//
// Why here and not in the engine: the pinned Desktop engine (harness 90ee71ca) has no import contract. Store.create()
// picks its own UUID, Store.save() stamps updatedAt with "now", messages carry no ids, and the runtime's public
// newConversation/ask can only create new turns. The seam is therefore this server-side importer, which writes the
// engine's own on-disk format through the pinned engine's public Store.put()/Store.transaction() (so the session row
// and its search index are exactly what the engine writes) and never patches the pinned harness.
//
// Guarantees, each pinned by server/test/history-import.test.ts:
// - Owner: the target is the authenticated Identity's own Workspace (readRecord: a foreign id is WORKSPACE_NOT_FOUND).
//   A conversation is imported only if its source owner maps, by an administrator-approved one-to-one mapping, to
//   that same identity. There is no target-owner parameter; extra fields fail validation.
// - Exactly once: the session id and ledger key derive from (owner, source, sourceConversationId). A re-run with
//   identical content is `unchanged`; different content is `conflict` and nothing is written; a conversation already
//   imported into another of the owner's Workspaces is `imported_elsewhere`.
// - Atomic: the session row, its search index row and its ledger row commit in one SQLite transaction per
//   conversation; a crash leaves either the whole conversation or nothing.
// - Lossless: title, updatedAt and the ordered messages (roles including `status`, text, timestamps, attachment
//   names) are stored as engine fields; createdAt, stable message ids and attachment metadata references (no bytes)
//   are kept in the ledger row inside the same workspace.sqlite. No other copy of the content is written anywhere.
// - Exclusive: the importer holds the storage root's writer fence (#62), so no Runtime Manager, and therefore no
//   runtime, can write the same workspace.sqlite while it runs.
// - Verifiable: the report has counts and keyed digests only (HMAC-SHA256 under the operator's migration key), never
//   text, titles or source ids; sourceDigest() computes the same entry from the source side for #65's checks.
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { chmodSync, existsSync } from 'node:fs';
import { rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { Store } from '../../../harness/desktop/electron/store.ts';
import type { Message, Session } from '../../../harness/desktop/src/types.ts';
import { credentialStillValid, type Identity } from '../gateway/auth.ts';
import { UserId, WorkspaceError, type ConversationSummary } from './contract.ts';
import { CONVERSATION_INDEX, listRecords, readRecord, workspacePaths } from './storage.ts';
import { WriterFence } from './writer-fence.ts';

/** Engine record kind of the per-conversation import ledger, beside the `session` rows in workspace.sqlite. */
export const HISTORY_IMPORT_KIND = 'history-import';
const ENGINE_FILE = 'workspace.sqlite';

const Timestamp = z
  .string()
  .regex(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/)
  .refine((s) => {
    const t = Date.parse(s);
    return Number.isFinite(t) && new Date(t).toISOString() === s;
  });
const SourceRef = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/);

const Attachment = z.strictObject({
  sourceAttachmentId: SourceRef,
  name: z.string().min(1).max(255),
  mediaType: z.string().min(1).max(255),
  byteLength: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});
const SourceMessage = z.strictObject({
  sourceMessageId: SourceRef,
  role: z.enum(['user', 'assistant', 'status']),
  text: z.string().max(1_000_000),
  at: Timestamp,
  attachments: z.array(Attachment).max(100),
});

/** One migrated conversation, as spikes/063-migration-preview/import_batch.py emits it. Unknown fields fail. */
export const HistoryImportV1 = z
  .strictObject({
    schemaVersion: z.literal(1),
    source: z.literal('supabase'),
    sourceConversationId: z.guid(),
    sourceOwnerId: z.guid(),
    title: z.string().max(10_000),
    createdAt: Timestamp,
    updatedAt: Timestamp,
    messages: z.array(SourceMessage).max(10_000),
  })
  .refine((c) => new Set(c.messages.map((m) => m.sourceMessageId)).size === c.messages.length)
  .refine((c) => {
    const ids = c.messages.flatMap((m) => m.attachments.map((a) => a.sourceAttachmentId));
    return new Set(ids).size === ids.length;
  })
  .refine((c) => c.createdAt <= c.updatedAt);
export type HistoryImportV1 = z.infer<typeof HistoryImportV1>;

/** Administrator-approved pairs (docs/migration-decisions.md §1): Supabase auth user -> gateway user id. */
const OwnerMappings = z.array(z.strictObject({ sourceOwnerId: z.guid(), userId: UserId })).max(100_000);
export type OwnerMapping = z.infer<typeof OwnerMappings>[number];

export type Disposition =
  'imported' | 'unchanged' | 'conflict' | 'refused_owner' | 'imported_elsewhere' | 'invalid';

/** Value-free digest of one conversation: counts plus keyed hashes. */
export type DigestEntry = {
  /** HMAC of the source conversation identity. */
  ref: string;
  messages: number;
  statuses: number;
  attachments: number;
  /** HMAC of the canonical content digest. */
  digest: string;
};
export type ReportEntry = { position: number; disposition: Disposition } & Partial<DigestEntry>;
export type ImportReport = {
  schemaVersion: 1;
  conversations: ReportEntry[];
  counts: Partial<Record<Disposition, number>>;
};

/** What the ledger row keeps: references and hashes, never conversation text. */
type LedgerEntry = {
  schemaVersion: 1;
  key: string;
  source: 'supabase';
  sourceConversationId: string;
  sessionId: string;
  createdAt: string;
  contentDigest: string;
  messages: { sourceMessageId: string; attachments: HistoryImportV1['messages'][number]['attachments'] }[];
  importedAt: string;
};

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const hmac = (key: Uint8Array, value: string) => createHmac('sha256', key).update(value).digest('hex');

function contentDigest(c: HistoryImportV1) {
  // Positional arrays: order is part of the content, and no key-ordering ambiguity exists.
  return sha256(
    JSON.stringify([
      c.schemaVersion,
      c.source,
      c.sourceConversationId,
      c.title,
      c.createdAt,
      c.updatedAt,
      c.messages.map((m) => [
        m.sourceMessageId,
        m.role,
        m.text,
        m.at,
        m.attachments.map((a) => [a.sourceAttachmentId, a.name, a.mediaType, a.byteLength, a.sha256]),
      ]),
    ]),
  );
}

function digestOf(c: HistoryImportV1, key: Uint8Array): DigestEntry {
  return {
    ref: hmac(key, `ref\0${c.source}\0${c.sourceConversationId}`),
    messages: c.messages.length,
    statuses: c.messages.filter((m) => m.role === 'status').length,
    attachments: c.messages.reduce((n, m) => n + m.attachments.length, 0),
    digest: hmac(key, `digest\0${contentDigest(c)}`),
  };
}

function checkKey(key: Uint8Array) {
  if (!(key instanceof Uint8Array) || key.byteLength < 32) throw new Error('DIGEST_KEY_TOO_SHORT');
}

/** The report entry #65 should expect for a source conversation, computed without any destination access. */
export function sourceDigest(conversation: unknown, digestKey: Uint8Array): DigestEntry {
  checkKey(digestKey);
  const parsed = HistoryImportV1.safeParse(conversation);
  if (!parsed.success) throw new WorkspaceError('INVALID_INPUT');
  return digestOf(parsed.data, digestKey);
}

/** Stable per owner and source conversation, independent of the target Workspace. */
function ledgerKey(ownerId: string, c: HistoryImportV1) {
  return sha256(`step-history-import/v1\0${ownerId}\0${c.source}\0${c.sourceConversationId}`);
}
function sessionIdFor(key: string) {
  const h = key.slice(0, 32).split('');
  h[12] = '8'; // RFC 9562 version 8 (custom), variant 10xx
  h[16] = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16);
  const s = h.join('');
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

function engineSession(id: string, c: HistoryImportV1): Session {
  // Exactly the fields Store.create() writes (asserted by the tests against the pinned engine), with source values.
  return {
    id,
    title: c.title,
    project: '',
    team: 'cc',
    connectionId: 'central',
    messages: c.messages.map((m): Message => ({
      role: m.role,
      text: m.text,
      at: m.at,
      ...(m.attachments.length ? { files: m.attachments.map((a) => ({ name: a.name })) } : {}),
    })),
    draft: '',
    revision: 0,
    versions: [],
    proposals: [],
    originalQuery: '',
    answers: [],
    clarification: false,
    status: 'idle',
    updatedAt: c.updatedAt,
    sources: [],
  };
}

/** Owner ids approved for exactly one gateway user, and that user for exactly one owner id. */
function approvedOwners(mappings: unknown) {
  const parsed = OwnerMappings.safeParse(mappings);
  if (!parsed.success) throw new WorkspaceError('INVALID_INPUT');
  const count = (values: string[]) =>
    values.reduce((m, v) => m.set(v, (m.get(v) ?? 0) + 1), new Map<string, number>());
  const sources = count(parsed.data.map((m) => m.sourceOwnerId));
  const users = count(parsed.data.map((m) => m.userId));
  return new Map(
    parsed.data
      .filter((m) => sources.get(m.sourceOwnerId) === 1 && users.get(m.userId) === 1)
      .map((m) => [m.sourceOwnerId, m.userId]),
  );
}

/** Ledger rows of a workspace.sqlite, read without opening the engine (whose Store constructor writes). */
function ledgerRows(file: string): { id: string; value: string }[] {
  if (!existsSync(file)) return [];
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return db.prepare('SELECT id, value FROM records WHERE kind=?').all(HISTORY_IMPORT_KIND) as {
      id: string;
      value: string;
    }[];
  } catch {
    return []; // no records table yet
  } finally {
    db.close();
  }
}

/** Engine files are private to the service account, as runtime-main.ts's umask makes them. */
function privateEngineFiles(dir: string) {
  for (const suffix of ['', '-wal', '-shm']) {
    const file = join(dir, ENGINE_FILE + suffix);
    if (existsSync(file)) chmodSync(file, 0o600);
  }
}

/** Same listing runtime-main.ts writes, so a stopped Workspace lists the imported conversations. */
async function writeIndex(dir: string, store: Store) {
  const list: ConversationSummary[] = store.list<Session>('session').map((s) => ({
    id: s.id,
    title: s.title || '',
    status: s.status,
    ...(s.updatedAt ? { updatedAt: s.updatedAt } : {}),
  }));
  const file = join(dir, CONVERSATION_INDEX);
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, JSON.stringify(list), { mode: 0o600 });
    await rename(temp, file);
  } finally {
    await rm(temp, { force: true });
  }
}

function authenticatedOwner(owner: Identity) {
  if (!credentialStillValid(owner)) throw new Error('OWNER_CREDENTIAL_EXPIRED');
  return owner.userId;
}

export type ImportOptions = {
  /** Default storage layout root (users/<owner>/workspaces/<id>); also the writer-fence root. */
  dataRoot: string;
  /** The authenticated owner (gateway Authenticator result). The only source of the target owner. */
  owner: Identity;
  workspaceId: string;
  mappings: OwnerMapping[];
  conversations: unknown[];
  /** Operator-held migration key (>= 32 bytes) for the report's digests; never stored. */
  digestKey: Uint8Array;
  /** Test-only fault point, called inside a conversation's transaction after all its rows are written. */
  fault?: (position: number) => void;
};

export async function importHistory(options: ImportOptions): Promise<ImportReport> {
  const { dataRoot, owner, workspaceId, mappings, conversations, digestKey, fault } = options;
  checkKey(digestKey);
  if (!Array.isArray(conversations)) throw new WorkspaceError('INVALID_INPUT');
  const fence = WriterFence.acquire(dataRoot);
  try {
    const ownerId = authenticatedOwner(owner);
    const record = await readRecord(dataRoot, ownerId, workspaceId);
    const approved = approvedOwners(mappings);
    const { dir } = workspacePaths(dataRoot, record.ownerId, record.id);
    const elsewhere = new Set<string>();
    for (const other of await listRecords(dataRoot, record.ownerId))
      if (other.id !== record.id)
        for (const row of ledgerRows(
          join(workspacePaths(dataRoot, other.ownerId, other.id).dir, ENGINE_FILE),
        ))
          elsewhere.add(row.id);

    const store = new Store(join(dir, ENGINE_FILE));
    const entries: ReportEntry[] = [];
    try {
      privateEngineFiles(dir);
      // Array.from visits holes in sparse arrays, so they are reported as invalid instead of skipped.
      for (const [position, input] of Array.from(conversations).entries()) {
        const parsed = HistoryImportV1.safeParse(input);
        if (!parsed.success) {
          entries.push({ position, disposition: 'invalid' });
          continue;
        }
        const c = parsed.data;
        const digest = digestOf(c, digestKey);
        const entry = (disposition: Disposition) => entries.push({ position, disposition, ...digest });
        if (approved.get(c.sourceOwnerId) !== record.ownerId) {
          entry('refused_owner');
          continue;
        }
        const key = ledgerKey(record.ownerId, c);
        if (elsewhere.has(key)) {
          entry('imported_elsewhere');
          continue;
        }
        const sessionId = sessionIdFor(key);
        const content = contentDigest(c);
        entry(
          store.transaction((): Disposition => {
            const existing = store.get<LedgerEntry>(HISTORY_IMPORT_KIND, key);
            if (existing) return existing.contentDigest === content ? 'unchanged' : 'conflict';
            if (store.get('session', sessionId)) return 'conflict';
            store.put('session', sessionId, engineSession(sessionId, c));
            const ledger: LedgerEntry = {
              schemaVersion: 1,
              key,
              source: c.source,
              sourceConversationId: c.sourceConversationId,
              sessionId,
              createdAt: c.createdAt,
              contentDigest: content,
              messages: c.messages.map((m) => ({
                sourceMessageId: m.sourceMessageId,
                attachments: m.attachments,
              })),
              importedAt: new Date().toISOString(),
            };
            store.put(HISTORY_IMPORT_KIND, key, ledger);
            fault?.(position);
            return 'imported';
          }),
        );
      }
      await writeIndex(dir, store);
    } finally {
      store.close();
      privateEngineFiles(dir);
    }
    const counts: ImportReport['counts'] = {};
    for (const { disposition } of entries) counts[disposition] = (counts[disposition] ?? 0) + 1;
    return { schemaVersion: 1, conversations: entries, counts };
  } finally {
    fence.release();
  }
}

export type VerifyResult = {
  ok: boolean;
  conversations: { position: number; result: 'match' | 'mismatch' | 'missing' }[];
};

/**
 * Recomputes every imported/unchanged report entry from what the owner's Workspace holds now (engine session plus
 * ledger), read-only. `mismatch` means the stored conversation no longer equals what was imported.
 */
export async function verifyHistoryImport(options: {
  dataRoot: string;
  owner: Identity;
  workspaceId: string;
  digestKey: Uint8Array;
  report: ImportReport;
}): Promise<VerifyResult> {
  const { dataRoot, owner, workspaceId, digestKey, report } = options;
  checkKey(digestKey);
  const record = await readRecord(dataRoot, authenticatedOwner(owner), workspaceId);
  const file = join(workspacePaths(dataRoot, record.ownerId, record.id).dir, ENGINE_FILE);
  const byRef = new Map<string, DigestEntry>();
  const rows = ledgerRows(file);
  if (rows.length) {
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      const get = db.prepare('SELECT value FROM records WHERE kind=? AND id=?');
      for (const row of rows) {
        const ledger = JSON.parse(row.value) as LedgerEntry;
        const raw = get.get('session', ledger.sessionId) as { value: string } | undefined;
        const ref = hmac(digestKey, `ref\0${ledger.source}\0${ledger.sourceConversationId}`);
        if (raw) byRef.set(ref, rebuild(ledger, JSON.parse(raw.value) as Session, digestKey));
      }
    } finally {
      db.close();
    }
  }
  const conversations = report.conversations
    .filter((e) => e.disposition === 'imported' || e.disposition === 'unchanged')
    .map(({ position, ref, messages, statuses, attachments, digest }) => {
      const now = ref === undefined ? undefined : byRef.get(ref);
      if (!now) return { position, result: 'missing' as const };
      const same = JSON.stringify(now) === JSON.stringify({ ref, messages, statuses, attachments, digest });
      return { position, result: same ? ('match' as const) : ('mismatch' as const) };
    });
  return { ok: conversations.every((c) => c.result === 'match'), conversations };
}

/** The imported conversation as the Workspace holds it now, or a sentinel that matches no report entry. */
function rebuild(ledger: LedgerEntry, session: Session, key: Uint8Array): DigestEntry {
  const stored = session.messages.slice(0, ledger.messages.length);
  const namesKept = stored.every(
    (m, i) =>
      JSON.stringify(m.files?.map((f) => f.name) ?? []) ===
      JSON.stringify(ledger.messages[i].attachments.map((a) => a.name)),
  );
  const candidate = HistoryImportV1.safeParse({
    schemaVersion: 1,
    source: ledger.source,
    sourceConversationId: ledger.sourceConversationId,
    sourceOwnerId: '00000000-0000-0000-0000-000000000000', // not part of the digest
    title: session.title,
    createdAt: ledger.createdAt,
    updatedAt: session.updatedAt,
    messages: stored.map((m, i) => ({
      sourceMessageId: ledger.messages[i].sourceMessageId,
      role: m.role,
      text: m.text,
      at: m.at,
      attachments: ledger.messages[i].attachments,
    })),
  });
  if (!candidate.success || !namesKept || stored.length !== ledger.messages.length)
    return { ref: '', messages: -1, statuses: -1, attachments: -1, digest: '' };
  return digestOf(candidate.data, key);
}
