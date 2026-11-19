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

// The key may arrive after installation: it is read again (from the 0600 file) whenever the file changes, and until a
// valid key is there every AI request gets 503 ai_not_ready instead of the gateway refusing to start.
const KEY_PATTERN = /^sk-or-[\w-]{10,200}$/;
const fixedKey = process.env.OPENROUTER_API_KEY?.trim();
delete process.env.OPENROUTER_API_KEY;
const keyFile = process.env.OPENROUTER_API_KEY_FILE;
if (!keyFile && !fixedKey) {
  console.error('ต้องตั้ง OPENROUTER_API_KEY_FILE (หรือ OPENROUTER_API_KEY)');
  process.exit(2);
}
let cachedKey: { at: string; key?: string } | undefined;
async function openRouterKey(): Promise<string | undefined> {
  if (!keyFile) return fixedKey && KEY_PATTERN.test(fixedKey) ? fixedKey : undefined;
  let info;
  try {
    info = await stat(keyFile);
  } catch {
    return undefined;
  }
  const at = `${info.mtimeMs}:${info.size}:${info.mode}`;
  if (cachedKey?.at === at) return cachedKey.key;
  let key: string | undefined;
  if (info.mode & 0o077) console.error('ไฟล์ key ต้องอ่านได้เฉพาะเจ้าของ (chmod 600) จึงยังไม่ใช้');
  else {
    const text = (await readFile(keyFile, 'utf8').catch(() => '')).trim();
    if (KEY_PATTERN.test(text)) key = text;
    else if (text) console.error('OpenRouter key ในไฟล์ไม่ถูกรูปแบบ จึงยังไม่ใช้');
  }
  cachedKey = { at, key };
  return key;
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
  key: openRouterKey,
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
server.listen(port, host, async () =>
  console.log(
    `STeP AI gateway: http://${host}:${port}/v1${(await openRouterKey()) ? '' : ' (ยังไม่มี OpenRouter key: รอไฟล์ key)'}`,
  ),
);
const shutdown = () => server.close(() => process.exit(0));
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
