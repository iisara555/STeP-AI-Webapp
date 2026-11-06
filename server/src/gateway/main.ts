// Gateway entry: npm run gateway (behind the HTTPS reverse proxy; listens on loopback by default).
// Settings come from the environment only; the provider key never reaches a browser, a prompt or a Workspace file.
import { mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { RuntimeManager } from '../workspace/manager.ts';
import { processDriver } from '../workspace/process-driver.ts';
import { fileAudit } from './audit.ts';
import { googleIdTokenAuth } from './auth.ts';
import { createGateway } from './http.ts';
import { InvitationStore } from './invitation-store.ts';
import { QuotaStore } from './quota-store.ts';
import { DEFAULT_QUOTAS, RunService } from './runs.ts';
import { gatewayShutdown } from './shutdown.ts';

// No configuration or environment flag can make processDriver a host isolation boundary.
// Remove this refusal only when #57's production isolation requirements are met and integrated.
function refuseUnsafeGateway(): void {
  console.error('Gateway startup refused: production workspace isolation is not implemented (#57).');
  process.exit(1);
}
refuseUnsafeGateway();

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
await mkdir(dataRoot, { recursive: true, mode: 0o700 });
const quotaStore = new QuotaStore(join(dataRoot, 'gateway-quotas.sqlite'));
const invitesFile = resolve(env('STEP_INVITES_FILE'));
const aiKey = process.env.STEP_AI_KEY;
const domains = [...list(env('STEP_ALLOWED_DOMAINS'))];
const admins = list(process.env.STEP_ADMINS ?? '');
const invitations = new InvitationStore(join(dataRoot, 'gateway-invitations.sqlite'), domains, admins);
const baseInvitations = async () => list(await readFile(invitesFile, 'utf8'));
// Production must explicitly configure the shared workspace policy.
const workspacesPerUser = number('STEP_QUOTA_WORKSPACES', Number(env('STEP_QUOTA_WORKSPACES')));

const manager = new RuntimeManager({
  dataRoot,
  driver: processDriver(),
  workspacesPerUser,
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
  workspacesPerUser,
  activeRunsPerUser: number('STEP_QUOTA_ACTIVE_RUNS', DEFAULT_QUOTAS.activeRunsPerUser),
  runsPerUserPerDay: number('STEP_QUOTA_DAILY_RUNS', DEFAULT_QUOTAS.runsPerUserPerDay),
};
const server = createGateway({
  manager,
  runs: new RunService(manager, audit, quotas, Date.now, quotaStore),
  audit,
  quotas,
  origin: env('STEP_APP_ORIGIN'),
  invitations,
  baseInvitations,
  authenticate: googleIdTokenAuth({
    clientId: env('STEP_GOOGLE_CLIENT_ID'),
    domains,
    // One email per line; read on every request so removing a line revokes access without a restart.
    invited: async () => invitations.invited(await baseInvitations()),
    admins,
  }),
});

const sweep = setInterval(() => void manager.sweepIdle().catch(() => {}), 60_000);
const host = process.env.STEP_GATEWAY_HOST ?? '127.0.0.1';
const port = number('STEP_GATEWAY_PORT', 8787);
server.listen(port, host, () => console.log(`STeP Gateway: http://${host}:${port}`));

const shutdown = gatewayShutdown(
  () => {
    clearInterval(sweep);
    server.close();
  },
  () => manager.shutdown(),
  () => {
    try {
      quotaStore.close();
    } finally {
      invitations.close();
    }
  },
  (status) => process.exit(status),
  (error) => console.error('Gateway shutdown failed:', error),
);
process.on('SIGTERM', () => void shutdown().catch(() => {}));
process.on('SIGINT', () => void shutdown().catch(() => {}));
