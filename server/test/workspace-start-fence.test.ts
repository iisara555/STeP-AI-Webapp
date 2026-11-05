import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { InvitationStore } from '../src/gateway/invitation-store.ts';
import { createGateway } from '../src/gateway/http.ts';
import { RunService } from '../src/gateway/runs.ts';
import { RuntimeManager } from '../src/workspace/manager.ts';
import { workspacePaths } from '../src/workspace/storage.ts';
import { heldDriver } from './support/held-driver.ts';

test('cross-process revoke before workspace start prevents spawn and metadata changes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'step-start-fence-'));
  const db = join(dir, 'invites.sqlite');
  const base = new Set(['root@step.example', 'alice@step.example']);
  const store = new InvitationStore(db, ['step.example'], new Set(['root@step.example']));
  const runtime = heldDriver();
  let spawns = 0;
  const driver = {
    ...runtime.driver,
    start: async (...args: Parameters<typeof runtime.driver.start>) => {
      spawns++;
      return runtime.driver.start(...args);
    },
    startWithAdmission: async (
      spec: Parameters<typeof runtime.driver.start>[0],
      admit: (spawn: () => void) => void,
    ) => {
      let result: ReturnType<typeof runtime.driver.start> | undefined;
      admit(() => {
        spawns++;
        result = runtime.driver.start(spec);
      });
      return result!;
    },
  };
  const manager = new RuntimeManager({ dataRoot: dir, driver });
  const workspace = await manager.create('alice', { name: 'race' });
  const metadata = join(workspacePaths(dir, 'alice', workspace.id).dir, 'workspace.json');
  const before = await readFile(metadata, 'utf8');
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const ready = new Promise<void>((resolve) => (entered = resolve));
  const start = manager.start.bind(manager);
  manager.start = async (...args) => {
    entered();
    await gate;
    return start(...args);
  };
  const alice = { userId: 'alice', email: 'alice@step.example', admin: false };
  const audit = () => {};
  const server = createGateway({
    manager,
    runs: new RunService(manager, audit),
    audit,
    invitations: store,
    authenticate: async () => (store.invited(base).has(alice.email) ? alice : null),
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const request = fetch(
      `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/workspaces/${workspace.id}/start`,
      { method: 'POST' },
    );
    await ready;
    const moduleUrl = new URL('../src/gateway/invitation-store.ts', import.meta.url).href;
    const script = `import { InvitationStore } from ${JSON.stringify(moduleUrl)}; const s = new InvitationStore(process.argv[1], ['step.example'], new Set(['root@step.example'])); s.change('root@step.example','alice@step.example',false,new Set(['root@step.example','alice@step.example'])); s.close();`;
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, db], {
      stdio: 'ignore',
    });
    assert.equal((await once(child, 'exit'))[0], 0);
    release();
    assert.equal((await request).status, 401);
    assert.equal(spawns, 0, 'revoked request must not spawn');
    assert.equal(
      await readFile(metadata, 'utf8'),
      before,
      'revoked request must not change workspace metadata',
    );
  } finally {
    release();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await manager.shutdown();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
