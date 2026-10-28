import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HARNESS_ROOT } from '../src/engine.ts';
import { WorkspaceError } from '../src/workspace/contract.ts';
import { RuntimeManager } from '../src/workspace/manager.ts';
import { processDriver } from '../src/workspace/process-driver.ts';
import { workspacePaths } from '../src/workspace/storage.ts';

const TOKEN = 'synthetic-token-for-tests';

/**
 * A loopback OpenAI-compatible endpoint: records what each Workspace runtime sends and streams a fixed answer.
 * Nothing leaves the machine. `hold` keeps a request open until released, to stand for a long job.
 */
async function syntheticProvider() {
  const requests: { authorization?: string; prompt: string }[] = [];
  let hold: Promise<void> | undefined;
  const server = createServer(async (req: IncomingMessage, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const messages = JSON.parse(body).messages as { role: string; content: string }[];
    requests.push({
      authorization: req.headers.authorization,
      prompt: messages.find((m) => m.role === 'user')?.content ?? '',
    });
    await hold;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'คำตอบทดสอบ' } }] })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as AddressInfo;
  return {
    requests,
    baseUrl: `http://127.0.0.1:${port}/v1`,
    hold(until: Promise<void>) {
      hold = until;
    },
    close: () => new Promise((done) => server.close(done)),
  };
}

async function withWorkspaces(
  fn: (
    manager: RuntimeManager,
    provider: Awaited<ReturnType<typeof syntheticProvider>>,
    dataRoot: string,
    clock: { now: number },
  ) => Promise<void>,
) {
  const dataRoot = await mkdtemp(join(tmpdir(), 'step-workspaces-'));
  const provider = await syntheticProvider();
  const clock = { now: Date.now() };
  const manager = new RuntimeManager({
    dataRoot,
    driver: processDriver(),
    now: () => clock.now,
    grant: () => ({ baseUrl: provider.baseUrl, model: 'synthetic', token: TOKEN }),
  });
  try {
    await fn(manager, provider, dataRoot, clock);
  } finally {
    await manager.shutdown();
    await provider.close();
    await rm(dataRoot, { recursive: true, force: true });
  }
}

const firstDocument = (prompt: string) =>
  /<organization_knowledge>[\s\S]*?\[([a-z0-9-]+)\]/.exec(prompt)?.[1] ?? null;

/**
 * Questions the engine answers with the provider's own live web search. An OpenAI-compatible endpoint has none, so
 * through a Workspace runtime they stop with PROVIDER_CAPABILITY_UNSUPPORTED until the router proxy (ADR 0001 §7)
 * or the engine offers search for compatible providers. When that lands this list must shrink, and the test says so.
 */
const NEEDS_PROVIDER_WEB_SEARCH = ['วันหยุดราชการปีนี้'];

test('the staff-question corpus reaches the right document through a Workspace runtime process', async () => {
  const { questions } = JSON.parse(
    await readFile(join(HARNESS_ROOT, 'desktop/eval/knowledge-questions.json'), 'utf8'),
  ) as { questions: { q: string; doc: string | string[] }[] };
  assert.equal(questions.length, 61);
  await withWorkspaces(async (manager, provider) => {
    const w = await manager.create('alice', { name: 'คำถามพนักงาน' });
    const misses: string[] = [];
    for (const { q, doc } of questions) {
      provider.requests.length = 0;
      const result = await manager.ask('alice', w.id, { text: q });
      if (NEEDS_PROVIDER_WEB_SEARCH.includes(q)) {
        assert.equal(
          result.code,
          'PROVIDER_CAPABILITY_UNSUPPORTED',
          `${q} no longer needs provider web search`,
        );
        continue;
      }
      const found = provider.requests.length ? firstDocument(provider.requests.at(-1)!.prompt) : null;
      const ok = doc === 'none' ? found === null : [doc].flat().includes(found ?? '');
      if (!ok)
        misses.push(
          `${q} => ${found ?? 'nothing'} [${result.status} ${result.code ?? ''}] (expected ${[doc].flat().join(' or ')})`,
        );
    }
    const answerable = questions.length - NEEDS_PROVIDER_WEB_SEARCH.length;
    assert.equal(misses.length, 0, `${answerable - misses.length}/${answerable}:\n${misses.join('\n')}`);
  });
});

test('a conversation survives a stop and continues after resume; the token never reaches disk', async () => {
  await withWorkspaces(async (manager, provider, dataRoot) => {
    const w = await manager.create('alice', { name: 'A' });
    const first = await manager.ask('alice', w.id, { text: 'ช่วยคิดชื่องานสัมมนาให้หน่อย' });
    assert.equal(first.status, 'review', String(first.code));
    assert.equal(first.answer, 'คำตอบทดสอบ');
    assert.equal(provider.requests.at(-1)!.authorization, `Bearer ${TOKEN}`);

    await manager.stop('alice', w.id);
    assert.equal((await manager.get('alice', w.id)).state, 'stopped');
    // Asking a stopped Workspace resumes it from its folder.
    const second = await manager.ask('alice', w.id, { text: 'ขออีกสามชื่อ', sessionId: first.sessionId });
    assert.equal(second.status, 'review', String(second.code));
    assert.equal(second.sessionId, first.sessionId);
    assert.deepEqual(
      (await manager.conversations('alice', w.id)).map((c) => c.id),
      [first.sessionId],
    );

    await manager.stop('alice', w.id);
    const db = await readFile(join(workspacePaths(dataRoot, 'alice', w.id).dir, 'workspace.sqlite'));
    assert.equal(db.includes(TOKEN), false, 'token written to workspace.sqlite');
  });
});

test('one user’s conversation cannot be continued from another user’s Workspace', async () => {
  await withWorkspaces(async (manager) => {
    const a = await manager.create('alice', { name: 'A' });
    const b = await manager.create('bob', { name: 'B' });
    const { sessionId } = await manager.ask('alice', a.id, { text: 'ช่วยคิดชื่องานสัมมนาให้หน่อย' });
    await assert.rejects(
      () => manager.ask('bob', b.id, { text: 'ต่อจากเมื่อกี้', sessionId }),
      /CONVERSATION_NOT_FOUND/,
    );
    await assert.rejects(
      () => manager.ask('bob', a.id, { text: 'ต่อจากเมื่อกี้', sessionId }),
      (error) => error instanceof WorkspaceError && error.code === 'WORKSPACE_NOT_FOUND',
    );
    assert.deepEqual(await manager.conversations('bob', b.id), []);
  });
});

test('a runtime with work in flight is not stopped as idle', async () => {
  await withWorkspaces(async (manager, provider, _dataRoot, clock) => {
    const w = await manager.create('alice', { name: 'A' });
    let release!: () => void;
    provider.hold(new Promise<void>((done) => (release = done)));
    const job = manager.ask('alice', w.id, { text: 'ช่วยคิดชื่องานสัมมนาให้หน่อย' });
    while (!provider.requests.length) await new Promise((done) => setTimeout(done, 20));

    clock.now += 2 * 60 * 60_000;
    assert.deepEqual(await manager.sweepIdle(), []);
    release();
    assert.equal((await job).status, 'review');

    clock.now += 2 * 60 * 60_000;
    assert.deepEqual(await manager.sweepIdle(), [w.id]);
  });
});
