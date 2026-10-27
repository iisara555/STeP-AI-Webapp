// Runs the 61 staff questions through the whole engine against a real provider: npm run engine:bench -- [--limit n]
// Same environment as ask.ts (STEP_AI_KEY, STEP_AI_MODEL, STEP_AI_BASE_URL). Checks that can be automated are
// scored here; the answers are written to the report for a person to judge against the sources.
// The corpus has no reference answers, so "cites" only means the answer names the expected document.
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { CompatibleAdapter } from '../../harness/desktop/electron/providers.ts';
import { serverPolicy, createEngine, HARNESS_ROOT } from './engine.ts';

const { values } = parseArgs({
  options: {
    limit: { type: 'string' },
    question: { type: 'string' },
    team: { type: 'string', default: 'cc' },
    'public-web': { type: 'boolean', default: false },
  },
});
const key = process.env.STEP_AI_KEY;
const model = process.env.STEP_AI_MODEL;
if (!key || !model) {
  console.error('ใช้: STEP_AI_KEY=… STEP_AI_MODEL=… npm run engine:bench -- [--limit n]');
  process.exit(2);
}
const baseUrl = process.env.STEP_AI_BASE_URL || 'https://openrouter.ai/api/v1';
const { questions: all } = JSON.parse(
  await readFile(join(HARNESS_ROOT, 'desktop/eval/knowledge-questions.json'), 'utf8'),
) as { questions: { q: string; doc: string | string[] }[] };
if (values.limit && (!/^[1-9]\d*$/.test(values.limit) || Number(values.limit) > all.length)) {
  console.error(`--limit ต้องเป็นจำนวนเต็มระหว่าง 1 และ ${all.length}`);
  process.exit(2);
}
const filtered = values.question ? all.filter(({ q }) => q === values.question) : all;
if (!filtered.length) {
  console.error('ไม่พบคำถามที่ตรงกับ --question ในชุด benchmark');
  process.exit(2);
}
const questions = values.limit ? filtered.slice(0, Number(values.limit)) : filtered;

const firstDocument = (prompt: string) =>
  /<organization_knowledge>[\s\S]*?\[([a-z0-9-]+)\]/.exec(prompt)?.[1] ?? null;
const cited = (text: string) => [
  // Document ids appear as [id] or `id`.
  ...new Set([...text.matchAll(/[[`]([a-z0-9]+(?:-[a-z0-9]+)+)[\]`]/g)].map((m) => m[1])),
];

// Each bench gets a fresh employee folder so earlier tasks and memories cannot shape the answers.
const dataRoot = resolve(process.env.STEP_AI_DATA || '.data');
await mkdir(dataRoot, { recursive: true, mode: 0o700 });
const scratch = await mkdtemp(join(dataRoot, 'bench-'));
let prompt = '';
const real = new CompatibleAdapter();
const engine = await createEngine({
  dataDir: join(scratch, 'users', 'bench'),
  policy: serverPolicy({ publicWeb: values['public-web'] }),
  ...(values['public-web'] ? { publicWeb: {} } : {}),
  runtime: async () => ({
    adapter: {
      run: (text: string, connection: any, context: any) => {
        prompt = text;
        return real.run(text, connection, context);
      },
    } as any,
    context: { cwd: scratch, env: {}, key },
  }),
});
type Result = {
  q: string;
  expected: string[];
  found: string | null;
  routed: boolean;
  answered: boolean;
  code?: string;
  cites: boolean;
  sources: string[];
  ms: number;
  ttftMs?: number;
  usage: { input: number; output: number };
  answer: string;
  webSearchSucceeded: boolean;
  webReadSucceeded: boolean;
  webToolFailures: { tool: string; code: string }[];
  webSources: { title: string; url: string }[];
  webCited: boolean;
};
const results: Result[] = [];
try {
  engine.store.put('connection', 'central', {
    id: 'central',
    provider: 'compatible',
    mode: 'api',
    protocol: 'openai',
    baseUrl,
    model,
    ready: true,
  });
  for (const [i, { q, doc }] of questions.entries()) {
    const expected = [doc].flat();
    const session = engine.store.create('central', values.team!);
    prompt = '';
    const started = Date.now();
    await engine.work.run(session.id, q, '', true, undefined, 'chat');
    const done = engine.store.session(session.id);
    const run = done.runs?.at(-1);
    const calls = [
      ...(run?.providerCalls || []),
      ...(run?.steps || []).flatMap((s) => s.providerCalls || []),
    ];
    const answerCall = calls.find((c) => c.kind === 'answer');
    const usage = (run?.steps || []).reduce(
      (sum, s) => ({ input: sum.input + (s.usage?.input || 0), output: sum.output + (s.usage?.output || 0) }),
      { input: 0, output: 0 },
    );
    const message =
      done.status === 'review' ? done.messages.filter((m) => m.role === 'assistant').at(-1) : undefined;
    const answer = message?.text || '';
    const tools = (run?.steps || []).flatMap((step) => step.tools || []);
    const webSources = message?.webSources || [];
    const found = prompt ? firstDocument(prompt) : null;
    const none = doc === 'none';
    const routed = none ? found === null : expected.includes(found ?? '');
    const sources = cited(answer);
    // Models often name the document by its title instead of its id; the first loaded title is the expected
    // document only when routing was right.
    const title = done.loadedContext?.[0]?.split(' · ')[0];
    results.push({
      q,
      expected,
      found,
      routed,
      answered: Boolean(answer.trim()),
      code: done.status === 'review' ? undefined : run?.code || done.status,
      // Questions without a document pass when the answer cites nothing; it still needs a person to read it.
      cites: none
        ? sources.length === 0
        : expected.some((d) => sources.includes(d)) || Boolean(routed && title && answer.includes(title)),
      sources,
      ms: Date.now() - started,
      ttftMs: answerCall?.ttftMs,
      usage,
      answer,
      webSearchSucceeded: tools.some((t) => t.tool === 'web_search' && t.ok),
      webReadSucceeded: tools.some((t) => t.tool === 'web_fetch' && t.ok),
      webToolFailures: tools
        .filter((t) => ['web_search', 'web_fetch'].includes(t.tool) && !t.ok)
        .map((t) => ({ tool: t.tool, code: t.code || 'TOOL_FAILED' })),
      webSources,
      webCited: webSources.some(({ url }) => answer.includes(url)),
    });
    const r = results.at(-1)!;
    console.log(
      `${String(i + 1).padStart(2)}/${questions.length} ${r.routed ? '✓' : '✗'}เอกสาร ${r.answered ? '✓' : '✗'}ตอบ ` +
        `${r.cites ? '✓' : '✗'}อ้าง ${(r.ms / 1000).toFixed(1)}s ${r.code ?? ''} ${q}`,
    );
  }
} finally {
  engine.close();
  await rm(scratch, { recursive: true, force: true });
}

const count = (f: (r: Result) => boolean) => results.filter(f).length;
const percentile = (values: number[], p: number) => {
  const sorted = values.toSorted((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;
};
const times = results.map((r) => r.ms);
const firstText = results.flatMap((r) => (r.ttftMs === undefined ? [] : [r.ttftMs]));
const output = results.reduce((n, r) => n + r.usage.output, 0);
// Reasoning tokens count as output but arrive before the first visible text, so the rate covers the whole run.
const totalSeconds = times.reduce((n, ms) => n + ms / 1000, 0);
const summary = {
  model,
  baseUrl,
  publicWeb: values['public-web'],
  at: new Date().toISOString(),
  questions: results.length,
  routed: count((r) => r.routed),
  answered: count((r) => r.answered),
  cites: count((r) => r.cites),
  webSearchSucceeded: count((r) => r.webSearchSucceeded),
  webReadSucceeded: count((r) => r.webReadSucceeded),
  webCited: count((r) => r.webCited),
  failures: Object.fromEntries(
    [...new Set(results.map((r) => r.code).filter(Boolean))].map((c) => [c, count((r) => r.code === c)]),
  ),
  p50Seconds: percentile(times, 50) / 1000,
  p95Seconds: percentile(times, 95) / 1000,
  firstTextP50Seconds: firstText.length ? percentile(firstText, 50) / 1000 : undefined,
  outputTokens: output,
  outputTokensPerSecond: totalSeconds ? Math.round(output / totalSeconds) : undefined,
};
const dir = join(resolve(process.env.STEP_AI_DATA || '.data'), 'bench');
await mkdir(dir, { recursive: true, mode: 0o700 });
const file = join(dir, `${model.replace(/[^a-z0-9._-]/gi, '_')}-${summary.at.replace(/[:.]/g, '-')}.json`);
await writeFile(file, JSON.stringify({ summary, results }, null, 2), { mode: 0o600 });
console.log('\n' + JSON.stringify(summary, null, 2));
console.log(`\nรายงานเต็ม: ${file}`);
process.exitCode = results.length && summary.answered === results.length ? 0 : 1;
