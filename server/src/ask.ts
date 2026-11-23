// Homelab trial for one employee: npm run engine:ask -- --user <id> "คำถาม"
// --workspace-tools runs it like a Cloud Workspace runtime (read-only tool loop); --web-search <loopback URL> adds the
// organization's search front the same way runtime-main.ts does (docs/web-search.md), for before/after checks.
// STEP_AI_KEY is read from the environment only. STEP_AI_BASE_URL defaults to OpenRouter; STEP_AI_MODEL is required.
// This trial does not yet enforce provider data policies (that is the router proxy's job, ADR 0001 item 9):
// ask only non-confidential questions until then.
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { mkdir } from 'node:fs/promises';
import { CompatibleAdapter } from '../../harness/desktop/electron/providers.ts';
import { needsPublicWebSearch } from '../../harness/src/modules/router/public-information.js';
import { serverPolicy, createEngine } from './engine.ts';
import { localSearchUrl, runWebFirst, searchingAdapter } from './web-search/evidence.ts';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    user: { type: 'string', default: 'owner' },
    team: { type: 'string', default: 'cc' },
    'public-web': { type: 'boolean', default: false },
    'workspace-tools': { type: 'boolean', default: false },
    'web-search': { type: 'string' },
  },
});
const question = positionals.join(' ').trim();
const key = process.env.STEP_AI_KEY;
const model = process.env.STEP_AI_MODEL;
if (!question || !key || !model || !/^[a-z0-9._-]{1,64}$/i.test(values.user!)) {
  console.error('ใช้: STEP_AI_KEY=… STEP_AI_MODEL=… npm run engine:ask -- --user <id> "คำถาม"');
  process.exit(2);
}
const dataDir = join(resolve(process.env.STEP_AI_DATA || '.data'), 'users', values.user!);
const filesDir = join(dataDir, 'files');
const webSearch = localSearchUrl(values['web-search']);
if (values['web-search'] && !webSearch) {
  console.error('--web-search ต้องเป็น http://127.0.0.1:<port>');
  process.exit(2);
}
if (values['workspace-tools']) await mkdir(filesDir, { recursive: true, mode: 0o700 });
let streamed = false;
const engine = await createEngine({
  dataDir,
  policy: serverPolicy({ publicWeb: values['public-web'], workspaceTools: values['workspace-tools'] }),
  ...(values['public-web'] ? { publicWeb: {} } : {}),
  ...(values['workspace-tools'] ? { workspaceTools: { filesDir } } : {}),
  runtime: async () => ({
    adapter: webSearch
      ? searchingAdapter(new CompatibleAdapter(), { url: webSearch })
      : new CompatibleAdapter(),
    context: { cwd: dataDir, env: {}, key },
  }),
  emit: (event) => {
    if (values['public-web'] || event.type !== 'delta' || !event.text) return;
    streamed = true;
    process.stdout.write(event.text);
  },
});
try {
  engine.store.put('connection', 'central', {
    id: 'central',
    provider: 'compatible',
    mode: 'api',
    protocol: 'openai',
    baseUrl: process.env.STEP_AI_BASE_URL || 'https://openrouter.ai/api/v1',
    model,
    ready: true,
  });
  const session = engine.store.create('central', values.team!);
  const run = () => engine.work.run(session.id, question, '', true, undefined, 'chat');
  await (webSearch && needsPublicWebSearch(question) ? runWebFirst(run) : run());
  const done = engine.store.session(session.id);
  const answer = done.messages.filter((m) => m.role === 'assistant').at(-1);
  process.stdout.write('\n\n');
  if (done.status !== 'review') console.error('ไม่สำเร็จ:', done.runs?.at(-1)?.code || done.status);
  else if (!answer?.text) console.error('ไม่มีคำตอบ');
  else if (!streamed) console.log(answer.text);
  if (done.loadedContext?.length) console.log('\nเอกสารที่ใช้:\n- ' + done.loadedContext.join('\n- '));
  process.exitCode = done.status === 'review' ? 0 : 1;
} finally {
  engine.close();
}
