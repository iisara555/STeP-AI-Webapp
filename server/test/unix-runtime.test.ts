import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { processDriver } from '../src/workspace/process-driver.ts';

// Actual runtime-main/SQLite/engine endpoint, not the synthetic protocol spike.
test('Unix transport runs real runtime RPC and survives stop/resume without fork IPC', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'step-unix-'));
  await mkdir(join(dir, 'files'));
  const spec = {
    workspaceId: 'ws_' + 'a'.repeat(32),
    ownerId: 'synthetic',
    dir,
    filesDir: join(dir, 'files'),
  };
  const driver = processDriver({ transport: 'unix', socketRoot: dir });
  let handle;
  try {
    handle = await driver.start(spec);
    assert.equal((await readdir(dir)).filter((name) => name.startsWith('ipc-')).length, 1);
    assert.equal((await handle.health()).ok, true);
    assert.equal((await handle.health()).workspaceId, spec.workspaceId);
    await handle.call('connect', {
      baseUrl: 'http://127.0.0.1:1/v1',
      model: 'synthetic',
      token: 'never-written',
    });
    const created = await handle.call('newConversation', {});
    assert.ok(created.sessionId);
    await assert.rejects(handle.call('messages', { sessionId: 'missing' }), /CONVERSATION_NOT_FOUND/);
    await handle.stop();
    assert.equal((await readdir(dir)).filter((name) => name.startsWith('ipc-')).length, 0);
    handle = await driver.start(spec);
    assert.equal((await handle.call('conversations', {}))[0].id, created.sessionId);
  } finally {
    await handle?.stop();
    await rm(dir, { recursive: true, force: true });
  }
});
