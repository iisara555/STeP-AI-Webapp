import { resolve } from 'node:path';
import { initializeWorkspaceQuota } from '../../src/workspace/quota-store.ts';

/** Explicit operator provisioning for synthetic test roots, separate from startup. */
export function provisionTestQuota(dataRoot: string, limit: number): string {
  initializeWorkspaceQuota(dataRoot, limit, { onboardExistingRoot: resolve(dataRoot) });
  return dataRoot;
}
