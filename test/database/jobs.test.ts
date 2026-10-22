import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { database, seed, ids, asUser } from './setup.ts';
let db: Awaited<ReturnType<typeof database>>;
before(async () => {
  db = await database();
  await seed(db);
});
after(async () => {
  await db?.close();
});
async function session(visibility = 'private', workspace: string | null = null) {
  return asUser(
    db,
    ids.alice,
    async () =>
      (
        await db.query<{ id: string }>(
          `insert into public.sessions(tenant_id,owner_id,visibility,workspace_id)values($1,$2,$3,$4)returning id`,
          [ids.tenant, ids.alice, visibility, workspace],
        )
      ).rows[0].id,
  );
}
async function start(
  s: string,
  request = randomUUID(),
  payload: object = { message: 'synthetic', consent: true },
) {
  return asUser(
    db,
    ids.alice,
    async () =>
      (
        await db.query<{ id: string; reserved_cents: number }>(
          `select * from public.start_run($1,$2,null,'chat',$3,$4::jsonb)`,
          [ids.tenant, s, request, JSON.stringify(payload)],
        )
      ).rows[0],
  );
}
async function claim() {
  return asUser(
    db,
    ids.admin,
    async () =>
      (await db.query<{ id: string; lease_token: string }>('select * from public.claim_run()')).rows[0],
    'service_role',
  );
}
async function finish(id: string, lease: string) {
  return asUser(
    db,
    ids.admin,
    async () =>
      (
        await db.query<{ ok: boolean }>(
          `select public.finish_run($1,$2,'{"text":"synthetic answer"}',null,1000,500)ok`,
          [id, lease],
        )
      ).rows[0].ok,
    'service_role',
  );
}
test('idempotency, leases and pricing snapshots prevent duplicate billing and responses', async () => {
  await asUser(db, ids.admin, () => db.query('select public.configure_ai($1,500,100,500)', [ids.tenant]));
  const s = await session(),
    request = randomUUID(),
    run = await start(s, request);
  assert.equal((await start(s, request)).id, run.id);
  await assert.rejects(start(s, request, { message: 'different', consent: true }), /REQUEST_CONFLICT/);
  await assert.rejects(start(s), /RUN_ACTIVE/);
  const job = await claim();
  assert.equal(job.id, run.id);
  assert.equal(await finish(job.id, randomUUID()), false);
  await asUser(db, ids.admin, () => db.query('select public.configure_ai($1,500,10000,10000)', [ids.tenant]));
  assert.equal(await finish(job.id, job.lease_token), true);
  assert.equal(await finish(job.id, job.lease_token), false);
  const rows = await db.query<{ role: string }>('select role from public.messages where session_id=$1', [s]);
  assert.deepEqual(
    rows.rows.map((x) => x.role),
    ['user', 'assistant'],
  );
  assert.equal(
    (
      await db.query<{ reserved_cents: number }>('select reserved_cents from public.runs where id=$1', [
        run.id,
      ])
    ).rows[0].reserved_cents,
    1,
  );
});
test('cancelled or expired provider calls never replay automatically', async () => {
  await asUser(db, ids.admin, () => db.query('select public.configure_ai($1,500,100,500)', [ids.tenant]));
  const s = await session(),
    run = await start(s);
  await asUser(db, ids.alice, () => db.query('select public.cancel_run($1,$2)', [ids.tenant, run.id]));
  assert.equal((await claim()).id, null);
  const next = await start(s),
    job = await claim();
  assert.equal(job.id, next.id);
  await db.query("update public.runs set lease_until=now()-interval '1 second' where id=$1", [job.id]);
  assert.equal((await claim()).id, null);
  assert.equal(await finish(job.id, job.lease_token), false);
  const row = (
    await db.query<{ status: string; attempts: number; reserved_cents: number }>(
      'select status,attempts,reserved_cents from public.runs where id=$1',
      [job.id],
    )
  ).rows[0];
  assert.equal(row.status, 'interrupted');
  assert.equal(row.attempts, 1);
  assert.ok(row.reserved_cents > 0);
});
test('revoked membership prevents committing a running answer', async () => {
  const run = await start(await session()),
    job = await claim();
  assert.equal(job.id, run.id);
  await db.query('update public.tenant_members set active=false where tenant_id=$1 and user_id=$2', [
    ids.tenant,
    ids.alice,
  ]);
  assert.equal(await finish(job.id, job.lease_token), false);
  assert.equal(
    (await db.query<{ status: string }>('select status from public.runs where id=$1', [job.id])).rows[0]
      .status,
    'cancelled',
  );
  await db.query('update public.tenant_members set active=true where tenant_id=$1 and user_id=$2', [
    ids.tenant,
    ids.alice,
  ]);
});
test('shared conversations cannot use a document from a different workspace owned by the actor', async () => {
  const other = (
    await db.query<{ id: string }>(
      `insert into public.workspaces(tenant_id,created_by,name)values($1,$2,'second')returning id`,
      [ids.tenant, ids.alice],
    )
  ).rows[0].id;
  const doc = (
    await asUser(db, ids.alice, () =>
      db.query<{ id: string }>(
        `select * from public.create_document($1,$2,'workspace','other.txt','text/plain',10)`,
        [ids.tenant, other],
      ),
    )
  ).rows[0].id;
  await db.query("update public.documents set status='ready' where id=$1", [doc]);
  const run = await start(await session('workspace', ids.workspace), randomUUID(), {
    message: 'synthetic',
    consent: true,
    documentIds: [doc],
  });
  const job = await claim();
  assert.equal(job.id, run.id);
  await assert.rejects(
    asUser(
      db,
      ids.admin,
      () => db.query('select public.worker_payload($1,$2)', [job.id, job.lease_token]),
      'service_role',
    ),
    /ACCESS_DENIED/,
  );
  await asUser(db, ids.alice, () => db.query('select public.cancel_run($1,$2)', [ids.tenant, job.id]));
});
test('draft conflicts preserve the newer revision and direct updates are denied', async () => {
  const s = await session();
  await asUser(db, ids.alice, async () => {
    await db.query('select public.save_draft($1,$2,1,$3)', [ids.tenant, s, 'first']);
    await assert.rejects(
      db.query('select public.save_draft($1,$2,1,$3)', [ids.tenant, s, 'stale']),
      /VERSION_CONFLICT/,
    );
    await assert.rejects(
      db.query("update public.sessions set draft='bypass' where id=$1", [s]),
      /permission denied/,
    );
    assert.equal(
      (await db.query<{ draft: string }>('select draft from public.sessions where id=$1', [s])).rows[0].draft,
      'first',
    );
  });
});
test('owner reservation requires a verified Google identity; clients cannot bootstrap', async () => {
  const t = (
    await db.query<{ t: string }>("select public.bootstrap_tenant('Synthetic Bootstrap','new@example.test')t")
  ).rows[0].t;
  const u = randomUUID();
  await db.query('insert into auth.users(id,email,email_confirmed_at)values($1,$2,now())', [
    u,
    'new@example.test',
  ]);
  await db.query("insert into auth.identities(user_id,provider,identity_data)values($1,'google',$2)", [
    u,
    JSON.stringify({ email: 'new@example.test', email_verified: false }),
  ]);
  await asUser(db, u, async () => {
    await assert.rejects(db.query('select public.accept_invites()'), /GOOGLE_IDENTITY_REQUIRED/);
    await assert.rejects(
      db.query("select public.bootstrap_tenant('Forged','x@example.test')"),
      /permission denied/,
    );
    await assert.rejects(db.query('select * from private.owner_invites'), /permission denied/);
  });
  await db.query(
    "update auth.identities set identity_data=jsonb_set(identity_data,'{email_verified}','true')where user_id=$1",
    [u],
  );
  await asUser(db, u, async () => {
    assert.equal((await db.query<{ n: number }>('select public.accept_invites()n')).rows[0].n, 1);
    assert.equal(
      (await db.query<{ role: string }>('select role from public.tenant_members where tenant_id=$1', [t]))
        .rows[0].role,
      'owner',
    );
    assert.equal((await db.query<{ n: number }>('select public.accept_invites()n')).rows[0].n, 0);
  });
});
test('service RPCs are inaccessible to public, anonymous and authenticated clients', async () => {
  for (const role of ['anon', 'authenticated'])
    await asUser(
      db,
      ids.alice,
      async () => {
        for (const name of [
          'claim_run()',
          'bootstrap_tenant(text,text)',
          'import_harness_pack(uuid,jsonb)',
          'worker_payload(uuid,uuid)',
          'read_google_grant(uuid,uuid)',
        ]) {
          const result = await db.query<{ ok: boolean }>(
            "select has_function_privilege(current_user,$1,'EXECUTE')ok",
            ['public.' + name],
          );
          assert.equal(result.rows[0].ok, false, role + ':' + name);
        }
      },
      role,
    );
});
test('global worker concurrency remains capped at two across employee jobs', async () => {
  const jobs = [];
  for (const who of [ids.alice, ids.bob, ids.admin])
    jobs.push(
      await asUser(db, who, async () => {
        const s = (
          await db.query<{ id: string }>(
            `insert into public.sessions(tenant_id,owner_id)values($1,$2)returning id`,
            [ids.tenant, who],
          )
        ).rows[0].id;
        return (
          await db.query<{ id: string }>(
            `select * from public.start_run($1,$2,null,'chat',gen_random_uuid(),'{"message":"synthetic","consent":true}')`,
            [ids.tenant, s],
          )
        ).rows[0].id;
      }),
    );
  const one = await claim(),
    two = await claim();
  assert.ok(one.id);
  assert.ok(two.id);
  assert.notEqual(one.id, two.id);
  assert.equal((await claim()).id, null);
  assert.equal(await finish(one.id, one.lease_token), true);
  const three = await claim();
  assert.ok(jobs.includes(three.id));
  assert.equal(await finish(two.id, two.lease_token), true);
  assert.equal(await finish(three.id, three.lease_token), true);
});
test('receipt reviews require a completed owned run and confirmed source; admins cannot read them', async () => {
  const doc = (
    await asUser(db, ids.alice, () =>
      db.query<{ id: string }>(
        `select * from public.create_document($1,null,'private','receipt.png','image/png',10)`,
        [ids.tenant],
      ),
    )
  ).rows[0].id;
  await db.query("update public.documents set status='ready' where id=$1", [doc]);
  const run = (
    await asUser(db, ids.alice, () =>
      db.query<{ id: string }>(
        `select * from public.start_run($1,null,$2,'receipt',gen_random_uuid(),'{"consent":true}')`,
        [ids.tenant, doc],
      ),
    )
  ).rows[0].id;
  const job = await claim();
  assert.equal(job.id, run);
  assert.equal(await finish(job.id, job.lease_token), true);
  await asUser(db, ids.alice, async () => {
    await assert.rejects(
      db.query("select public.save_receipt_review($1,$2,$3,'{}',false)", [ids.tenant, run, doc]),
      /ACCESS_DENIED/,
    );
    await db.query(`select public.save_receipt_review($1,$2,$3,'{"synthetic":"reviewed"}',true)`, [
      ids.tenant,
      run,
      doc,
    ]);
    assert.equal((await db.query('select * from public.receipt_reviews')).rows.length, 1);
  });
  for (const who of [ids.admin, ids.bob, ids.outsider])
    await asUser(db, who, async () => {
      assert.equal((await db.query('select * from public.receipt_reviews')).rows.length, 0);
    });
});
test('deleting content erases prompts/results while retaining billed reservations', async () => {
  const s = await session(),
    run = await start(s),
    job = await claim();
  assert.equal(run.id, job.id);
  await asUser(db, ids.alice, () => db.query('delete from public.sessions where id=$1', [s]));
  assert.equal(await finish(job.id, job.lease_token), false);
  const row = (
    await db.query<{
      purged: boolean;
      input: object;
      result: unknown;
      reserved_cents: number;
      status: string;
    }>('select purged,input,result,reserved_cents,status from public.runs where id=$1', [job.id])
  ).rows[0];
  assert.equal(row.purged, true);
  assert.deepEqual(row.input, {});
  assert.equal(row.result, null);
  assert.equal(row.status, 'cancelled');
  assert.ok(row.reserved_cents > 0);
  await asUser(db, ids.alice, async () => {
    assert.equal((await db.query('select * from public.runs where id=$1', [job.id])).rows.length, 0);
  });
});
test('Data API cannot bypass pending uploads or orphan a workspace storage tree', async () => {
  await asUser(db, ids.alice, async () => {
    const doc = (
      await db.query<{ id: string }>(
        `select * from public.create_document($1,null,'private','pending.txt','text/plain',1)`,
        [ids.tenant],
      )
    ).rows[0].id;
    await assert.rejects(
      db.query('update public.documents set deleted_at=now()where id=$1', [doc]),
      /permission denied/,
    );
    await assert.rejects(
      db.query('delete from public.workspaces where id=$1', [ids.workspace]),
      /permission denied/,
    );
  });
});
