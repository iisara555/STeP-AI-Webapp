import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { database, seed, ids, asUser } from './setup.ts';
let db: Awaited<ReturnType<typeof database>>;
const session = '30000000-0000-4000-8000-000000000010';
before(async () => {
  db = await database();
  await seed(db);
  await db.query('insert into public.sessions(id,tenant_id,owner_id)values($1,$2,$3)', [
    session,
    ids.tenant,
    ids.admin,
  ]);
});
beforeEach(async () => {
  await db.exec(
    'delete from private.openrouter_trial_requests; delete from public.runs; update public.tenants set free_ai_trial_enabled=false,free_ai_daily_limit=50',
  );
});
after(async () => {
  await db?.close();
});
const configure = (enabled: boolean, user = ids.admin) =>
  asUser(db, user, () => db.query('select public.configure_free_trial($1,$2,50)', [ids.tenant, enabled]));
const start = () =>
  asUser(
    db,
    ids.admin,
    async () =>
      (
        await db.query<{ id: string; reserved_cents: number }>(
          "select * from public.start_run($1,$2,null,'chat',$3,$4::jsonb)",
          [
            ids.tenant,
            session,
            crypto.randomUUID(),
            JSON.stringify({
              message: 'synthetic',
              consent: true,
              aiProvider: 'openrouter_free',
              providerConsent: 'synthetic-consent',
            }),
          ],
        )
      ).rows[0],
  );
const reserve = () =>
  asUser(
    db,
    ids.admin,
    () =>
      db.query('select public.reserve_openrouter_trial($1,$2,$3)', [
        ids.tenant,
        ids.admin,
        crypto.randomUUID(),
      ]),
    'service_role',
  );
async function accountingRows(count: number) {
  // Purged rows retain only accounting metadata, just as resource deletion does.
  await db.query(
    `insert into public.runs(tenant_id,actor_id,kind,request_id,ai_provider,status,purged,input_rate,output_rate)
    select $1,$2,'chat',gen_random_uuid(),'openrouter_free','failed',true,0,0 from generate_series(1,$3)`,
    [ids.tenant, ids.admin, count],
  );
}
async function sandboxRows(count: number, tenant = ids.tenant, user = ids.admin) {
  await db.query(
    `insert into private.openrouter_trial_requests(request_id,tenant_id,user_id)
    select gen_random_uuid(),$1,$2 from generate_series(1,$3)`,
    [tenant, user, count],
  );
}
test('Vault RPC exposes only its allowlist to service_role; clients and owners cannot read it', async () => {
  await db.exec(`insert into vault.decrypted_secrets(name,decrypted_secret)values
    ('step_openrouter_api_key','synthetic-key'),('step_openrouter_trial_tenant_id','synthetic-tenant'),
    ('unrelated_secret','must-not-return')`);
  for (const role of ['anon', 'authenticated'])
    await asUser(
      db,
      ids.admin,
      async () => {
        await assert.rejects(db.query('select public.read_server_runtime_config()'), /permission denied/);
        await assert.rejects(db.query('select * from vault.decrypted_secrets'), /permission denied/);
      },
      role,
    );
  await asUser(
    db,
    ids.admin,
    async () => {
      const result = await db.query<{ config: object }>(
        'select public.read_server_runtime_config() as config',
      );
      assert.deepEqual(result.rows[0].config, {
        OPENROUTER_API_KEY: 'synthetic-key',
        OPENROUTER_TRIAL_TENANT_ID: 'synthetic-tenant',
      });
    },
    'service_role',
  );
  const rls = await db.query<{ enabled: boolean }>(
    "select relrowsecurity as enabled from pg_class where oid='private.openrouter_trial_requests'::regclass",
  );
  assert.equal(rls.rows[0].enabled, true);
});
test('free worker pilot remains opt-in and admin-only without enabling a paid budget', async () => {
  await assert.rejects(configure(true, ids.alice), /ACCESS_DENIED/);
  await assert.rejects(start(), /AI_NOT_CONFIGURED/);
  await configure(true);
  const job = await start();
  assert.equal(job.reserved_cents, 0);
  await asUser(db, ids.alice, async () => {
    const own = (
      await db.query<{ id: string }>(
        'insert into public.sessions(tenant_id,owner_id)values($1,$2)returning id',
        [ids.tenant, ids.alice],
      )
    ).rows[0].id;
    await assert.rejects(
      db.query("select public.start_run($1,$2,null,'chat',$3,$4::jsonb)", [
        ids.tenant,
        own,
        crypto.randomUUID(),
        JSON.stringify({ message: 'synthetic', consent: true, aiProvider: 'openrouter_free' }),
      ]),
      /ACCESS_DENIED/,
    );
  });
  assert.equal(
    (
      await db.query<{ budget: number }>(
        'select monthly_ai_budget_cents as budget from public.tenants where id=$1',
        [ids.tenant],
      )
    ).rows[0].budget,
    0,
  );
});
test('daily account quota combines both channels including failed and purged jobs', async () => {
  await configure(true);
  for (const [jobs, sandbox] of [
    [39, 1],
    [1, 39],
  ]) {
    await db.exec('delete from public.runs; delete from private.openrouter_trial_requests');
    await accountingRows(jobs);
    await sandboxRows(sandbox);
    await assert.rejects(start(), /AI_FREE_QUOTA/);
    await assert.rejects(reserve(), /OPENROUTER_RATE_LIMIT/);
  }
  await db.exec(
    "update public.runs set created_at=now()-interval '2 days'; update private.openrouter_trial_requests set created_at=now()-interval '2 days'",
  );
  await reserve();
  assert.equal((await start()).reserved_cents, 0);
});
test('per-minute account quota includes sandbox requests in other tenants', async () => {
  await configure(true);
  await accountingRows(7);
  await sandboxRows(8, ids.otherTenant, ids.outsider);
  await assert.rejects(start(), /AI_FREE_RATE_LIMIT/);
  await assert.rejects(reserve(), /OPENROUTER_RATE_LIMIT/);
});
test('disabling a free pilot revokes a running worker before context read and commit', async () => {
  await configure(true);
  await start();
  const job = await asUser(
    db,
    ids.admin,
    async () =>
      (await db.query<{ id: string; lease_token: string }>('select * from public.claim_run()')).rows[0],
    'service_role',
  );
  await configure(false);
  await asUser(
    db,
    ids.admin,
    async () => {
      await assert.rejects(
        db.query('select public.worker_payload($1,$2)', [job.id, job.lease_token]),
        /ACCESS_DENIED/,
      );
      const result = await db.query<{ ok: boolean }>(
        'select public.finish_run($1,$2,\'{"text":"synthetic"}\',null,1,1)as ok',
        [job.id, job.lease_token],
      );
      assert.equal(result.rows[0].ok, false);
    },
    'service_role',
  );
  assert.equal(
    (await db.query<{ status: string }>('select status from public.runs where id=$1', [job.id])).rows[0]
      .status,
    'cancelled',
  );
});
