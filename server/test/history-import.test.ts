// #63: lossless, owner-safe import of migrated conversation history into a Cloud Workspace. SYNTHETIC DATA ONLY:
// the input comes from spikes/063-migration-preview (approved mapping + preview) over its synthetic fixture.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { Store } from '../../harness/desktop/electron/store.ts';
import type { Session } from '../../harness/desktop/src/types.ts';
import type { Identity } from '../src/gateway/auth.ts';
import { newWorkspaceId, WorkspaceError } from '../src/workspace/contract.ts';
import {
  HISTORY_IMPORT_KIND,
  importHistory,
  sourceDigest,
  verifyHistoryImport,
  type ImportReport,
} from '../src/workspace/history-import.ts';
import { RuntimeManager } from '../src/workspace/manager.ts';
import { processDriver } from '../src/workspace/process-driver.ts';
import { createWorkspaceFolders, readConversationIndex, workspacePaths } from '../src/workspace/storage.ts';
import { WriterFence } from '../src/workspace/writer-fence.ts';
import { LaunchJournal } from '../src/workspace/launch-journal.ts';
import { provisionTestQuota } from './support/quota.ts';

const SPIKE = resolve(import.meta.dirname, '../../spikes/063-migration-preview');
const KEY = Buffer.alloc(32, 7); // synthetic migration digest key
const ALICE: Identity = { userId: 'g101', email: 'alice@example.test', admin: false };
const BOB: Identity = { userId: 'g202', email: 'bob@example.test', admin: false };
const MARKER = 'SYNTHETIC-PLAINTEXT-';

type Batch = { mappings: { sourceOwnerId: string; userId: string }[]; conversations: any[] };

/** The synthetic batch exactly as the #63 preview/mapping spike emits it. */
function spikeBatch(): Batch {
  const fixture = readFileSync(join(SPIKE, 'synthetic_history.json'));
  return JSON.parse(
    execFileSync('python3', [join(SPIKE, 'import_batch.py')], { cwd: SPIKE, input: fixture }).toString(),
  );
}
const ALICE_IDS = ['00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002'];

async function withRoot(
  fn: (root: string, workspace: (owner?: Identity) => Promise<string>) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), 'step-history-import-'));
  const workspace = async (owner = ALICE) => {
    const now = new Date().toISOString();
    const id = newWorkspaceId();
    await createWorkspaceFolders(root, {
      id,
      ownerId: owner.userId,
      name: 'Import',
      createdAt: now,
      lastActiveAt: now,
    });
    return id;
  };
  try {
    await fn(root, workspace);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** Keys of a session the pinned engine creates itself, from a throwaway in-memory store. */
function freshSessionKeys() {
  const store = new Store(':memory:');
  try {
    return Object.keys(store.create('central', 'cc'));
  } finally {
    store.close();
  }
}

function sessions(root: string, owner: Identity, workspaceId: string) {
  const store = new Store(join(workspacePaths(root, owner.userId, workspaceId).dir, 'workspace.sqlite'));
  try {
    return {
      sessions: store.list<Session>('session'),
      ledger: store.list<any>(HISTORY_IMPORT_KIND),
      fresh: freshSessionKeys(),
    };
  } finally {
    store.close();
  }
}

const run = (
  root: string,
  workspaceId: string,
  batch: Batch,
  owner = ALICE,
  conversations = batch.conversations,
) =>
  importHistory({
    dataRoot: root,
    owner,
    workspaceId,
    mappings: batch.mappings,
    conversations,
    digestKey: KEY,
  });
const dispositions = (report: ImportReport) => report.conversations.map((c) => c.disposition);

test('imports the owner’s spike conversations losslessly: order, roles, status entries, timestamps, attachments', async () => {
  await withRoot(async (root, workspace) => {
    const batch = spikeBatch();
    const ws = await workspace();
    const report = await run(root, ws, batch);
    // Bob's conversation in the same batch is refused for Alice, not imported anywhere.
    assert.deepEqual(dispositions(report), ['imported', 'imported', 'refused_owner']);
    const { sessions: stored, ledger, fresh } = sessions(root, ALICE, ws);
    assert.equal(stored.length, 2);
    assert.equal(ledger.length, 2);
    const source = batch.conversations[0];
    const session = stored.find((s) => s.title === source.title)!;
    // Same record shape as a session the pinned engine creates itself (plus nothing it does not know).
    assert.deepEqual(Object.keys(session).sort(), fresh.sort());
    assert.equal(session.updatedAt, source.updatedAt);
    assert.equal(session.status, 'idle');
    assert.deepEqual(
      session.messages.map((m) => [m.role, m.text, m.at, m.files]),
      source.messages.map((m: any) => [
        m.role,
        m.text,
        m.at,
        m.attachments.length ? m.attachments.map((a: any) => ({ name: a.name })) : undefined,
      ]),
    );
    const entry = ledger.find((l) => l.sessionId === session.id);
    assert.equal(entry.createdAt, source.createdAt);
    assert.deepEqual(
      entry.messages.map((m: any) => m.sourceMessageId),
      source.messages.map((m: any) => m.sourceMessageId),
    );
    assert.deepEqual(entry.messages[0].attachments, source.messages[0].attachments);
    // Ledger holds references and hashes, never the conversation text.
    assert.ok(!JSON.stringify(ledger).includes(MARKER + 'question'));
    // The runtime's stopped-workspace listing sees both, with the source timestamps.
    const index = await readConversationIndex(root, ALICE.userId, ws);
    assert.deepEqual(
      index.map((c) => c.updatedAt).sort(),
      batch.conversations
        .slice(0, 2)
        .map((c) => c.updatedAt)
        .sort(),
    );
    assert.deepEqual(report.counts, { imported: 2, refused_owner: 1 });
  });
});

test('re-running the same batch is a no-op: same source id never duplicates or rewrites', async () => {
  await withRoot(async (root, workspace) => {
    const batch = spikeBatch();
    const ws = await workspace();
    const first = await run(root, ws, batch);
    const before = sessions(root, ALICE, ws);
    const second = await run(root, ws, batch);
    assert.deepEqual(dispositions(second), ['unchanged', 'unchanged', 'refused_owner']);
    // The digests of an unchanged re-run equal the first run's, so #65 can compare either report.
    assert.deepEqual(
      second.conversations.map((c) => c.digest),
      first.conversations.map((c) => c.digest),
    );
    const after = sessions(root, ALICE, ws);
    assert.deepEqual(
      after.sessions.filter((s) => s.title.startsWith(MARKER)),
      before.sessions.filter((s) => s.title.startsWith(MARKER)),
    );
    assert.equal(after.ledger.length, 2);
  });
});

test('changed source content under the same source id is an explicit conflict, never an overwrite', async () => {
  await withRoot(async (root, workspace) => {
    const batch = spikeBatch();
    const ws = await workspace();
    await run(root, ws, batch);
    const before = sessions(root, ALICE, ws).sessions;
    const changed = structuredClone(batch.conversations);
    changed[0].messages[2].text = MARKER + 'edited-answer';
    changed[1].messages.reverse(); // reordering alone is a change too
    const report = await run(root, ws, batch, ALICE, changed);
    assert.deepEqual(dispositions(report), ['conflict', 'conflict', 'refused_owner']);
    assert.notEqual(report.conversations[0].digest, undefined);
    const after = sessions(root, ALICE, ws).sessions;
    assert.deepEqual(
      after.filter((s) => s.title.startsWith(MARKER)).sort((a, b) => a.id.localeCompare(b.id)),
      before.filter((s) => s.title.startsWith(MARKER)).sort((a, b) => a.id.localeCompare(b.id)),
    );
  });
});

test('order is the source sequence, not timestamp order', async () => {
  await withRoot(async (root, workspace) => {
    const batch = spikeBatch();
    const ws = await workspace();
    // Messages 1a and 1b share a timestamp; put a later-stamped status first to prove no re-sorting happens.
    const [first] = structuredClone(batch.conversations);
    first.sourceConversationId = '00000000-0000-0000-0000-0000000000aa';
    first.messages = [first.messages[3], first.messages[1], first.messages[0], first.messages[2]];
    await run(root, ws, batch, ALICE, [first]);
    const session = sessions(root, ALICE, ws).sessions[0];
    assert.deepEqual(
      session.messages.map((m) => m.text),
      first.messages.map((m: any) => m.text),
    );
  });
});

test('owner is the authenticated workspace owner, never a caller-supplied target', async () => {
  await withRoot(async (root, workspace) => {
    const batch = spikeBatch();
    const alices = await workspace(ALICE);
    const bobs = await workspace(BOB);
    // Bob cannot import into Alice's workspace: it does not exist for him.
    await assert.rejects(
      run(root, alices, batch, BOB),
      (e) => e instanceof WorkspaceError && e.code === 'WORKSPACE_NOT_FOUND',
    );
    // Bob importing into his own workspace gets only his conversation; Alice's are refused.
    assert.deepEqual(dispositions(await run(root, bobs, batch, BOB)), [
      'refused_owner',
      'refused_owner',
      'imported',
    ]);
    // A conversation naming its own target owner is malformed, not obeyed.
    const smuggled = { ...batch.conversations[2], ownerId: ALICE.userId };
    assert.deepEqual(dispositions(await run(root, alices, batch, ALICE, [smuggled])), ['invalid']);
    // Unapproved or ambiguous mappings refuse rather than guess.
    const noMap = await importHistory({
      dataRoot: root,
      owner: ALICE,
      workspaceId: alices,
      mappings: [],
      conversations: batch.conversations.slice(0, 1),
      digestKey: KEY,
    });
    assert.deepEqual(dispositions(noMap), ['refused_owner']);
    const ambiguous = [
      ...batch.mappings,
      { sourceOwnerId: batch.mappings[1].sourceOwnerId, userId: ALICE.userId },
    ];
    const amb = await importHistory({
      dataRoot: root,
      owner: ALICE,
      workspaceId: alices,
      mappings: ambiguous,
      conversations: batch.conversations.slice(0, 1),
      digestKey: KEY,
    });
    assert.deepEqual(dispositions(amb), ['refused_owner']);
    assert.equal(sessions(root, ALICE, alices).sessions.length, 0);
  });
});

test('a conversation lands in exactly one of the owner’s workspaces', async () => {
  await withRoot(async (root, workspace) => {
    const batch = spikeBatch();
    const one = await workspace();
    const two = await workspace();
    await run(root, one, batch);
    assert.deepEqual(dispositions(await run(root, two, batch)), [
      'imported_elsewhere',
      'imported_elsewhere',
      'refused_owner',
    ]);
    assert.equal(sessions(root, ALICE, two).sessions.length, 0);
  });
});

test('refuses while a Runtime Manager (and so any runtime) holds the storage root', async () => {
  await withRoot(async (root, workspace) => {
    const ws = await workspace();
    const fence = WriterFence.acquire(root);
    try {
      await assert.rejects(run(root, ws, spikeBatch()), /WORKSPACE_WRITER_FENCE_HELD/);
    } finally {
      fence.release();
    }
  });
});

test('refuses while a crashed holder left runtime launches that are not yet proven gone', async () => {
  await withRoot(async (root, workspace) => {
    const ws = await workspace();
    // A previous Runtime Manager recorded a launch and was killed before proving it gone: its runtime may still write.
    const fence = WriterFence.acquire(root);
    try {
      LaunchJournal.open(root).record({
        kind: 'step-runner',
        unit: `step-rt-${'a'.repeat(32)}.scope`,
        workspaceId: ws,
      });
    } finally {
      fence.release();
    }
    await assert.rejects(run(root, ws, spikeBatch()), /RUNTIME_RECOVERY_PENDING/);
    // Nothing was imported.
    assert.equal(sessions(root, ALICE, ws).sessions.length, 0);
  });
});

test('malformed conversations are rejected whole, value-free, with nothing written', async () => {
  await withRoot(async (root, workspace) => {
    const batch = spikeBatch();
    const ws = await workspace();
    const base = batch.conversations[0];
    const bad = [
      { ...base, messages: [, ...base.messages] }, // sparse array
      { ...base, messages: [base.messages[0], base.messages[0]] }, // duplicate message id
      { ...base, updatedAt: '2026-03-02 09:30' },
      { ...base, messages: [{ ...base.messages[0], role: 'system' }] },
      {
        ...base,
        messages: [
          { ...base.messages[0], attachments: [{ ...base.messages[0].attachments[0], bytes: 'x' }] },
        ],
      },
      { ...base, sourceConversationId: MARKER + 'not-a-uuid' },
      'not-an-object',
    ];
    const report = await run(root, ws, batch, ALICE, bad);
    assert.deepEqual(
      dispositions(report),
      bad.map(() => 'invalid'),
    );
    assert.ok(!JSON.stringify(report).includes(MARKER));
    assert.equal(sessions(root, ALICE, ws).sessions.length, 0);
  });
});

test('a crash in the middle of an import leaves no partial conversation, and the re-run completes it', async () => {
  await withRoot(async (root, workspace) => {
    const batch = spikeBatch();
    const ws = await workspace();
    // The child writes the first conversation, then is SIGKILLed inside the second conversation's transaction,
    // after its session row and index entry were written but before commit.
    const child = spawn(
      process.execPath,
      [
        '--import',
        import.meta.resolve('tsx'),
        '--import',
        import.meta.resolve('../src/register.mjs'),
        join(import.meta.dirname, 'support/history-import-crash.ts'),
      ],
      { stdio: ['pipe', 'inherit', 'inherit'] },
    );
    child.stdin.end(
      JSON.stringify({ root, workspaceId: ws, owner: ALICE, batch, key: KEY.toString('hex'), crashAt: 1 }),
    );
    const signal = await new Promise((done) => child.on('exit', (_code, signal) => done(signal)));
    assert.equal(signal, 'SIGKILL');
    const after = sessions(root, ALICE, ws);
    assert.deepEqual(
      after.sessions.filter((s) => s.title.startsWith(MARKER)).map((s) => s.title),
      [batch.conversations[0].title],
    );
    assert.equal(after.ledger.length, 1);
    const report = await run(root, ws, batch);
    assert.deepEqual(dispositions(report), ['unchanged', 'imported', 'refused_owner']);
    assert.equal(
      (await verifyHistoryImport({ dataRoot: root, owner: ALICE, workspaceId: ws, digestKey: KEY, report }))
        .ok,
      true,
    );
  });
});

test('digest report verifies against the workspace and against the source, and detects drift', async () => {
  await withRoot(async (root, workspace) => {
    const batch = spikeBatch();
    const ws = await workspace();
    const report = await run(root, ws, batch);
    // #65 pre-cutover: digests computed independently from the source equal the import report's.
    for (const [i, c] of batch.conversations.slice(0, 2).entries()) {
      const expected = sourceDigest(c, KEY);
      const { disposition: _d, position: _p, ...entry } = report.conversations[i];
      assert.deepEqual(entry, expected);
    }
    assert.deepEqual(
      report.conversations
        .slice(0, 2)
        .map(({ messages, statuses, attachments }) => ({ messages, statuses, attachments })),
      [
        { messages: 4, statuses: 1, attachments: 1 },
        { messages: 2, statuses: 0, attachments: 0 },
      ],
    );
    // Value-free: no text, titles or source ids.
    const text = JSON.stringify(report);
    for (const id of ALICE_IDS) assert.ok(!text.includes(id));
    assert.ok(!text.includes(MARKER));
    const ok = await verifyHistoryImport({
      dataRoot: root,
      owner: ALICE,
      workspaceId: ws,
      digestKey: KEY,
      report,
    });
    assert.equal(ok.ok, true);
    assert.deepEqual(
      ok.conversations.map((c) => c.result),
      ['match', 'match'],
    );
    // Another key cannot reproduce the digests.
    assert.equal(
      (
        await verifyHistoryImport({
          dataRoot: root,
          owner: ALICE,
          workspaceId: ws,
          digestKey: Buffer.alloc(32, 8),
          report,
        })
      ).ok,
      false,
    );
    // Tamper with the stored conversation: verification reports a mismatch for it only.
    const path = join(workspacePaths(root, ALICE.userId, ws).dir, 'workspace.sqlite');
    const store = new Store(path);
    const target = store.list<Session>('session').find((s) => s.title === batch.conversations[1].title)!;
    target.messages[1].text = 'changed';
    store.put('session', target.id, target);
    store.close();
    const drift = await verifyHistoryImport({
      dataRoot: root,
      owner: ALICE,
      workspaceId: ws,
      digestKey: KEY,
      report,
    });
    assert.equal(drift.ok, false);
    assert.deepEqual(
      drift.conversations.map((c) => c.result),
      ['match', 'mismatch'],
    );
    // The verifier is owner-bound too.
    await assert.rejects(
      verifyHistoryImport({ dataRoot: root, owner: BOB, workspaceId: ws, digestKey: KEY, report }),
      (e) => e instanceof WorkspaceError && e.code === 'WORKSPACE_NOT_FOUND',
    );
  });
});

test('no plaintext copy is left outside the owner’s workspace folder', async () => {
  await withRoot(async (root, workspace) => {
    const ws = await workspace();
    await run(root, ws, spikeBatch());
    const dir = workspacePaths(root, ALICE.userId, ws).dir;
    const files: string[] = [];
    const walk = async (d: string): Promise<void> => {
      for (const e of await readdir(d, { withFileTypes: true }))
        e.isDirectory() ? await walk(join(d, e.name)) : files.push(join(d, e.name));
    };
    await walk(root);
    for (const file of files) {
      const inside = !relative(dir, file).startsWith('..');
      const content = await readFile(file);
      if (!inside) assert.ok(!content.includes(MARKER), relative(root, file));
      else assert.equal((await stat(file)).mode & 0o077, 0, relative(root, file));
    }
    assert.ok(files.some((f) => f.endsWith('workspace.sqlite')));
  });
});

test('the Workspace runtime lists and serves the imported history', async () => {
  const root = await mkdtemp(join(tmpdir(), 'step-history-runtime-'));
  const managerFor = () =>
    new RuntimeManager({
      workspacesPerUser: 2,
      dataRoot: root,
      driver: processDriver(),
      grant: () => ({ baseUrl: 'http://127.0.0.1:9/v1', model: 'synthetic' }),
    });
  try {
    provisionTestQuota(root, 2);
    const batch = spikeBatch();
    let manager = managerFor();
    const ws = await manager.create(ALICE.userId, { name: 'Imported' });
    await manager.shutdown();
    const report = await run(root, ws.id, batch);
    assert.deepEqual(dispositions(report), ['imported', 'imported', 'refused_owner']);
    manager = managerFor();
    try {
      const listed = await manager.conversations(ALICE.userId, ws.id);
      assert.equal(listed.length, 2);
      const one = listed.find((c) => c.title === batch.conversations[0].title)!;
      assert.equal(one.updatedAt, batch.conversations[0].updatedAt);
      await manager.start(ALICE.userId, ws.id);
      const messages = await manager.messages(ALICE.userId, ws.id, one.id);
      // The runtime's public view leaves out status entries (runtime-main.ts); they stay in the store.
      assert.deepEqual(
        messages,
        batch.conversations[0].messages
          .filter((m: any) => m.role !== 'status')
          .map((m: any) => ({ role: m.role, text: m.text, at: m.at })),
      );
      assert.equal((await manager.conversations(ALICE.userId, ws.id)).length, 2);
    } finally {
      await manager.shutdown();
    }
    assert.equal(
      (
        await verifyHistoryImport({
          dataRoot: root,
          owner: ALICE,
          workspaceId: ws.id,
          digestKey: KEY,
          report,
        })
      ).ok,
      true,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
