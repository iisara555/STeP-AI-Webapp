// Organization AI gateway entry: npm run ai-gateway (listens on loopback; Tailscale serve/Funnel or a reverse proxy
// sits in front). Settings come from the environment and the settings file only. The OpenRouter key is read from
// OPENROUTER_API_KEY_FILE (preferred, mode 0600) or OPENROUTER_API_KEY and is never written anywhere.
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { googleIdTokenAuth } from '../gateway/auth.ts';
import { configFile } from './config.ts';
import { internalTokens } from './internal-token.ts';
import { UsageLedger } from './ledger.ts';
import { createAiProxy } from './proxy.ts';

const env = (name: string) => {
  const value = process.env[name];
  if (!value) {
    console.error(`ต้องตั้ง ${name}`);
    process.exit(2);
  }
  return value;
};
const list = (value: string) =>
  new Set(
    value
      .split(/[\s,]+/)
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean),
  );

async function openRouterKey() {
  const file = process.env.OPENROUTER_API_KEY_FILE;
  if (file) {
    const info = await stat(file);
    if (info.mode & 0o077) {
      console.error('ไฟล์ key ต้องอ่านได้เฉพาะเจ้าของ (chmod 600)');
      process.exit(2);
    }
    return (await readFile(file, 'utf8')).trim();
  }
  return env('OPENROUTER_API_KEY').trim();
}

const key = await openRouterKey();
delete process.env.OPENROUTER_API_KEY;
if (!/^sk-or-[\w-]{10,200}$/.test(key)) {
  console.error('OpenRouter key ไม่ถูกรูปแบบ');
  process.exit(2);
}
const dataRoot = resolve(env('STEP_DATA_ROOT'));
const invitesFile = resolve(env('STEP_INVITES_FILE'));
const config = configFile(resolve(env('STEP_AI_GATEWAY_CONFIG')));
try {
  await config();
} catch {
  console.error('ไฟล์ตั้งค่า STEP_AI_GATEWAY_CONFIG ไม่ถูกต้อง');
  process.exit(2);
}
// One email per line; read on every request so removing a line revokes access without a restart.
const invited = async () => list(await readFile(invitesFile, 'utf8').catch(() => ''));
const secret = process.env.STEP_AI_INTERNAL_SECRET;

const server = createAiProxy({
  key,
  config,
  invited,
  ledger: new UsageLedger(dataRoot),
  ...(secret ? { internal: internalTokens(secret) } : {}),
  authenticate: googleIdTokenAuth({
    // The web app's client and STeP Desktop's installed-app client, comma separated.
    clientId: [...list(env('STEP_GOOGLE_CLIENT_IDS'))],
    domains: [...list(env('STEP_ALLOWED_DOMAINS'))],
    invited,
    admins: list(process.env.STEP_ADMINS ?? ''),
  }),
});
const host = process.env.STEP_AI_GATEWAY_HOST ?? '127.0.0.1';
const port = Number(process.env.STEP_AI_GATEWAY_PORT ?? 8788);
server.requestTimeout = 0; // long answers stream for minutes; each upstream call has its own 15-minute limit
server.listen(port, host, () => console.log(`STeP AI gateway: http://${host}:${port}/v1`));
const shutdown = () => server.close(() => process.exit(0));
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
