import { provisionTestQuota } from './support/quota.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RuntimeManager } from '../src/workspace/manager.ts';
import { heldDriver } from './support/held-driver.ts';

test('authenticated start fails closed when the driver cannot fence its spawn', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'step-start-unsupported-'));
  const runtime = heldDriver();
  let starts = 0;
  const manager = new RuntimeManager({
    dataRoot: provisionTestQuota(dir, 10),
    workspacesPerUser: 10,
    driver: {
      start: (spec) => {
        starts++;
        return runtime.driver.start(spec);
      },
    },
  });
  try {
    const workspace = await manager.create('alice', { name: 'unsupported' });
    const start = manager.start.bind(manager) as (
      actor: string,
      id: string,
      admit: (spawn: () => void) => void,
    ) => Promise<unknown>;
    await assert.rejects(
      start('alice', workspace.id, (spawn) => spawn()),
      /ADMISSION_UNSUPPORTED/,
    );
    assert.equal(starts, 0);
  } finally {
    await manager.shutdown();
    await rm(dir, { recursive: true, force: true });
  }
});
