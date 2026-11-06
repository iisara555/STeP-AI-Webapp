import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { processDriver } from '../src/workspace/process-driver.ts';

test('optional isolated Unix runtime reaches actual engine through its one socket mount', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'step-unix-isolated-'));
  await mkdir(join(dir, 'files'));
  const driver = processDriver({ transport: 'unix', isolated: true, startTimeoutMs: 5000 });
  let handle;
  try {
    handle = await driver.start({
      dir,
      filesDir: join(dir, 'files'),
      ownerId: 'synthetic',
      workspaceId: 'ws_' + 'b'.repeat(32),
    });
    assert.equal((await handle.health()).ok, true);
    await handle.call('connect', { baseUrl: 'http://127.0.0.1:1/v1', model: 'synthetic' });
    const answer = await handle.call('ask', { text: 'ช่วยคิดชื่องานสัมมนาให้หน่อย' });
    assert.equal(answer.status, 'review', String(answer.code));
    assert.equal(answer.answer, 'คำตอบจำลองจาก Desktop engine');
  } finally {
    await handle?.stop();
    await rm(dir, { recursive: true, force: true });
  }
});
