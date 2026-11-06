import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createConnection, createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { jsonChannel, prepareUnixRuntime } from '../src/workspace/unix-channel.ts';
import { processDriver } from '../src/workspace/process-driver.ts';

const MODULE = new URL('../src/workspace/unix-channel.ts', import.meta.url).href;
test('distinct same-UID process cannot forge ready or authenticate with an invented capability', async () => {
  const channel = await prepareUnixRuntime();
  const child = channel.spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      '--input-type=module',
      '-e',
      `
    import { runtimeUnixChannel } from ${JSON.stringify(MODULE)};
    await new Promise(r => setTimeout(r, 400));
    const ch = await runtimeUnixChannel();
    process.on('disconnect', () => process.exit(23));
    ch.onMessage(m => ch.send({type:'result',nonce:m.nonce,ok:true,result:'real'}));
    ch.send({type:'ready'});
  `,
    ],
    { env: { PATH: process.env.PATH } },
  );
  const messages: any[] = [];
  child.on('message', (value) => messages.push(value));
  const ready = once(child, 'message');
  const attacker = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import {createConnection} from 'node:net';
    const s = createConnection(${JSON.stringify(join(channel.directory, 'runtime.sock'))});
    s.on('error', () => {});
    s.once('data', () => s.write(JSON.stringify({type:'ready',proof:'0'.repeat(64),challenge:'a'.repeat(64)})+'\\n'));
    s.once('close', () => process.exit(0));
    setTimeout(() => process.exit(1), 1500);
  `,
    ],
    { stdio: 'ignore' },
  );
  try {
    assert.equal((await once(attacker, 'exit'))[0], 0);
    assert.deepEqual(await ready, [{ type: 'ready' }]);
    assert.deepEqual(messages, [{ type: 'ready' }]);
    const result = once(child, 'message');
    child.send({ type: 'call', nonce: 1, method: 'health', params: {} });
    assert.equal((await result)[0].result, 'real');
    child.disconnect();
    assert.equal((await once(child, 'exit'))[0], 23);
  } finally {
    attacker.kill('SIGKILL');
    child.kill('SIGKILL');
    await channel.dispose();
  }
});

test('framing preserves split UTF-8/coalesced messages and rejects invalid JSON and oversize frames', async () => {
  const root = await mkdtemp(join(tmpdir(), 'step-frame-'));
  const path = join(root, 'socket');
  const values: unknown[] = [];
  const server = createServer((socket) => jsonChannel(socket, (value) => values.push(value)));
  await new Promise<void>((done) => server.listen(path, done));
  let socket = createConnection(path);
  try {
    await once(socket, 'connect');
    const bytes = Buffer.from(JSON.stringify({ text: 'ไทย' }) + '\n' + JSON.stringify({ n: 2 }) + '\n');
    socket.write(bytes.subarray(0, 11));
    socket.write(bytes.subarray(11));
    while (values.length !== 2) await new Promise((r) => setTimeout(r, 5));
    assert.deepEqual(values, [{ text: 'ไทย' }, { n: 2 }]);
    socket.write('not-json\n');
    await once(socket, 'close');
    socket = createConnection(path);
    await once(socket, 'connect');
    socket.on('error', () => {});
    socket.write(Buffer.alloc(1024 * 1024 + 1, 65));
    await once(socket, 'close').catch(() => {});
    assert.equal(values.length, 2);
  } finally {
    socket.destroy();
    await new Promise<void>((done) => server.close(() => done()));
    await rm(root, { recursive: true, force: true });
  }
});

test('Unix preparation is removed on denied, skipped and post-spawn failed admission', async () => {
  const root = await mkdtemp(join(tmpdir(), 'step-admission-'));
  const spec = { workspaceId: 'ws_' + 'a'.repeat(32), ownerId: 'synthetic', dir: root, filesDir: root };
  const driver = processDriver({ transport: 'unix', socketRoot: root });
  const denied = new Error('DENIED');
  try {
    await assert.rejects(
      driver.startWithAdmission!(spec, () => {
        throw denied;
      }),
      (error) => error === denied,
    );
    assert.deepEqual(await readdir(root), []);
    await assert.rejects(
      driver.startWithAdmission!(spec, () => {}),
      /ADMISSION_SKIPPED/,
    );
    assert.deepEqual(await readdir(root), []);
    await assert.rejects(
      driver.startWithAdmission!(spec, (spawn) => {
        spawn();
        throw denied;
      }),
      (error) => error === denied,
    );
    assert.deepEqual(await readdir(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
