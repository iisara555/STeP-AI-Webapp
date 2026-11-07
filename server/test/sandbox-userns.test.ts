// Real-XFS acceptance (docs/native-quota-xfs-acceptance.md, run 2026-11-07 on ik-node-01) measured that a file owner
// OUTSIDE a user namespace can set its files' project id to 0 and clear PROJINHERIT, escaping the project quota,
// while the same writer inside a new user namespace gets EINVAL. Every workload sandbox must therefore keep its own
// user namespace and must not be able to step back out of it. These assertions guard the flags, not the kernel.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sandboxMounts } from '../src/workspace/process-driver.ts';
import { stepRunnerSandboxArgs } from '../src/workspace/step-runner-driver.ts';
import type { RuntimeSpec } from '../src/workspace/contract.ts';

const spec = {
  ownerId: 'u',
  workspaceId: 'w',
  dir: '/srv/step/data/p100000',
  filesDir: '/srv/step/data/p100000/files',
} as unknown as RuntimeSpec;

function assertOwnUserNamespace(args: string[]) {
  assert.ok(
    args.includes('--unshare-user'),
    'workload must run in its own user namespace (quota escape otherwise)',
  );
  assert.ok(args.includes('--disable-userns'), 'workload must not create further user namespaces');
  for (const flag of ['--share-user', '--userns', '--userns2', '--cap-add', '--uid', '--gid'])
    assert.ok(!args.includes(flag), `${flag} would weaken the user-namespace boundary`);
}

test('generic sandbox keeps the workload in its own user namespace', () => {
  for (const dirFd of [undefined, 1])
    assertOwnUserNamespace(
      sandboxMounts(spec, { appRoot: '/srv/step/app', nodeDir: '/srv/step/node/bin', dirFd }),
    );
});

test('step-runner sandbox keeps the workload in its own user namespace', () => {
  assertOwnUserNamespace(
    stepRunnerSandboxArgs(spec, {
      appRoot: '/srv/step/app',
      nodePath: '/srv/step/node/bin/node',
      socketDir: '/run/step-sockets/abc',
      env: { PATH: '/usr/bin:/bin' },
      dirFd: 1,
    }),
  );
});
