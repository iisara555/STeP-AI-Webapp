import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  stepRunnerCommand,
  stepRunnerDriver,
  type StepRunnerOptions,
} from '../src/workspace/step-runner-driver.ts';
import { workspacePaths } from '../src/workspace/storage.ts';

const options: StepRunnerOptions = {
  appRoot: '/opt/step/app',
  nodePath: '/opt/step/node/bin/node',
  socketRoot: '/run/step/sockets',
  runnerUid: 995,
  memoryMaxBytes: 1073741824,
  tasksMax: 128,
  cpuQuotaPercent: 100,
  transport: 'authenticated',
};
const spec = workspacePaths('/srv/step', 'alice', `ws_${'a'.repeat(32)}`);

test('authenticated runner launch selects mutual authentication without a capability in argv', () => {
  const args = stepRunnerCommand(spec, options, {
    unit: 'step-rt-test.scope',
    socketDir: '/run/step/sockets/test',
  });
  const env = Object.fromEntries(
    args.flatMap((arg, i) => (arg === '--setenv' ? [[args[i + 1], args[i + 2]]] : [])),
  );
  assert.equal(env.STEP_RUNTIME_TRANSPORT, 'unix');
  assert.equal(env.STEP_RUNTIME_SOCKET, undefined);
  assert.ok(!args.some((arg) => /[0-9a-f]{64}/.test(arg)));
  assert.ok(args.includes('MemorySwapMax=0'));
});

test('authenticated runner admission refusal removes prepared endpoint without launching', async () => {
  const root = await mkdtemp(join(tmpdir(), 'step-auth-runner-'));
  const denied = new Error('AUTHORITY_REVOKED');
  try {
    const driver = stepRunnerDriver({ ...options, socketRoot: root });
    await assert.rejects(
      driver.startWithAdmission(spec, () => {
        throw denied;
      }),
      (e) => e === denied,
    );
    assert.deepEqual(await readdir(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
