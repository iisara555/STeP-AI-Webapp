import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { database, seed, ids, asUser } from './setup.ts';
let db: Awaited<ReturnType<typeof database>>;
before(async () => {
  db = await database();
  await seed(db);
});
after(async () => {
  await db.close();
});
async function reserve(user = ids.admin, tenant = ids.tenant, request = crypto.randomUUID()) {
  return asUser(
    db,
    user,
    () => db.query('select public.reserve_openrouter_trial($1,$2,$3)', [tenant, user, request]),
    'service_role',
  );
}
test('trial reservations are service-only even for an organization owner', async () => {
  for (const user of [ids.alice, ids.admin, ids.outsider])
    await asUser(db, user, async () => {
      await assert.rejects(
        db.query('select public.reserve_openrouter_trial($1,$2,$3)', [
          ids.tenant,
          ids.admin,
          crypto.randomUUID(),
        ]),
        /permission denied/,
      );
      await assert.rejects(db.query('select * from private.openrouter_trial_requests'), /permission denied/);
    });
  await asUser(
    db,
    ids.alice,
    async () => {
      await assert.rejects(
        db.query('select public.reserve_openrouter_trial($1,$2,$3)', [
          ids.tenant,
          ids.admin,
          crypto.randomUUID(),
        ]),
        /permission denied/,
      );
    },
    'anon',
  );
  for (const user of [ids.alice, ids.bob, ids.outsider]) await assert.rejects(reserve(user), /ACCESS_DENIED/);
});
test('trial reservations enforce idempotency, shared per-minute quotas and membership revocation', async () => {
  const request = crypto.randomUUID();
  await reserve(ids.admin, ids.tenant, request);
  await assert.rejects(reserve(ids.admin, ids.tenant, request), /REQUEST_CONFLICT/);
  for (let i = 0; i < 4; i++) await reserve();
  await assert.rejects(reserve(), /OPENROUTER_RATE_LIMIT/);
  assert.equal((await db.query('select * from private.openrouter_trial_requests')).rows.length, 5);
  await reserve(ids.outsider, ids.otherTenant);
  await db.query('update public.tenant_members set active=false where user_id=$1', [ids.outsider]);
  await assert.rejects(reserve(ids.outsider, ids.otherTenant), /ACCESS_DENIED/);
});
test('daily quotas persist across minutes without depending on a paid AI budget', async () => {
  await db.exec('delete from private.openrouter_trial_requests');
  await db.query(
    `insert into private.openrouter_trial_requests(request_id,tenant_id,user_id,created_at)
    select gen_random_uuid(),$1,$2,date_trunc('day',now() at time zone 'UTC') at time zone 'UTC'
    from generate_series(1,40)`,
    [ids.tenant, ids.admin],
  );
  await assert.rejects(reserve(), /OPENROUTER_RATE_LIMIT/);
  await db.exec("update private.openrouter_trial_requests set created_at=now()-interval '2 days'");
  await reserve();
  const rows = await db.query<{ monthly_ai_budget_cents: number }>(
    'select monthly_ai_budget_cents from public.tenants where id=$1',
    [ids.tenant],
  );
  assert.equal(rows.rows[0].monthly_ai_budget_cents, 0);
});
