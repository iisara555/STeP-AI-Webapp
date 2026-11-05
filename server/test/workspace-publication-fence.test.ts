import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RuntimeManager } from '../src/workspace/manager.ts';
import { workspacePaths } from '../src/workspace/storage.ts';
import { heldDriver } from './support/held-driver.ts';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}

test('messages fences enqueue after start resolves; another caller keeps its own authority', async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), 'step-messages-fence-'));
  const runtime = heldDriver();
  let reads = 0;
  let inside = false;
  const original = runtime.driver.start;
  runtime.driver.start = async (spec) => {
    const handle = await original(spec);
    const call = handle.call.bind(handle);
    handle.call = (method, params) => {
      if (method === 'messages') {
        reads++;
        assert.equal(inside, true, 'enqueue must execute inside admission');
      }
      return call(method, params);
    };
    return handle;
  };
  const manager = new RuntimeManager({ dataRoot: dir, driver: runtime.driver });
  let allowed = true;
  const authority = {
    authorize: async () => {},
    admit: (send: () => void) => {
      if (!allowed) throw new Error('UNAUTHENTICATED');
      inside = true;
      try {
        send();
      } finally {
        inside = false;
      }
    },
  };
  try {
    const workspace = await manager.create('alice', { name: 'synthetic' });
    const start = manager.start.bind(manager);
    manager.start = async (...args) => {
      const result = await start(...args);
      allowed = false;
      return result;
    };
    await assert.rejects(manager.messages('alice', workspace.id, 'c1', authority), /UNAUTHENTICATED/);
    assert.equal(reads, 0);
    manager.start = start;
    await manager.messages('alice', workspace.id, 'c1', {
      authorize: async () => {},
      admit: (send) => {
        inside = true;
        try {
          send();
        } finally {
          inside = false;
        }
      },
    });
    assert.equal(reads, 1);
    assert.equal((await manager.get('alice', workspace.id)).state, 'running');
  } finally {
    await manager.shutdown();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

for (const running of [false, true]) {
  test(`start metadata publication rechecks authority after staging (running=${running})`, async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), 'step-touch-fence-'));
    const runtime = heldDriver();
    let now = 0;
    const manager = new RuntimeManager({ dataRoot: dir, driver: runtime.driver, now: () => now });
    const written = deferred();
    const release = deferred();
    const writeFile = fs.writeFile;
    let allowed = true;
    try {
      const workspace = await manager.create('alice', { name: 'synthetic' });
      if (running) await manager.start('alice', workspace.id);
      const metadata = join(workspacePaths(dir, 'alice', workspace.id).dir, 'workspace.json');
      const before = await fs.readFile(metadata, 'utf8');
      now = 1000;
      fs.writeFile = (async (...args: Parameters<typeof fs.writeFile>) => {
        await writeFile(...args);
        if (String(args[0]).startsWith(metadata + '.') && String(args[0]).endsWith('.tmp')) {
          written.resolve();
          await release.promise;
        }
      }) as typeof fs.writeFile;
      syncBuiltinESMExports();
      const result = manager.start('alice', workspace.id, (publish) => {
        if (!allowed) throw new Error('UNAUTHENTICATED');
        publish();
      });
      const rejected = assert.rejects(result, /UNAUTHENTICATED/);
      await written.promise;
      allowed = false;
      release.resolve();
      await rejected;
      assert.equal(await fs.readFile(metadata, 'utf8'), before);
      assert.equal(
        (await fs.readdir(join(metadata, '..'))).some((name) => name.endsWith('.tmp')),
        false,
      );
      assert.equal((await manager.get('alice', workspace.id)).state, 'running');
    } finally {
      release.resolve();
      fs.writeFile = writeFile;
      syncBuiltinESMExports();
      await manager.shutdown();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
}

test('revocation blocks completion metadata but preserves an admitted run result', async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), 'step-completion-fence-'));
  const runtime = heldDriver();
  let now = 0;
  let allowed = true;
  const sent = deferred();
  const manager = new RuntimeManager({ dataRoot: dir, driver: runtime.driver, now: () => now });
  const authority = {
    authorize: async () => {},
    admit: (send: () => void) => {
      if (!allowed) throw new Error('UNAUTHENTICATED');
      send();
    },
  };
  try {
    const workspace = await manager.create('alice', { name: 'synthetic' });
    const { sessionId } = await manager.newConversation('alice', workspace.id);
    const result = manager.ask(
      'alice',
      workspace.id,
      { text: 'synthetic', sessionId },
      () => sent.resolve(),
      undefined,
      authority,
    );
    await sent.promise;
    const metadata = join(workspacePaths(dir, 'alice', workspace.id).dir, 'workspace.json');
    const before = await fs.readFile(metadata, 'utf8');
    now = 1000;
    allowed = false;
    runtime.answer(sessionId, 'synthetic answer');
    assert.equal((await result).status, 'review');
    assert.equal(await fs.readFile(metadata, 'utf8'), before);
    assert.equal((await manager.get('alice', workspace.id)).state, 'running');
  } finally {
    await manager.shutdown();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
