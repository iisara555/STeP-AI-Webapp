import { provisionTestQuota } from './quota.ts';
// A Gateway for the browser check of the storage pool banner (test/e2e/storage-warnings.spec.ts), on its own
// ports so the Cloud Workspace check (:8799/:5175) and the demo (:5173) are untouched. Real HTTP routes and runs;
// the pool usage is FAKE and fixed per synthetic employee. No filesystem quota, AI provider or Google account.
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Authenticator } from '../../src/gateway/auth.ts';
import { createGateway } from '../../src/gateway/http.ts';
import { RunService } from '../../src/gateway/runs.ts';
import type { PoolUsage, StorageUsageSource } from '../../src/gateway/storage-usage.ts';
import { RuntimeManager } from '../../src/workspace/manager.ts';
import { scriptedDriver } from './scripted-driver.ts';

export const E2E_STORAGE_GATEWAY_PORT = 8797;
const ORIGIN = process.env.STEP_E2E_STORAGE_ORIGIN ?? 'http://127.0.0.1:5176';
export const SEEDED_QUESTION = 'งานเดิมก่อนพื้นที่เต็ม';

const GIB = 1024 ** 3;
/** Fake pools: a 10 GiB / 100 000-file allowance per synthetic employee. */
const POOLS: Record<string, PoolUsage> = {
  'e2e-storage-ok': { bytesUsed: 1 * GIB, bytesHard: 10 * GIB, inodesUsed: 500, inodesHard: 100_000 },
  'e2e-storage-warning': {
    bytesUsed: 8.5 * GIB,
    bytesHard: 10 * GIB,
    inodesUsed: 500,
    inodesHard: 100_000,
  },
  'e2e-storage-critical': {
    bytesUsed: 2 * GIB,
    bytesHard: 10 * GIB,
    inodesUsed: 96_000,
    inodesHard: 100_000,
  },
  'e2e-storage-full': { bytesUsed: 10 * GIB, bytesHard: 10 * GIB, inodesUsed: 900, inodesHard: 100_000 },
};
let seeding = true;
const storageUsage: StorageUsageSource = {
  async usage(ownerId) {
    const pool = POOLS[ownerId];
    if (!pool) throw new Error('UNKNOWN_SYNTHETIC_OWNER');
    // The full employee saved one task before the pool filled up.
    return seeding && ownerId === 'e2e-storage-full' ? { ...pool, bytesUsed: GIB } : pool;
  },
};

const dataRoot = await mkdtemp(join(tmpdir(), 'step-e2e-storage-gateway-'));
const manager = new RuntimeManager({
  workspacesPerUser: 10,
  dataRoot: provisionTestQuota(dataRoot, 10),
  driver: scriptedDriver(),
});
const workspace = await manager.create('e2e-storage-full', { name: 'งานของฉัน' });
const { sessionId } = await manager.newConversation('e2e-storage-full', workspace.id);
await manager.ask('e2e-storage-full', workspace.id, { text: SEEDED_QUESTION, sessionId });
seeding = false;

const authenticate: Authenticator = async (header) => {
  const payload = /^Bearer [^.]+\.([^.]+)\.[^.]+$/.exec(header ?? '')?.[1];
  if (!payload) return null;
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  return typeof claims.sub === 'string' && claims.sub in POOLS
    ? { userId: claims.sub, email: `${claims.sub}@step.example`, admin: false }
    : null;
};
const audit = () => {};
createGateway({
  manager,
  runs: new RunService(manager, audit),
  authenticate,
  audit,
  origin: ORIGIN,
  storageUsage,
}).listen(E2E_STORAGE_GATEWAY_PORT, '127.0.0.1');
