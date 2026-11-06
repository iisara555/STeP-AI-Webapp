import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { processDriver } from '../src/workspace/process-driver.ts';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { runtimeEnv } from '../src/workspace/process-driver.ts';
import { channel } from 'node:diagnostics_channel';
import type { ChildProcess } from 'node:child_process';

test('Unix outbound oversize rejects repeatedly without retaining RPC listeners; same PID stays healthy', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'step-outbound-size-'));
  await mkdir(join(dir, 'files'));
  let child: ChildProcess | undefined;
  const spawned = channel('child_process');
  const observe = (message: unknown) => {
    child = (message as { process: ChildProcess }).process;
  };
  const warnings: Error[] = [];
  const warning = (error: Error) => {
    if (error.name === 'MaxListenersExceededWarning') warnings.push(error);
  };
  process.on('warning', warning);
  spawned.subscribe(observe);
  let handle;
  try {
    handle = await processDriver({ transport: 'unix', socketRoot: dir }).start({
      workspaceId: 'ws_' + 'c'.repeat(32),
      ownerId: 'synthetic',
      dir,
      filesDir: join(dir, 'files'),
    });
    spawned.unsubscribe(observe);
    assert.ok(child);
    const before = await handle.health();
    const listeners = { message: child.listenerCount('message'), exit: child.listenerCount('exit') };
    const timers = process.getActiveResourcesInfo().filter((resource) => resource === 'Timeout').length;
    for (let i = 0; i < 16; i++)
      await assert.rejects(
        handle.call('connect', {
          baseUrl: 'https://synthetic.invalid/v1',
          model: 'synthetic',
          token: 'x'.repeat(2 * 1024 * 1024),
        }),
        /RUNTIME_FRAME_TOO_LARGE/,
      );
    await new Promise<void>((done) => setImmediate(done));
    assert.deepEqual(warnings, []);
    assert.equal(child.listenerCount('message'), listeners.message, 'no retained result listeners');
    assert.equal(child.listenerCount('exit'), listeners.exit, 'no retained exit listeners');
    assert.equal(
      process.getActiveResourcesInfo().filter((resource) => resource === 'Timeout').length,
      timers,
    );
    const after = await handle.health();
    assert.equal(after.ok, true);
    assert.equal(after.pid, before.pid);
    assert.deepEqual(await handle.call('conversations', {}), []);
  } finally {
    spawned.unsubscribe(observe);
    process.off('warning', warning);
    await handle?.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

for (const method of ['health', 'unknown'])
  test(`runtime handles closed-channel ${method} reply without an unhandled rejection`, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'step-closed-reply-'));
    await mkdir(join(dir, 'files'));
    const entry = new URL('../src/workspace/runtime-main.ts', import.meta.url).href;
    const channel = new URL('../src/workspace/unix-channel.ts', import.meta.url).href;
    // Inject a genuinely closed JSON channel at the send seam; the next nonce uses live IPC.
    const child = spawn(
      process.execPath,
      [
        '--import',
        import.meta.resolve('tsx'),
        '--import',
        new URL('../src/register.mjs', import.meta.url).href,
        '--input-type=module',
        '-e',
        `
        import { Socket } from 'node:net';
        import { jsonChannel } from ${JSON.stringify(channel)};
        const closed = jsonChannel(new Socket().destroy(), () => {});
        const live = process.send.bind(process);
        process.send = message => message.nonce === 1 ? closed(message) : live(message);
        process.on('unhandledRejection', () => live({type:'unhandled'}));
        await import(${JSON.stringify(entry)});
      `,
      ],
      {
        cwd: join(dir, 'files'),
        env: runtimeEnv({
          workspaceId: 'ws_' + 'c'.repeat(32),
          ownerId: 'synthetic',
          dir,
          filesDir: join(dir, 'files'),
        }),
        stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
      },
    );
    try {
      assert.deepEqual((await once(child, 'message'))[0], { type: 'ready' });
      const response = once(child, 'message');
      child.send!({ type: 'call', nonce: 1, method, params: {} });
      child.send!({ type: 'call', nonce: 2, method: 'health', params: {} });
      const [message] = await response;
      assert.equal(message.type, 'result');
      assert.equal(message.nonce, 2);
      assert.equal(message.result.ok, true);
      // unhandledRejection is emitted after promise callbacks, not necessarily before nonce 2.
      const unexpected: unknown[] = [];
      child.on('message', (value) => unexpected.push(value));
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.deepEqual(unexpected, []);
      const exited = once(child, 'exit');
      child.disconnect();
      assert.equal((await exited)[0], 0);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit');
        child.kill('SIGKILL');
        await exited;
      }
      await rm(dir, { recursive: true, force: true });
    }
  });

for (const transport of ['fork', 'unix'] as const)
  test(`${transport}: oversized messages are explicit, preserve data and leave the same runtime healthy`, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'step-large-result-'));
    await mkdir(join(dir, 'files'));
    const spec = {
      workspaceId: 'ws_' + 'b'.repeat(32),
      ownerId: 'synthetic',
      dir,
      filesDir: join(dir, 'files'),
    };
    const driver = processDriver({ transport, socketRoot: dir });
    let handle;
    try {
      handle = await driver.start(spec);
      const { sessionId } = await handle.call('newConversation', {});
      const messages = Array.from({ length: 60 }, () => ({ role: 'user', text: 'x'.repeat(20_000) }));
      assert.ok(Buffer.byteLength(JSON.stringify(messages)) > 1024 * 1024);
      const db = new DatabaseSync(join(dir, 'workspace.sqlite'));
      try {
        const row = db.prepare("SELECT value FROM records WHERE kind='session' AND id=?").get(sessionId)!;
        db.prepare("UPDATE records SET value=? WHERE kind='session' AND id=?").run(
          JSON.stringify({ ...JSON.parse(String(row.value)), messages }),
          sessionId,
        );
      } finally {
        db.close();
      }
      const before = await handle.health();
      if (transport === 'fork') assert.deepEqual(await handle.call('messages', { sessionId }), messages);
      else await assert.rejects(handle.call('messages', { sessionId }), { code: 'RUNTIME_RESULT_TOO_LARGE' });
      const after = await handle.health();
      assert.equal(after.ok, true);
      assert.equal(after.pid, before.pid);
      const small = await handle.call('newConversation', {});
      assert.deepEqual(await handle.call('messages', small), []);
      // The oversized read is not silently truncated or persisted back over the source.
      const verify = new DatabaseSync(join(dir, 'workspace.sqlite'));
      try {
        const row = verify.prepare("SELECT value FROM records WHERE kind='session' AND id=?").get(sessionId)!;
        assert.deepEqual(JSON.parse(String(row.value)).messages, messages);
      } finally {
        verify.close();
      }
    } finally {
      await handle?.stop();
      await rm(dir, { recursive: true, force: true });
    }
  });

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
