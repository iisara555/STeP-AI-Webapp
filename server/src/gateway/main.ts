// Gateway entry: npm run gateway (behind the HTTPS reverse proxy; listens on loopback by default).
// Settings come from the environment only; the provider key never reaches a browser, a prompt or a Workspace file.
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { RuntimeManager } from '../workspace/manager.ts';
import { processDriver } from '../workspace/process-driver.ts';
import { fileAudit } from './audit.ts';
import { googleIdTokenAuth } from './auth.ts';
import { createGateway } from './http.ts';
import { DEFAULT_QUOTAS, RunService } from './runs.ts';

const env = (name: string, fallback?: string) => {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === '') {
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
const number = (name: string, fallback: number) => {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 1) {
    console.error(`${name} ต้องเป็นจำนวนเต็มบวก`);
    process.exit(2);
  }
  return value;
};

const dataRoot = resolve(env('STEP_DATA_ROOT'));
const invitesFile = resolve(env('STEP_INVITES_FILE'));
const aiKey = process.env.STEP_AI_KEY;

const manager = new RuntimeManager({
  dataRoot,
  driver: processDriver(),
  maxRunning: number('STEP_MAX_RUNNING', 8),
  idleMs: number('STEP_IDLE_MINUTES', 30) * 60_000,
  grant: () => ({
    baseUrl: env('STEP_AI_BASE_URL'),
    model: env('STEP_AI_MODEL'),
    ...(aiKey ? { token: aiKey } : {}),
  }),
});
const audit = fileAudit(dataRoot);
const quotas = {
  workspacesPerUser: number('STEP_QUOTA_WORKSPACES', DEFAULT_QUOTAS.workspacesPerUser),
  activeRunsPerUser: number('STEP_QUOTA_ACTIVE_RUNS', DEFAULT_QUOTAS.activeRunsPerUser),
  runsPerUserPerDay: number('STEP_QUOTA_DAILY_RUNS', DEFAULT_QUOTAS.runsPerUserPerDay),
};
const server = createGateway({
  manager,
  runs: new RunService(manager, audit, quotas),
  audit,
  quotas,
  origin: env('STEP_APP_ORIGIN'),
  authenticate: googleIdTokenAuth({
    clientId: env('STEP_GOOGLE_CLIENT_ID'),
    domains: [...list(env('STEP_ALLOWED_DOMAINS'))],
    // One email per line; read on every request so removing a line revokes access without a restart.
    invited: async () => list(await readFile(invitesFile, 'utf8').catch(() => '')),
    admins: list(process.env.STEP_ADMINS ?? ''),
  }),
});

const sweep = setInterval(() => void manager.sweepIdle().catch(() => {}), 60_000);
const host = process.env.STEP_GATEWAY_HOST ?? '127.0.0.1';
const port = number('STEP_GATEWAY_PORT', 8787);
server.listen(port, host, () => console.log(`STeP Gateway: http://${host}:${port}`));

const shutdown = () => {
  clearInterval(sweep);
  server.close();
  void manager.shutdown().finally(() => process.exit(0));
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
