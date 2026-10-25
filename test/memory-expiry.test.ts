import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dispatch } from '../supabase/functions/_shared/api.ts';
import type { Actor } from '../supabase/functions/_shared/runtime.ts';
import type { Memory } from '../packages/harness-core/src/contracts.ts';
import { selectMemories } from '../packages/harness-core/src/index.ts';

function fixture(expires_at: string | null) {
  const memory: Memory = {
    id: crypto.randomUUID(),
    tenant_id: crypto.randomUUID(),
    owner_id: crypto.randomUUID(),
    workspace_id: null,
    visibility: 'private',
    kind: 'preference',
    title: 'Synthetic examples',
    body: 'Prefer concise examples',
    confirmed: true,
    expires_at,
    origin: 'manual',
    created_at: new Date().toISOString(),
  };
  const filters: [string, unknown][] = [];
  let patch: Record<string, unknown> = {};
  let active = true;
  const query = {
    select() {
      return query;
    },
    eq(name: string, value: unknown) {
      filters.push([name, value]);
      return query;
    },
    update(value: Record<string, unknown>) {
      patch = value;
      return query;
    },
    async maybeSingle() {
      return { data: active ? { role: 'member', active } : null, error: null };
    },
    async single() {
      return { data: { ...memory, ...patch }, error: null };
    },
  };
  const actor = { user: { id: memory.owner_id }, userDb: { from: () => query } } as unknown as Actor;
  return {
    memory,
    filters,
    deactivate() {
      active = false;
    },
    save: (extra: Record<string, unknown> = {}) =>
      dispatch(
        actor,
        'memory.save',
        {
          tenant: memory.tenant_id,
          workspace: null,
          visibility: 'private',
          id: memory.id,
          title: 'Renamed synthetic examples',
          body: memory.body,
          kind: 'project',
          ...extra,
        },
        () => undefined,
      ) as Promise<Memory>,
  };
}

test('editing expired, partly elapsed and permanent memories leaves the exact expiry unchanged', async () => {
  for (const expiry of ['2020-01-01T03:04:05.678Z', new Date(Date.now() + 123456).toISOString(), null]) {
    const f = fixture(expiry);
    const saved = await f.save();
    assert.equal(saved.expires_at, expiry);
    assert.equal(saved.kind, 'project');
    assert.ok(f.filters.some(([key, value]) => key === 'owner_id' && value === f.memory.owner_id));
    assert.equal(
      selectMemories([saved], 'concise examples', 'private').length,
      expiry?.startsWith('2020') ? 0 : 1,
    );
  }
});

test('explicit lifetime changes renew a finite TTL or deliberately remove the expiry', async () => {
  const f = fixture('2020-01-01T00:00:00.000Z');
  assert.equal((await f.save({ ttlDays: 0 })).expires_at, null);
  const before = Date.now();
  const saved = await f.save({ ttlDays: 2 });
  assert.ok(Date.parse(saved.expires_at!) >= before + 2 * 86400000);
  assert.ok(Date.parse(saved.expires_at!) <= Date.now() + 2 * 86400000);
  for (const ttlDays of [-1, 0.5, 3651, null]) await assert.rejects(f.save({ ttlDays }));
  f.deactivate();
  await assert.rejects(f.save(), /ACCESS_DENIED/);
});
