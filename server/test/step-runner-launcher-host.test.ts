// HOST tests of the protected step-runner launcher through the real sudo-rs rule. PREPARED, NOT YET RUN: they need
// the owner install of native/runner-launcher (docs/step-runner-launcher.md) and are skipped unless
//   STEP_STEP_RUNNER_TESTS=1 STEP_RUNNER_LAUNCHER_INSTALLED=1
// Tier A (launcher installed): what the sudo rule admits, launcher refusals as step-runner, installed pin.
//   + STEP_RUNNER_BWRAP_REVOKED=1 after `install --revoke-bwrap`: raw bwrap as step-runner is refused.
// Tier B (broker installed too, gates 1-2 of docs/native-quota-broker-service.md):
//   + STEP_LAUNCHER_TEST_USER_UUID=<a user UUID from the broker policy>: a real runtime in a real per-user pool.
//   Each run allocates one new workspace directory in that user's pool; the broker never removes it.
// Synthetic data only: the launcher forces the runtime's synthetic provider.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, constants, openSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, test } from 'node:test';
import { WorkspaceError, type RuntimeSpec } from '../src/workspace/contract.ts';
import { brokerClient } from '../src/workspace/native-quota-socket.ts';
import { PROTECTED_LAUNCHER, stepRunnerDriver } from '../src/workspace/step-runner-driver.ts';

const REPO = resolve(import.meta.dirname, '../..');
const env = process.env;
const tierA = env.STEP_STEP_RUNNER_TESTS === '1' && env.STEP_RUNNER_LAUNCHER_INSTALLED === '1';
const skipA = tierA
  ? false
  : 'host test: owner install of native/runner-launcher first, then STEP_STEP_RUNNER_TESTS=1 STEP_RUNNER_LAUNCHER_INSTALLED=1';
const skipRevoked =
  tierA && env.STEP_RUNNER_BWRAP_REVOKED === '1' ? false : 'host test: after install --revoke-bwrap';
const testUser = env.STEP_LAUNCHER_TEST_USER_UUID;
const skipB = tierA && testUser ? false : 'host test: broker installed and STEP_LAUNCHER_TEST_USER_UUID set';
const UUID0 = '00000000-0000-4000-8000-000000000000';
const ID0 = '0'.repeat(32);
const DIR = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;

const asRunner = (args: string[], stdout: number | 'ignore' = 'ignore') =>
  spawnSync('sudo', ['-n', '-u', 'step-runner', ...args], {
    stdio: ['ignore', stdout, 'pipe'],
    encoding: 'utf8',
    env: { PATH: '/usr/bin:/bin' },
    timeout: 10_000,
  });
const runnerPids = () => {
  const r = spawnSync('pgrep', ['-u', 'step-runner'], { encoding: 'utf8' });
  return r.stdout.trim();
};

describe('protected launcher on this host (tier A)', { skip: skipA }, () => {
  test('the installed launcher is the pinned, root-owned build', () => {
    const pinned = /^readonly LAUNCH_SHA256=([0-9a-f]{64})$/m.exec(
      readFileSync(join(REPO, 'native/runner-launcher/install/install-runner-launcher.sh'), 'utf8'),
    )?.[1];
    const actual = execFileSync('sha256sum', [PROTECTED_LAUNCHER.path], { encoding: 'utf8' }).split(' ')[0];
    assert.equal(actual, pinned);
    const meta = execFileSync('stat', ['-c', '%u %a', PROTECTED_LAUNCHER.path], { encoding: 'utf8' }).trim();
    assert.equal(meta, '0 755');
  });

  test('sudo admits only `launch v1 ...`; the launcher then refuses anything but a valid request', () => {
    const usage = asRunner([PROTECTED_LAUNCHER.path, 'v1']);
    assert.equal(usage.status, 2, usage.stderr);
    assert.match(usage.stderr, /step-runner-launch: REFUSED usage/);
    for (const args of [[], ['v2', 'x'], ['--unshare-net']]) {
      const refused = asRunner([PROTECTED_LAUNCHER.path, ...args]);
      assert.notEqual(refused.status, 0);
      assert.doesNotMatch(refused.stderr, /step-runner-launch:/, `sudo itself must refuse ${args.join(' ')}`);
    }
    // Running as step-runner with root-owned app/node/bwrap: past the credential and trusted-path checks.
    const nul = openSync('/dev/null', 'w');
    try {
      const r = asRunner([PROTECTED_LAUNCHER.path, 'v1', `p100000/${UUID0}`, ID0, '65536'], nul);
      assert.equal(r.status, 2);
      assert.match(r.stderr, /REFUSED (broker-root|workspace)/);
    } finally {
      closeSync(nul);
    }
    const tmp = openSync('/tmp', DIR);
    try {
      const r = asRunner([PROTECTED_LAUNCHER.path, 'v1', `p100000/${UUID0}`, ID0, '65536'], tmp);
      assert.equal(r.status, 2);
      assert.match(r.stderr, /REFUSED (broker-root|workspace)/);
    } finally {
      closeSync(tmp);
    }
    assert.equal(runnerPids(), '', 'no step-runner process left');
  });

  test(
    'after --revoke-bwrap the gateway can no longer run bwrap (or anything else) as step-runner',
    { skip: skipRevoked },
    () => {
      for (const args of [['/usr/bin/bwrap', '--version'], ['/usr/bin/id'], ['/bin/sh', '-c', 'id']]) {
        const r = asRunner(args);
        assert.notEqual(r.status, 0, `${args[0]} must be refused`);
      }
    },
  );
});

describe('protected launcher with the real broker (tier B)', { skip: skipB }, () => {
  const runnerUid = Number(execFileSync('id', ['-u', 'step-runner'], { encoding: 'utf8' }));
  const driver = () =>
    stepRunnerDriver({
      launcher: 'protected',
      transport: 'authenticated',
      appRoot: PROTECTED_LAUNCHER.appRoot,
      nodePath: PROTECTED_LAUNCHER.nodePath,
      socketRoot: PROTECTED_LAUNCHER.socketRoot,
      runnerUid,
      memoryMaxBytes: 1024 * 1024 * 1024,
      tasksMax: 128,
      cpuQuotaPercent: 100,
      tmpfsBytes: 16 * 1024 * 1024,
      startTimeoutMs: 60_000,
      stopTimeoutMs: 3_000,
    });
  const workspace = async () => {
    const uuid = randomUUID();
    const r = await brokerClient({ socketPath: '/run/step-quota-broker/broker.sock' }).ensureWorkspace(
      testUser!,
      uuid,
    );
    const dir = `${PROTECTED_LAUNCHER.brokerRoot}/p${r.projectId}/${uuid}`;
    const spec = {
      ownerId: 'host-test',
      workspaceId: `ws_${uuid.replaceAll('-', '')}`,
      dir,
      filesDir: `${dir}/files`,
    };
    return spec as unknown as RuntimeSpec;
  };

  test('a pinned start runs the real runtime as step-runner in its pool workspace, then stops clean', async () => {
    const spec = await workspace();
    const handle = await driver().startPinnedWithAdmission(
      spec,
      () => openSync(spec.dir, DIR),
      (spawn) => spawn(),
    );
    try {
      assert.equal(handle.scope.peerUid, runnerUid);
      const health = await handle.health(10_000);
      assert.equal(health.ok, true);
      assert.equal(health.workspaceId, spec.workspaceId);
    } finally {
      await handle.stop();
    }
    assert.equal(runnerPids(), '');
  });

  test('a descriptor other than the requested workspace is refused by the launcher (nothing runs)', async () => {
    const spec = await workspace();
    for (const wrong of [`${spec.dir}/files`, '/tmp']) {
      await assert.rejects(
        driver().startPinnedWithAdmission(
          spec,
          () => openSync(wrong, DIR),
          (spawn) => spawn(),
        ),
        (error: unknown) => error instanceof WorkspaceError && error.code === 'RUNTIME_START_FAILED',
      );
      assert.equal(runnerPids(), '');
    }
  });
});
