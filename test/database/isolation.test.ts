import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { database, seed, ids, asUser } from './setup.ts';
let db: Awaited<ReturnType<typeof database>>;
before(async () => {
  db = await database();
  await seed(db);
});
after(async () => {
  await db?.close();
});
test('SQL migrations compile in real Postgres with pgvector', async () => {
  const result = await db.query<{ n: number }>(
    "select count(*)::integer n from pg_policies where schemaname='public'",
  );
  assert.ok(result.rows[0].n >= 20);
});
test('tenant admin and another employee cannot see private workspace or memory', async () => {
  await asUser(db, ids.alice, async () => {
    await db.query(
      `insert into public.memories(tenant_id,owner_id,title,body,confirmed)values($1,$2,'ความชอบ','ชอบคำตอบสั้น',true)`,
      [ids.tenant, ids.alice],
    );
    assert.equal((await db.query('select * from public.workspaces')).rows.length, 1);
  });
  for (const who of [ids.bob, ids.admin, ids.outsider])
    await asUser(db, who, async () => {
      assert.equal((await db.query('select * from public.memories')).rows.length, 0);
      assert.equal(
        (await db.query('select * from public.workspaces where id=$1', [ids.workspace])).rows.length,
        0,
      );
    });
});
test('sharing a workspace does not share personal memory; viewer cannot write', async () => {
  await asUser(db, ids.alice, async () => {
    await db.query('select public.add_workspace_member($1,$2,$3,$4)', [
      ids.tenant,
      ids.workspace,
      'bob@example.test',
      'viewer',
    ]);
  });
  await asUser(db, ids.bob, async () => {
    assert.equal(
      (await db.query('select * from public.workspaces where id=$1', [ids.workspace])).rows.length,
      1,
    );
    assert.equal((await db.query('select * from public.memories')).rows.length, 0);
    await assert.rejects(
      db.query(
        `insert into public.sessions(tenant_id,owner_id,workspace_id,visibility)values($1,$2,$3,'workspace')`,
        [ids.tenant, ids.bob, ids.workspace],
      ),
      /row-level security/,
    );
  });
});
test('client cannot forge ownership, tenant membership or private OAuth access', async () => {
  await asUser(db, ids.bob, async () => {
    await assert.rejects(
      db.query(`insert into public.memories(tenant_id,owner_id,title,body)values($1,$2,'x','y')`, [
        ids.tenant,
        ids.alice,
      ]),
      /row-level security/,
    );
    await assert.rejects(
      db.query(`insert into public.tenant_members(tenant_id,user_id,role)values($1,$2,'owner')`, [
        ids.otherTenant,
        ids.bob,
      ]),
      /permission denied/,
    );
    await assert.rejects(
      db.query('select public.read_google_grant($1,$2)', [ids.tenant, ids.alice]),
      /permission denied/,
    );
    await assert.rejects(db.query('select public.claim_run()'), /permission denied/);
  });
});
test('private document and Storage paths use the same ACL', async () => {
  const doc = await asUser(db, ids.alice, async () => {
    const row = (
      await db.query<{ id: string; object_path: string }>(
        `select * from public.create_document($1,null,'private','sample.txt','text/plain',10)`,
        [ids.tenant],
      )
    ).rows[0];
    await db.query(`insert into storage.objects(bucket_id,name)values('documents',$1)`, [row.object_path]);
    return row;
  });
  await db.query(`update public.documents set status='ready' where id=$1`, [doc.id]);
  for (const who of [ids.bob, ids.admin, ids.outsider])
    await asUser(db, who, async () => {
      assert.equal((await db.query('select * from public.documents where id=$1', [doc.id])).rows.length, 0);
      assert.equal(
        (await db.query('select * from storage.objects where name=$1', [doc.object_path])).rows.length,
        0,
      );
      await assert.rejects(
        db.query(`insert into storage.objects(bucket_id,name)values('documents',$1)`, [
          doc.object_path + '/forged',
        ]),
        /row-level security/,
      );
    });
});
test('Drive references cannot be promoted to shared documents', async () => {
  await assert.rejects(
    db.query(
      `insert into public.documents(tenant_id,owner_id,workspace_id,visibility,name,mime,bytes,source_kind,drive_file_id,status)values($1,$2,$3,'workspace','drive','text/plain',0,'drive','abc','ready')`,
      [ids.tenant, ids.alice, ids.workspace],
    ),
    /check constraint/,
  );
});
test('quota reservation and AI budgets fail closed', async () => {
  await asUser(db, ids.alice, async () => {
    await assert.rejects(
      db.query(`select public.create_document($1,null,'private','large.txt','text/plain',10485761)`, [
        ids.tenant,
      ]),
      /ACCESS_DENIED/,
    );
    const session = (
      await db.query<{ id: string }>(
        `insert into public.sessions(tenant_id,owner_id)values($1,$2)returning id`,
        [ids.tenant, ids.alice],
      )
    ).rows[0].id;
    await assert.rejects(
      db.query(`select public.start_run($1,$2,null,'chat',gen_random_uuid(),$3::jsonb)`, [
        ids.tenant,
        session,
        JSON.stringify({ message: 'hi', consent: true }),
      ]),
      /AI_NOT_CONFIGURED/,
    );
  });
});
