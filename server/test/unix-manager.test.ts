import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RuntimeManager } from '../src/workspace/manager.ts';
import { processDriver } from '../src/workspace/process-driver.ts';
import { provisionTestQuota } from './support/quota.ts';

test('RuntimeManager uses isolated Unix RPC, streaming events, ownership and persistent resume', async () => {
  const root = await mkdtemp(join(tmpdir(), 'step-unix-manager-'));
  const manager = new RuntimeManager({
    dataRoot: provisionTestQuota(root, 2),
    workspacesPerUser: 2,
    driver: processDriver({ transport: 'unix', isolated: true }),
    grant: () => ({ baseUrl: 'http://127.0.0.1:1/v1', model: 'synthetic' }),
  });
  try {
    const workspace = await manager.create('synthetic-alice', { name: 'Synthetic' });
    const events: unknown[] = [];
    await manager.subscribe('synthetic-alice', workspace.id, (event) => events.push(event));
    const first = await manager.ask('synthetic-alice', workspace.id, {
      text: 'ช่วยคิดชื่องานสัมมนาให้หน่อย',
    });
    assert.equal(first.status, 'review', String(first.code));
    assert.equal(first.answer, 'คำตอบจำลองจาก Desktop engine');
    assert.ok(events.length > 0);
    await assert.rejects(
      manager.messages('synthetic-bob', workspace.id, first.sessionId),
      /WORKSPACE_NOT_FOUND/,
    );
    await manager.stop('synthetic-alice', workspace.id);
    assert.equal((await manager.get('synthetic-alice', workspace.id)).state, 'stopped');
    const second = await manager.ask('synthetic-alice', workspace.id, {
      text: 'ขออีกสามชื่อ',
      sessionId: first.sessionId,
    });
    assert.equal(second.sessionId, first.sessionId);
    assert.equal(second.status, 'review', String(second.code));
    assert.equal((await manager.health('synthetic-alice', workspace.id)).ok, true);
  } finally {
    await manager.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});
