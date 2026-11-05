import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createGateway } from '../src/gateway/http.ts';
import { InvitationStore } from '../src/gateway/invitation-store.ts';
import { RunService } from '../src/gateway/runs.ts';
import type { RuntimeDriver } from '../src/workspace/contract.ts';
import { RuntimeManager } from '../src/workspace/manager.ts';

test('revocation before a pending workspace stop reaches the runtime prevents the stop', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'step-stop-repro-'));
  const base = new Set(['root@step.example', 'alice@step.example']);
  const first = new InvitationStore(
    join(dir, 'invites.sqlite'),
    ['step.example'],
    new Set(['root@step.example']),
  );
  const second = new InvitationStore(
    join(dir, 'invites.sqlite'),
    ['step.example'],
    new Set(['root@step.example']),
  );
  let releaseStart!: () => void;
  let startEntered!: () => void;
  let stopEntered!: () => void;
  const startGate = new Promise<void>((resolve) => (releaseStart = resolve));
  const startReady = new Promise<void>((resolve) => (startEntered = resolve));
  const stopReady = new Promise<void>((resolve) => (stopEntered = resolve));
  let stops = 0;
  const driver: RuntimeDriver = {
    async start(spec) {
      startEntered();
      await startGate;
      return {
        health: async () => ({ ok: true, workspaceId: spec.workspaceId }),
        call: async () => {
          throw new Error('unused');
        },
        onExit: () => {},
        stop: async () => {
          stops++;
        },
        stopWithAdmission: async (admit) => {
          admit(() => {
            stops++;
          });
        },
      };
    },
  };
  const manager = new RuntimeManager({ workspacesPerUser: 10, dataRoot: dir, driver });
  // Observe entry to the real stopKey without delaying or replacing its implementation.
  const internal = manager as unknown as {
    stopKey: (
      key: string,
      admit?: (signal: () => void) => void,
      authorize?: () => Promise<void>,
    ) => Promise<void>;
  };
  const stopKey = internal.stopKey.bind(manager);
  internal.stopKey = (key, admit, authorize) => {
    stopEntered();
    return stopKey(key, admit, authorize);
  };
  const audit = () => {};
  const server = createGateway({
    manager,
    runs: new RunService(manager, audit),
    audit,
    invitations: first,
    baseInvitations: () => base,
    authenticate: async (header) =>
      header === 'Bearer alice' ? { userId: 'alice', email: 'alice@step.example', admin: false } : null,
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  try {
    const workspace = await manager.create('alice', { name: 'synthetic' });
    const starting = manager.start('alice', workspace.id);
    await startReady;
    const request = fetch(
      `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/workspaces/${workspace.id}/stop`,
      {
        method: 'POST',
        headers: { authorization: 'Bearer alice' },
      },
    );
    await stopReady;
    second.change('root@step.example', 'alice@step.example', false, base);
    assert.equal(first.invited(base).has('alice@step.example'), false);
    releaseStart();
    await starting;
    const response = await request;
    assert.equal(response.status, 401);
    assert.equal(stops, 0, 'revoked stop reached the runtime after revocation committed');
  } finally {
    releaseStart();
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
    await manager.shutdown();
    first.close();
    second.close();
    await rm(dir, { recursive: true, force: true });
  }
});
