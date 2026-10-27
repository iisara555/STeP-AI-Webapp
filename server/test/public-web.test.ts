import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEngine, serverPolicy, type Runtime } from '../src/engine.ts';
import { publicWebHost } from '../src/public-web.ts';

const QUESTION = 'วันหยุดราชการปีนี้';
const SOURCE = 'https://example.org/holidays';
const RESULTS = `ผลค้นเว็บสาธารณะ: [ประกาศวันหยุด](${SOURCE})\nข้อมูลย่อ`;
const tool = (name: string, input: string) =>
  '```step-tool\n' + JSON.stringify({ tool: name, input }) + '\n```';

// Only synthetic responses and the injected fetcher are used: nothing leaves the process.
test('opted-in engine searches the exact question, reads a returned source, and returns its answer', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'step-public-web-'));
  const searches: string[] = [];
  const pages: string[] = [];
  const prompts: string[] = [];
  const runtime: Runtime = async () => ({
    adapter: {
      run: async (prompt: string, _connection: unknown, context: any) => {
        prompts.push(prompt);
        if (!context.system?.includes('Only these tools are available')) return 'คำตอบทั่วไป';
        if (!prompt.includes('<tool_results>')) return tool('web_search', QUESTION);
        if (!prompt.includes('เนื้อหาประกาศทดสอบ')) return tool('web_fetch', SOURCE);
        return `จาก [ประกาศ](${SOURCE}) เป็นข้อมูลทดสอบ`;
      },
    } as any,
    context: { cwd: dir, env: {} },
  });
  const engine = await createEngine({
    dataDir: dir,
    runtime,
    policy: serverPolicy({ publicWeb: true }),
    publicWeb: {
      fetchPage: async (url) => {
        pages.push(url);
        return { url, text: 'เนื้อหาประกาศทดสอบ' };
      },
    },
    publicSearch: async (query) => {
      searches.push(query);
      return RESULTS;
    },
  });
  engine.store.put('connection', 'central', {
    id: 'central',
    provider: 'compatible',
    mode: 'api',
    ready: true,
  });
  try {
    const session = engine.store.create('central', 'cc');
    await engine.work.run(session.id, QUESTION, '', true, undefined, 'chat');
    const done = engine.store.session(session.id);
    assert.equal(done.status, 'review', JSON.stringify(done.runs?.at(-1)));
    assert.deepEqual(searches, [QUESTION]);
    assert.deepEqual(pages, [SOURCE]);
    assert.match(
      done.messages.filter((m) => m.role === 'assistant').at(-1)?.text || '',
      /https:\/\/example.org\/holidays/,
    );
    assert.ok(prompts.some((prompt) => prompt.includes('เนื้อหาประกาศทดสอบ')));
    assert.ok(
      done.runs
        ?.at(-1)
        ?.steps?.flatMap((step) => step.tools || [])
        .some((t) => t.tool === 'web_fetch' && t.ok),
    );
  } finally {
    engine.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('web host prevents unrelated queries, unreturned destinations, private URLs and other tools', async () => {
  const calls: string[] = [];
  const controller = new AbortController();
  const host = publicWebHost(
    {
      query: QUESTION,
      request: QUESTION,
      sessionId: 'synthetic',
      team: 'cc',
      connection: {} as any,
      contract: { mode: 'GENERAL', authority: { status: 'ALLOW' } },
      signal: controller.signal,
      cancel() {},
      activity() {},
      async search(query) {
        calls.push(query);
        return RESULTS;
      },
    },
    {
      privacy: (text) => ({
        action: text.includes('secret') ? 'block-external' : 'pass',
        redactedText: text,
      }),
      fetchPage: async (url) => {
        calls.push(url);
        return { url, text: 'ทดสอบ' };
      },
    },
  );
  const execute = (toolName: any, input: string) =>
    host.execute({ tool: toolName, input }, controller.signal);
  await assert.rejects(() => execute('web_search', 'secret'), /INVALID_INPUT/);
  await assert.rejects(() => execute('web_fetch', SOURCE), /WEB_URL_NOT_IN_SEARCH_RESULTS/);
  await assert.rejects(() => execute('web_fetch', 'http://127.0.0.1/'), /WEB_ADDRESS_BLOCKED/);
  await assert.rejects(() => execute('files', '/etc/passwd'), /TOOL_DENIED/);
  await execute('web_search', QUESTION);
  await assert.rejects(
    () => execute('web_fetch', 'https://example.org/other'),
    /WEB_URL_NOT_IN_SEARCH_RESULTS/,
  );
  await execute('web_fetch', SOURCE);
  assert.deepEqual(calls, [QUESTION, SOURCE]);
  await assert.rejects(() => host.outgoing('secret', controller.signal), /PRIVACY_REVIEW_REQUIRED/);
  controller.abort();
  await assert.rejects(() => execute('web_fetch', SOURCE), /CANCELLED/);
});

test('web tool loop requires both the server policy and explicit opt-in', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'step-public-web-off-'));
  const runtime: Runtime = async () => ({
    adapter: { run: async () => 'answer' } as any,
    context: { cwd: dir, env: {} },
  });
  const cases = [
    { policy: serverPolicy(), publicWeb: {} },
    { policy: serverPolicy({ publicWeb: true }), publicWeb: undefined },
  ];
  try {
    for (const [i, options] of cases.entries()) {
      const engine = await createEngine({ dataDir: join(dir, String(i)), runtime, ...options });
      assert.equal(engine.harness.toolLoop?.(), false);
      assert.equal(engine.harness.tools, undefined);
      engine.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the host withholds sensitive search results before the engine can record or forward them', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'step-public-web-sensitive-'));
  const secret = 'synthetic-secret-value';
  const seen: string[] = [];
  let calls = 0;
  const runtime: Runtime = async () => ({
    adapter: {
      run: async (prompt: string, _connection: unknown, context: any) => {
        seen.push(prompt);
        if (!context.system?.includes('Only these tools are available')) return 'คำตอบทั่วไป';
        if (calls++ === 0) return tool('web_search', QUESTION);
        assert.match(prompt, /PRIVACY_REVIEW_REQUIRED/);
        return 'ไม่สามารถค้นข้อมูลได้';
      },
    } as any,
    context: { cwd: dir, env: {} },
  });
  const engine = await createEngine({
    dataDir: dir,
    runtime,
    policy: serverPolicy({ publicWeb: true }),
    publicWeb: {},
    publicSearch: async () => `API key: sk-1234567890abcdefghijklmnop ${secret}`,
  });
  engine.store.put('connection', 'central', {
    id: 'central',
    provider: 'compatible',
    mode: 'api',
    ready: true,
  });
  try {
    const session = engine.store.create('central', 'cc');
    await engine.work.run(session.id, QUESTION, '', true, undefined, 'chat');
    const done = engine.store.session(session.id);
    assert.equal(done.status, 'review');
    assert.ok(seen.every((prompt) => !prompt.includes(secret)));
    assert.deepEqual(done.messages.at(-1)?.webSources || [], []);
    assert.ok(
      done.runs
        ?.at(-1)
        ?.steps?.flatMap((step) => step.tools || [])
        .some(
          (entry) => entry.tool === 'web_search' && !entry.ok && entry.code === 'PRIVACY_REVIEW_REQUIRED',
        ),
    );
  } finally {
    engine.close();
    await rm(dir, { recursive: true, force: true });
  }
});
