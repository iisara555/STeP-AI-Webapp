import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { readFile, readdir } from 'node:fs/promises';
export async function database() {
  const db = new PGlite({ extensions: { vector, pgcrypto } });
  await db.exec(`
 create schema auth; create schema storage; create schema extensions; create schema vault;
 -- Synthetic Vault stand-in: exercise SQL allowlists/ACLs without real secrets or encryption.
 create table vault.decrypted_secrets(name text primary key, decrypted_secret text);
 create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
 alter default privileges in schema public grant execute on functions to anon,authenticated,service_role;
 create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,raw_user_meta_data jsonb default '{}');
 create table auth.identities(id uuid primary key default gen_random_uuid(),user_id uuid references auth.users(id),provider text,identity_data jsonb);
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 grant usage on schema auth,storage to anon,authenticated,service_role;
 grant execute on function auth.uid() to anon,authenticated,service_role;
 create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
 create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text,metadata jsonb,unique(bucket_id,name));
 alter table storage.objects enable row level security;
 grant select,insert,update,delete on storage.objects to authenticated,service_role;
 `);
  for (const name of (await readdir('supabase/migrations'))
    .sort()
    .filter((n) => n.endsWith('.sql') && !n.includes('job_scheduler')))
    await db.exec(await readFile('supabase/migrations/' + name, 'utf8'));
  return db;
}
export const ids = {
  tenant: '10000000-0000-4000-8000-000000000001',
  otherTenant: '10000000-0000-4000-8000-000000000002',
  alice: '20000000-0000-4000-8000-000000000001',
  bob: '20000000-0000-4000-8000-000000000002',
  admin: '20000000-0000-4000-8000-000000000003',
  outsider: '20000000-0000-4000-8000-000000000004',
  workspace: '30000000-0000-4000-8000-000000000001',
  otherWorkspace: '30000000-0000-4000-8000-000000000002',
};
export async function seed(db: PGlite) {
  await db.exec(`insert into auth.users(id,email,email_confirmed_at)values('${ids.alice}','alice@example.test',now()),('${ids.bob}','bob@example.test',now()),('${ids.admin}','admin@example.test',now()),('${ids.outsider}','outsider@example.test',now());
 insert into auth.identities(user_id,provider,identity_data)select id,'google',jsonb_build_object('email',email,'email_verified',true,'sub',id::text)from auth.users;
 insert into public.tenants(id,name)values('${ids.tenant}','Synthetic STeP'),('${ids.otherTenant}','Synthetic Other');
 insert into public.tenant_members(tenant_id,user_id,role,email)values('${ids.tenant}','${ids.alice}','member','alice@example.test'),('${ids.tenant}','${ids.bob}','member','bob@example.test'),('${ids.tenant}','${ids.admin}','owner','admin@example.test'),('${ids.otherTenant}','${ids.outsider}','owner','outsider@example.test');
 insert into public.workspaces(id,tenant_id,created_by,name)values('${ids.workspace}','${ids.tenant}','${ids.alice}','Private project'),('${ids.otherWorkspace}','${ids.otherTenant}','${ids.outsider}','Other project');`);
}
export async function asUser<T>(db: PGlite, id: string, fn: () => Promise<T>, role = 'authenticated') {
  await db.exec(`set role ${role}; select set_config('request.jwt.claim.sub','${id}',false);`);
  try {
    return await fn();
  } finally {
    await db.exec("reset role;select set_config('request.jwt.claim.sub','',false)");
  }
}
