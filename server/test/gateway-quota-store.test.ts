import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QuotaStore } from '../src/gateway/quota-store.ts';

test('quota reservations survive reopening and concurrent connections cannot exceed the limit', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'step-quota-'));
  try {
    const path = join(dir, 'quota.sqlite');
    const a = new QuotaStore(path);
    const b = new QuotaStore(path);
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        Promise.resolve().then(() => (i % 2 ? a : b).reserve('g123', '2026-11-04', 3)),
      ),
    );
    assert.equal(results.filter(Boolean).length, 3);
    a.close();
    b.close();
    const reopened = new QuotaStore(path);
    assert.equal(reopened.reserve('g123', '2026-11-04', 3), false);
    assert.equal(reopened.reserve('g123', '2026-11-05', 3), true);
    assert.equal(reopened.reserve('g456', '2026-11-04', 3), true);
    reopened.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
