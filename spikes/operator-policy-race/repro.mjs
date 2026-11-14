import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { InvitationStore } from '../../server/src/gateway/invitation-store.ts';

const root = 'root@step.example',
  alice = 'alice@step.example';
function fixture(run) {
  const dir = mkdtempSync(join(tmpdir(), 'operator-race-fixture-'));
  const file = join(dir, 'invites.txt');
  writeFileSync(file, `${root}\n${alice}\n`);
  const store = new InvitationStore(join(dir, 'invites.sqlite'), ['step.example'], new Set([root]));
  const read = () => new Set(readFileSync(file, 'utf8').trim().split(/\s+/));
  const externalEdit = (content) => {
    const child = spawnSync(process.execPath, [
      '-e',
      'require("fs").writeFileSync(process.argv[1], process.argv[2])',
      file,
      content,
    ]);
    assert.equal(child.status, 0, String(child.stderr));
  };
  try {
    run({ store, read, externalEdit });
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test('external operator removal cannot be followed by dispatch', () =>
  fixture(({ store, read, externalEdit }) => {
    const authenticated = store.invited(read()).has(alice);
    assert.equal(authenticated, true);
    let sent = false;
    store.dispatch(alice, () => {
      externalEdit(`${root}\n`); // a separate process completes removal while SQLite writer lock is held
      assert.equal(read().has(alice), false);
      sent = true; // synchronous side effect follows completed removal
    });
    assert.equal(sent, false, 'dispatch ran after operator revocation');
  }));

test('removed operator admin cannot change managed invitations using stale file snapshot', () =>
  fixture(({ store, read, externalEdit }) => {
    const snapshot = read();
    externalEdit(`${alice}\n`);
    assert.equal(read().has(root), false);
    store.change(root, alice, false, snapshot);
    assert.equal(store.invited(read()).has(alice), true, 'removed admin changed managed invitation');
  }));
