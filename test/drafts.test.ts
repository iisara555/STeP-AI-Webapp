import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DraftBook } from '../web/src/drafts.ts';
import type { Conversation } from '../packages/harness-core/src/contracts.ts';

const tenant = crypto.randomUUID();
function session(draft = 'saved A', version = 1): Conversation {
  return {
    id: crypto.randomUUID(),
    tenant_id: tenant,
    owner_id: crypto.randomUUID(),
    workspace_id: null,
    visibility: 'private',
    title: 'Synthetic task',
    draft,
    version,
    created_at: new Date().toISOString(),
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

test('drafts remain separate across tasks and a delayed read cannot replace local text', () => {
  const drafts = new DraftBook(tenant),
    a = session(),
    b = session('saved B');
  drafts.edit(a, 'unsaved A');
  drafts.edit(b, 'unsaved B');
  drafts.receive({ ...a, draft: 'older remote A', version: 2 });
  assert.equal(drafts.get(a).text, 'unsaved A');
  assert.equal(drafts.get(a).version, 1); // The later save must detect a concurrent server edit.
  assert.equal(drafts.get(b).text, 'unsaved B');
  assert.equal(drafts.hasUnsaved(), true);
});

test('late save acknowledgements retain subsequent edits and cannot regress to stale reads', async () => {
  const drafts = new DraftBook(tenant),
    a = session(),
    b = session('saved B');
  drafts.edit(a, 'first edit');
  const response = deferred<Conversation>();
  const saving = drafts.save(a, async (input) => {
    assert.equal(input.version, 1);
    assert.equal(input.draft, 'first edit');
    return response.promise;
  });
  drafts.edit(a, 'second edit while saving');
  drafts.edit(b, 'unchanged B');
  let duplicates = 0;
  await drafts.save(a, async () => {
    duplicates++;
    return a;
  });
  assert.equal(duplicates, 0);
  response.resolve({ ...a, draft: 'first edit', version: 2 });
  await saving;
  drafts.receive(a);
  assert.deepEqual(drafts.get(a), {
    text: 'second edit while saving',
    savedText: 'first edit',
    version: 2,
    saving: false,
  });
  assert.equal(drafts.get(b).text, 'unchanged B');
  await drafts.save(a, async (input) => {
    assert.equal(input.version, 2);
    return { ...a, draft: input.draft, version: 3 };
  });
  drafts.receive({ ...a, draft: 'stale read', version: 2 });
  assert.equal(drafts.get(a).text, 'second edit while saving');
  assert.equal(drafts.get(a).savedText, 'second edit while saving');
  assert.equal(drafts.get(a).version, 3);
});

test('failed saves preserve dirty text and new account/tenant scopes cannot revive old drafts', async () => {
  const drafts = new DraftBook(tenant),
    a = session();
  drafts.edit(a, 'keep after conflict');
  await assert.rejects(
    drafts.save(a, async () => {
      throw new Error('VERSION_CONFLICT');
    }),
    /VERSION_CONFLICT/,
  );
  assert.equal(drafts.get(a).text, 'keep after conflict');
  assert.equal(drafts.get(a).saving, false);
  const response = deferred<Conversation>();
  const saving = drafts.save(a, () => response.promise);
  drafts.clear();
  response.resolve({ ...a, draft: 'keep after conflict', version: 2 });
  assert.equal(await saving, undefined);
  assert.equal(drafts.hasUnsaved(), false);
  assert.equal(drafts.get(a).text, 'saved A');
  const foreign = new DraftBook(crypto.randomUUID());
  foreign.edit(a, 'wrong tenant');
  foreign.receive(a);
  assert.equal(foreign.hasUnsaved(), false);
});

test('deleting a task during save does not resurrect its cached private text', async () => {
  const drafts = new DraftBook(tenant),
    a = session();
  drafts.edit(a, 'delete this');
  const response = deferred<Conversation>();
  const saving = drafts.save(a, () => response.promise);
  drafts.forget(a.id);
  response.resolve({ ...a, draft: 'delete this', version: 2 });
  assert.equal(await saving, undefined);
  assert.equal(drafts.hasUnsaved(), false);
});
