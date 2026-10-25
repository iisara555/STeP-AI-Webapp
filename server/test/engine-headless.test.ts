import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEngine, HARNESS_ROOT, serverPolicy, type Runtime } from '../src/engine.ts';

// Synthetic adapter: records what the engine would send to an AI provider and never calls one.
function capturing() {
  const prompts: string[] = [];
  const runtime: Runtime = async () => ({
    adapter: {
      run: async (prompt: string, _connection: unknown, context: any) => {
        prompts.push(prompt);
        // A provider with its own web search reports the search as complete; nothing leaves this process.
        if (context.webSearch) context.onWebActivity?.('complete');
        return 'คำตอบทดสอบ';
      },
    } as any,
    context: { cwd: tmpdir(), env: {} },
  });
  return { prompts, runtime };
}

const firstDocument = (prompt: string) =>
  /<organization_knowledge>[\s\S]*?\[([a-z0-9-]+)\]/.exec(prompt)?.[1] ?? null;

async function withEngine(
  fn: (engine: Awaited<ReturnType<typeof createEngine>>, prompts: string[]) => Promise<void>,
) {
  const dir = await mkdtemp(join(tmpdir(), 'step-engine-'));
  const { prompts, runtime } = capturing();
  const engine = await createEngine({
    dataDir: join(dir, 'users', 'a'),
    runtime,
    publicSearch: async () => '',
  });
  engine.store.put('connection', 'central', {
    id: 'central',
    provider: 'openai',
    mode: 'subscription',
    ready: true,
  });
  try {
    await fn(engine, prompts);
  } finally {
    engine.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test('the staff-question corpus reaches the right document through the whole engine, not only search', async () => {
  const { questions } = JSON.parse(
    await readFile(join(HARNESS_ROOT, 'desktop/eval/knowledge-questions.json'), 'utf8'),
  ) as { questions: { q: string; doc: string | string[] }[] };
  assert.equal(questions.length, 61);
  await withEngine(async (engine, prompts) => {
    const misses: string[] = [];
    for (const { q, doc } of questions) {
      const session = engine.store.create('central', 'cc');
      prompts.length = 0;
      await engine.work.run(session.id, q, '', true, undefined, 'chat');
      const status = engine.store.session(session.id).status;
      const found = prompts.length ? firstDocument(prompts.at(-1)!) : null;
      const ok = doc === 'none' ? found === null : [doc].flat().includes(found ?? '');
      if (!ok)
        misses.push(`${q} => ${found ?? 'nothing'} [${status}] (expected ${[doc].flat().join(' or ')})`);
    }
    assert.equal(
      misses.length,
      0,
      `${questions.length - misses.length}/${questions.length}:\n${misses.join('\n')}`,
    );
  });
});

test('each employee has an own SQLite file and sees only their own tasks', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'step-engine-'));
  const { runtime } = capturing();
  const offline = async () => '';
  const a = await createEngine({ dataDir: join(dir, 'users', 'a'), runtime, publicSearch: offline });
  const b = await createEngine({ dataDir: join(dir, 'users', 'b'), runtime, publicSearch: offline });
  try {
    const task = a.store.create('central', 'cc');
    assert.ok(a.store.get('session', task.id));
    assert.equal(b.store.get('session', task.id), undefined);
    assert.equal(b.store.list('session').length, 0);
    for (const user of ['a', 'b']) {
      const info = await stat(join(dir, 'users', user, 'workspace.sqlite'));
      assert.ok(info.isFile());
      assert.equal(
        (await stat(join(dir, 'users', user))).mode & 0o077,
        0,
        'folder is private to the service user',
      );
    }
  } finally {
    a.close();
    b.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('the server profile turns off tools that do not belong on a shared machine', async () => {
  const { features, checks } = serverPolicy();
  for (const off of ['toolLoop', 'shellByAi', 'sandbox', 'mcp', 'copilot', 'vault', 'autopilot'] as const)
    assert.equal(features[off], false, off);
  assert.equal(checks.privacy, true);
  const { CopilotClient } = await import('@github/copilot-sdk');
  assert.throws(() => new CopilotClient(), /COPILOT_DISABLED_ON_SERVER/);
});
