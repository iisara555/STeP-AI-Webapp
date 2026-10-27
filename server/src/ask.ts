// Homelab trial for one employee: npm run engine:ask -- --user <id> "คำถาม"
// STEP_AI_KEY is read from the environment only. STEP_AI_BASE_URL defaults to OpenRouter; STEP_AI_MODEL is required.
// This trial does not yet enforce provider data policies (that is the router proxy's job, ADR 0001 item 9):
// ask only non-confidential questions until then.
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { CompatibleAdapter } from '../../harness/desktop/electron/providers.ts';
import { serverPolicy, createEngine } from './engine.ts';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    user: { type: 'string', default: 'owner' },
    team: { type: 'string', default: 'cc' },
    'public-web': { type: 'boolean', default: false },
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
let streamed = false;
const engine = await createEngine({
  dataDir,
  policy: serverPolicy({ publicWeb: values['public-web'] }),
  ...(values['public-web'] ? { publicWeb: {} } : {}),
  runtime: async () => ({ adapter: new CompatibleAdapter(), context: { cwd: dataDir, env: {}, key } }),
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
  await engine.work.run(session.id, question, '', true, undefined, 'chat');
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
