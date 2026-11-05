import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InvitationStore } from '../src/gateway/invitation-store.ts';

test('a rejected asynchronous credential validator is observed and does not change invitations', async () => {
  const actor = 'root@step.example';
  const target = 'alice@step.example';
  const base = new Set([actor, target]);
  const store = new InvitationStore(':memory:', ['step.example'], new Set([actor]));
  try {
    assert.throws(
      () =>
        store.change(actor, target, false, base, async () => {
          throw new Error('invalid credential');
        }),
      /CREDENTIAL_VALIDATION_NOT_SYNCHRONOUS/,
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(store.invited(base).has(target), true);
    store.change(actor, target, false, base);
    assert.equal(store.invited(base).has(target), false);
  } finally {
    store.close();
  }
});

for (const active of [false, true]) {
  test(`asynchronous credential validation cannot ${active ? 'grant' : 'revoke'} an invitation`, async () => {
    const actor = 'root@step.example';
    const target = 'alice@step.example';
    const base = new Set([actor, target]);
    const store = new InvitationStore(':memory:', ['step.example'], new Set([actor]));
    try {
      if (active) store.change(actor, target, false, base);
      let complete!: () => void;
      const pending = new Promise<void>((resolve) => {
        complete = resolve;
      });
      assert.throws(
        () =>
          store.change(actor, target, active, base, async () => {
            await pending;
          }),
        /CREDENTIAL_VALIDATION_NOT_SYNCHRONOUS/,
      );
      assert.equal(store.invited(base).has(target), !active);
      complete();
      await pending;
      store.change(actor, target, active, base);
      assert.equal(store.invited(base).has(target), active);
    } finally {
      store.close();
    }
  });
}
