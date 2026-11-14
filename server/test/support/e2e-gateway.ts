import { provisionTestQuota } from './quota.ts';
// A Gateway for the browser checks of Cloud Workspace mode (test/e2e/cloud-workspace.spec.ts). Real HTTP routes,
// runs and event stream; the runtime streams a scripted answer over a few seconds and no AI provider is called.
// It accepts one synthetic credential, never a Google account.
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Authenticator } from '../../src/gateway/auth.ts';
import { createGateway } from '../../src/gateway/http.ts';
import { RunService } from '../../src/gateway/runs.ts';
import { RuntimeManager } from '../../src/workspace/manager.ts';
import { scriptedDriver } from './scripted-driver.ts';
export { ANSWER } from './scripted-driver.ts';

export const E2E_GATEWAY_PORT = 8799;
export const E2E_TOKEN_SUB = 'e2e-employee';
const ORIGIN = process.env.STEP_E2E_ORIGIN ?? 'http://127.0.0.1:5175';

const dataRoot = await mkdtemp(join(tmpdir(), 'step-e2e-gateway-'));
const manager = new RuntimeManager({
  workspacesPerUser: 10,
  dataRoot: provisionTestQuota(dataRoot, 10),
  driver: scriptedDriver(),
});
const authenticate: Authenticator = async (header) => {
  const payload = /^Bearer [^.]+\.([^.]+)\.[^.]+$/.exec(header ?? '')?.[1];
  if (!payload) return null;
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  return claims.sub === E2E_TOKEN_SUB
    ? { userId: E2E_TOKEN_SUB, email: 'e2e@step.example', admin: false }
    : null;
};
const audit = () => {};
createGateway({ manager, runs: new RunService(manager, audit), authenticate, audit, origin: ORIGIN }).listen(
  E2E_GATEWAY_PORT,
  '127.0.0.1',
);
