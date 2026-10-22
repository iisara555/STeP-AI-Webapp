-- Tenant and resource checks are database-enforced; neither a tenant ID nor an
-- admin role grants access to an employee's private content.
create extension if not exists pgcrypto with schema extensions;
create extension if not exists vector with schema extensions;
create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to authenticated, service_role;

create table public.tenants (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(name) between 1 and 100),
  active boolean not null default true,
  storage_limit bigint not null default 800000000,
  member_storage_limit bigint not null default 25000000,
  monthly_ai_budget_cents integer not null default 0 check (monthly_ai_budget_cents >= 0),
  input_cents_per_million numeric check (input_cents_per_million > 0),
  output_cents_per_million numeric check (output_cents_per_million > 0),
  created_at timestamptz not null default now()
);
create table public.tenant_members (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('owner','admin','member')),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  primary key (tenant_id,user_id)
);
create index tenant_members_user on public.tenant_members(user_id, tenant_id) where active;
create table public.tenant_invites (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  email text not null check (email = lower(trim(email)) and length(email) between 3 and 254),
  role text not null default 'member' check (role in ('admin','member')),
  created_by uuid not null references auth.users(id),
  expires_at timestamptz not null default now() + interval '7 days',
  accepted_at timestamptz,
  unique (tenant_id,email)
);
create table public.workspaces (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  created_by uuid not null references auth.users(id),
  name text not null check (length(trim(name)) between 1 and 100),
  description text not null default '' check (length(description) <= 1000),
  created_at timestamptz not null default now(),
  unique (tenant_id,id)
);
create index workspaces_tenant on public.workspaces(tenant_id,created_by);
create table public.workspace_members (
  tenant_id uuid not null,
  workspace_id uuid not null,
  user_id uuid not null,
  role text not null check (role in ('editor','viewer')),
  primary key (workspace_id,user_id),
  foreign key (tenant_id,workspace_id) references public.workspaces(tenant_id,id) on delete cascade,
  foreign key (tenant_id,user_id) references public.tenant_members(tenant_id,user_id) on delete cascade
);
create index workspace_members_user on public.workspace_members(user_id,tenant_id,workspace_id);

create function private.is_member(t uuid) returns boolean language sql stable security definer
set search_path = '' as $$
 select exists(select 1 from public.tenant_members m join public.tenants x on x.id=m.tenant_id
 where m.tenant_id=t and m.user_id=(select auth.uid()) and m.active and x.active)
$$;
create function private.is_admin(t uuid) returns boolean language sql stable security definer
set search_path = '' as $$
 select private.is_member(t) and exists(select 1 from public.tenant_members
 where tenant_id=t and user_id=(select auth.uid()) and role in ('owner','admin'))
$$;
create function private.owns_workspace(t uuid,w uuid) returns boolean language sql stable security definer
set search_path = '' as $$
 select private.is_member(t) and exists(select 1 from public.workspaces
 where tenant_id=t and id=w and created_by=(select auth.uid()))
$$;
create function private.workspace_access(t uuid,w uuid,write_access boolean default false)
returns boolean language sql stable security definer set search_path = '' as $$
 select private.is_member(t) and (private.owns_workspace(t,w) or exists(
 select 1 from public.workspace_members m where m.tenant_id=t and m.workspace_id=w
 and m.user_id=(select auth.uid()) and (not write_access or m.role='editor')))
$$;
create function private.resource_access(t uuid,owner_id uuid,w uuid,visibility text,write_access boolean default false)
returns boolean language sql stable security invoker set search_path = '' as $$
 select private.is_member(t) and ((visibility='private' and owner_id=(select auth.uid()))
 or (visibility='workspace' and w is not null and private.workspace_access(t,w,write_access)))
$$;

create table public.memories (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null,
  owner_id uuid not null references auth.users(id), workspace_id uuid,
  visibility text not null default 'private' check (visibility in ('private','workspace')),
  title text not null check(length(title) between 1 and 120),
  body text not null check(length(body) between 1 and 4000),
  kind text not null default 'preference' check (kind in ('preference','reference','feedback')),
  confirmed boolean not null default false,
  origin text not null default 'manual' check (origin in ('manual','chat','import')),
  expires_at timestamptz, created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (tenant_id,owner_id) references public.tenant_members(tenant_id,user_id),
  foreign key (tenant_id,workspace_id) references public.workspaces(tenant_id,id) on delete cascade,
  check (visibility='private' or workspace_id is not null)
);
create index memories_owner on public.memories(tenant_id,owner_id,visibility);
create index memories_workspace on public.memories(tenant_id,workspace_id) where visibility='workspace';
create table public.documents (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null,
  owner_id uuid not null references auth.users(id), workspace_id uuid,
  visibility text not null default 'private' check (visibility in ('private','workspace')),
  name text not null check(length(name) between 1 and 200),
  mime text not null, bytes bigint not null check(bytes between 0 and 10485760),
  source_kind text not null default 'upload' check(source_kind in ('upload','drive')),
  drive_file_id text check(drive_file_id ~ '^[a-zA-Z0-9_-]{1,200}$'),
  object_path text unique,
  status text not null default 'uploading' check(status in ('uploading','ready','processing','error')),
  source_version text, extracted_text text check(length(extracted_text)<=200000),
  error_code text, created_at timestamptz not null default now(), deleted_at timestamptz,
  derived_from uuid,
  unique(tenant_id,id),
  foreign key (tenant_id,owner_id) references public.tenant_members(tenant_id,user_id),
  foreign key (tenant_id,workspace_id) references public.workspaces(tenant_id,id) on delete cascade,
  foreign key (tenant_id,derived_from) references public.documents(tenant_id,id) on delete cascade,
  check (visibility='private' or workspace_id is not null),
  -- A Drive link never becomes a shared copy of its uploader's credentials or cache.
  check(source_kind <> 'drive' or (visibility='private' and drive_file_id is not null))
);
create index documents_owner on public.documents(tenant_id,owner_id,created_at);
create index documents_workspace on public.documents(tenant_id,workspace_id) where visibility='workspace';
create table public.document_chunks (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null,
  document_id uuid not null, ordinal integer not null, content text not null check(length(content)<=8000),
  location text not null, embedding extensions.vector(768),
  foreign key(tenant_id,document_id) references public.documents(tenant_id,id) on delete cascade,
  unique(document_id,ordinal)
);
create index document_chunks_document on public.document_chunks(tenant_id,document_id);
create table public.sessions (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null,
  owner_id uuid not null references auth.users(id), workspace_id uuid,
  visibility text not null default 'private' check (visibility in ('private','workspace')),
  title text not null default 'เริ่มงานใหม่' check(length(title)<=160),
  version integer not null default 1, draft text not null default '' check(length(draft)<=200000),
  created_at timestamptz not null default now(),
  unique(tenant_id,id),
  foreign key(tenant_id,owner_id) references public.tenant_members(tenant_id,user_id),
  foreign key(tenant_id,workspace_id) references public.workspaces(tenant_id,id) on delete cascade,
  check(visibility='private' or workspace_id is not null)
);
create index sessions_owner on public.sessions(tenant_id,owner_id,created_at);
create table public.messages (
  id uuid primary key default gen_random_uuid(),tenant_id uuid not null,session_id uuid not null,
  role text not null check(role in ('user','assistant','status')),
  body text not null check(length(body)<=200000),
  sources jsonb not null default '[]',created_at timestamptz not null default now(),
  foreign key(tenant_id,session_id) references public.sessions(tenant_id,id) on delete cascade
);
create index messages_session on public.messages(tenant_id,session_id,created_at,id);
create function private.session_access(t uuid,s uuid,write_access boolean default false) returns boolean
language sql stable security definer set search_path = '' as $$
 select exists(select 1 from public.sessions x where x.tenant_id=t and x.id=s
 and private.resource_access(x.tenant_id,x.owner_id,x.workspace_id,x.visibility,write_access))
$$;
create function private.document_access(t uuid,d uuid,write_access boolean default false) returns boolean
language sql stable security definer set search_path = '' as $$
 select exists(select 1 from public.documents x where x.tenant_id=t and x.id=d and x.deleted_at is null
 and private.resource_access(x.tenant_id,x.owner_id,x.workspace_id,x.visibility,write_access))
$$;

create table public.runs (
  id uuid primary key default gen_random_uuid(),tenant_id uuid not null references public.tenants(id),
  actor_id uuid not null references auth.users(id),session_id uuid,document_id uuid,
  kind text not null check(kind in ('chat','document','receipt')),
  status text not null default 'queued' check(status in ('queued','running','waiting_approval','completed','failed','cancelled','interrupted')),
  request_id uuid not null,
  input jsonb not null default '{}',result jsonb, error_code text,
  partial text not null default '', attempts integer not null default 0,
  lease_token uuid,lease_until timestamptz, next_attempt_at timestamptz not null default now(),
  reserved_cents integer not null default 0 check(reserved_cents>=0),
  input_rate numeric, output_rate numeric,
  input_tokens integer not null default 0,output_tokens integer not null default 0,
  created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
  unique(actor_id,request_id),
  foreign key(tenant_id,actor_id) references public.tenant_members(tenant_id,user_id),
  foreign key(tenant_id,session_id) references public.sessions(tenant_id,id) on delete cascade,
  foreign key(tenant_id,document_id) references public.documents(tenant_id,id) on delete cascade,
  check((kind='chat' and session_id is not null) or (kind in ('document','receipt') and document_id is not null))
);
create index runs_due on public.runs(next_attempt_at,created_at) where status in ('queued','running');
create index runs_tenant_usage on public.runs(tenant_id,created_at);
create table public.run_events (
  id bigint generated always as identity primary key,tenant_id uuid not null,
  run_id uuid not null references public.runs(id) on delete cascade,
  event text not null check(event in ('status','completed','error','approval')),
  data jsonb not null default '{}',created_at timestamptz not null default now()
);
create index run_events_cursor on public.run_events(run_id,id);
create table public.knowledge_sources (
  id uuid primary key default gen_random_uuid(),tenant_id uuid not null references public.tenants(id),
  source_key text not null,title text not null,body text not null check(length(body)<=200000),
  source_version text not null,provenance jsonb not null default '{}',
  unique(tenant_id,source_key)
);
create table public.skills (
  id uuid primary key default gen_random_uuid(),tenant_id uuid not null references public.tenants(id),
  skill_key text not null,title text not null,description text not null,
  instructions text not null check(length(instructions)<=60000),metadata jsonb not null default '{}',
  source_version text not null,unique(tenant_id,skill_key)
);
create table public.audit_events (
  id bigint generated always as identity primary key,tenant_id uuid not null references public.tenants(id),
  actor_id uuid references auth.users(id),event text not null,
  resource_id uuid,created_at timestamptz not null default now()
);

-- Credentials are never exposed through PostgREST or user-selectable tables.
create table private.google_grants (
  tenant_id uuid not null,user_id uuid not null,
  ciphertext text not null,scopes text[] not null,google_subject text not null,
  status text not null default 'ready' check(status in ('ready','paused','reauth_required')),
  updated_at timestamptz not null default now(),
  primary key(tenant_id,user_id),
  foreign key(tenant_id,user_id) references public.tenant_members(tenant_id,user_id) on delete cascade
);
create table private.oauth_states (
  digest text primary key,tenant_id uuid not null,user_id uuid not null,
  verifier_ciphertext text not null,services text[] not null,expires_at timestamptz not null
);
revoke all on all tables in schema private from public,anon,authenticated;
grant all on all tables in schema private to service_role;

do $$ declare n text; begin
 foreach n in array array['tenants','tenant_members','tenant_invites','workspaces','workspace_members',
 'memories','documents','document_chunks','sessions','messages','runs','run_events','knowledge_sources','skills','audit_events'] loop
  execute format('alter table public.%I enable row level security',n);
  execute format('revoke all on public.%I from anon,authenticated',n);
  execute format('grant select on public.%I to authenticated',n);
  execute format('grant all on public.%I to service_role',n);
 end loop;
end $$;
grant usage,select on all sequences in schema public to service_role;

create policy tenants_read on public.tenants for select to authenticated using(private.is_member(id));
create policy members_read on public.tenant_members for select to authenticated
 using(private.is_member(tenant_id) and (user_id=(select auth.uid()) or private.is_admin(tenant_id)));
create policy invites_read on public.tenant_invites for select to authenticated using(private.is_admin(tenant_id));
create policy workspaces_read on public.workspaces for select to authenticated using(private.workspace_access(tenant_id,id));
grant insert(tenant_id,created_by,name,description) on public.workspaces to authenticated;
grant update(name,description) on public.workspaces to authenticated;
grant delete on public.workspaces to authenticated;
create policy workspaces_insert on public.workspaces for insert to authenticated
 with check(private.is_member(tenant_id) and created_by=(select auth.uid()));
create policy workspaces_update on public.workspaces for update to authenticated
 using(private.owns_workspace(tenant_id,id)) with check(private.owns_workspace(tenant_id,id));
create policy workspaces_delete on public.workspaces for delete to authenticated using(private.owns_workspace(tenant_id,id));
create policy workspace_members_read on public.workspace_members for select to authenticated using(private.workspace_access(tenant_id,workspace_id));
grant insert,delete on public.workspace_members to authenticated;
create policy workspace_members_insert on public.workspace_members for insert to authenticated
 with check(private.owns_workspace(tenant_id,workspace_id) and exists(select 1 from public.tenant_members m
 where m.tenant_id=workspace_members.tenant_id and m.user_id=workspace_members.user_id and m.active));
-- Owners need the member list to invite by ID, but may not list private content.
create policy members_workspace_invite on public.tenant_members for select to authenticated
 using(private.is_member(tenant_id) and active);
create policy workspace_members_delete on public.workspace_members for delete to authenticated
 using(private.owns_workspace(tenant_id,workspace_id) or user_id=(select auth.uid()));
create policy memories_read on public.memories for select to authenticated
 using(private.resource_access(tenant_id,owner_id,workspace_id,visibility));
grant insert on public.memories to authenticated;
grant update(title,body,confirmed,expires_at,updated_at) on public.memories to authenticated;
grant delete on public.memories to authenticated;
create policy memories_insert on public.memories for insert to authenticated with check(
 owner_id=(select auth.uid()) and private.resource_access(tenant_id,owner_id,workspace_id,visibility,true));
create policy memories_update on public.memories for update to authenticated
 using(owner_id=(select auth.uid()) and private.resource_access(tenant_id,owner_id,workspace_id,visibility,true))
 with check(owner_id=(select auth.uid()) and private.resource_access(tenant_id,owner_id,workspace_id,visibility,true));
create policy memories_delete on public.memories for delete to authenticated
 using(owner_id=(select auth.uid()) and private.resource_access(tenant_id,owner_id,workspace_id,visibility,true));
create policy documents_read on public.documents for select to authenticated
 using(deleted_at is null and private.resource_access(tenant_id,owner_id,workspace_id,visibility));
grant update(name,deleted_at) on public.documents to authenticated;
create policy documents_update on public.documents for update to authenticated
 using(owner_id=(select auth.uid()) and private.resource_access(tenant_id,owner_id,workspace_id,visibility,true))
 with check(owner_id=(select auth.uid()) and private.resource_access(tenant_id,owner_id,workspace_id,visibility,true));
create policy chunks_read on public.document_chunks for select to authenticated using(private.document_access(tenant_id,document_id));
create policy sessions_read on public.sessions for select to authenticated
 using(private.resource_access(tenant_id,owner_id,workspace_id,visibility));
grant insert(tenant_id,owner_id,workspace_id,visibility,title) on public.sessions to authenticated;
grant delete on public.sessions to authenticated;
create policy sessions_insert on public.sessions for insert to authenticated
 with check(owner_id=(select auth.uid()) and private.resource_access(tenant_id,owner_id,workspace_id,visibility,true));
create policy sessions_delete on public.sessions for delete to authenticated
 using(owner_id=(select auth.uid()) and private.resource_access(tenant_id,owner_id,workspace_id,visibility,true));
create policy messages_read on public.messages for select to authenticated using(private.session_access(tenant_id,session_id));
create policy runs_read on public.runs for select to authenticated
 using(private.is_member(tenant_id) and ((session_id is not null and private.session_access(tenant_id,session_id))
 or (document_id is not null and private.document_access(tenant_id,document_id))));
create policy run_events_read on public.run_events for select to authenticated
 using(exists(select 1 from public.runs r where r.id=run_id and r.tenant_id=run_events.tenant_id));
create policy knowledge_read on public.knowledge_sources for select to authenticated using(private.is_member(tenant_id));
create policy skills_read on public.skills for select to authenticated using(private.is_member(tenant_id));
create policy audit_read on public.audit_events for select to authenticated using(private.is_admin(tenant_id));

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('documents','documents',false,10485760,array['application/pdf','image/jpeg','image/png','image/webp',
 'text/plain','text/markdown','application/vnd.openxmlformats-officedocument.wordprocessingml.document',
 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
 'application/vnd.openxmlformats-officedocument.presentationml.presentation']) on conflict(id) do nothing;
create policy files_read on storage.objects for select to authenticated using(
 bucket_id='documents' and exists(select 1 from public.documents d where d.object_path=objects.name
 and d.status in ('ready','processing') and d.deleted_at is null
 and private.resource_access(d.tenant_id,d.owner_id,d.workspace_id,d.visibility)));
create policy files_insert on storage.objects for insert to authenticated with check(
 bucket_id='documents' and exists(select 1 from public.documents d where d.object_path=objects.name
 and d.status='uploading' and d.owner_id=(select auth.uid()) and d.deleted_at is null
 and private.resource_access(d.tenant_id,d.owner_id,d.workspace_id,d.visibility,true)));

-- All client-callable mutations below derive identity from auth.uid().
create function public.create_document(t uuid,w uuid,visibility text,file_name text,file_mime text,file_bytes bigint,parent_document uuid default null)
returns public.documents language plpgsql security definer set search_path = '' as $$
declare result public.documents; used bigint; personal bigint; limits public.tenants; begin
 if not private.resource_access(t,auth.uid(),w,visibility,true) or file_bytes not between 1 and 10485760
 or length(file_name) not between 1 and 200 or visibility not in ('private','workspace')
 or file_mime not in ('application/pdf','image/jpeg','image/png','image/webp','text/plain','text/markdown',
 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
 'application/vnd.openxmlformats-officedocument.presentationml.presentation') then
 raise exception 'ACCESS_DENIED'; end if;
 if parent_document is not null and not exists(select 1 from public.documents p where p.tenant_id=t and p.id=parent_document
 and p.owner_id=auth.uid() and p.derived_from is null and p.visibility=create_document.visibility
 and p.workspace_id is not distinct from w and private.document_access(t,p.id,true)) then raise exception 'ACCESS_DENIED'; end if;
 select * into limits from public.tenants where id=t for update;
 select coalesce(sum(bytes),0),coalesce(sum(bytes) filter(where owner_id=auth.uid()),0)
 into used,personal from public.documents where tenant_id=t;
 if used+file_bytes>limits.storage_limit or personal+file_bytes>limits.member_storage_limit then
 raise exception 'STORAGE_QUOTA'; end if;
 if (select count(*) from public.documents where tenant_id=t and owner_id=auth.uid() and status='uploading' and deleted_at is null)>=2 then
 raise exception 'UPLOAD_PENDING'; end if;
 insert into public.documents(tenant_id,owner_id,workspace_id,visibility,name,mime,bytes,derived_from)
 values(t,auth.uid(),w,visibility,file_name,file_mime,file_bytes,parent_document) returning * into result;
 update public.documents set object_path=t::text||'/'||result.owner_id::text||'/'||result.id::text
 where id=result.id returning * into result;
 return result;
end $$;

create function public.save_draft(t uuid,s uuid,expected_version integer,body text)
returns public.sessions language plpgsql security invoker set search_path = '' as $$
declare result public.sessions; begin
 if length(body)>200000 or not private.session_access(t,s,true) then raise exception 'ACCESS_DENIED'; end if;
 update public.sessions set draft=body,version=version+1 where tenant_id=t and id=s and version=expected_version returning * into result;
 if not found then raise exception 'VERSION_CONFLICT'; end if;
 return result;
end $$;
grant update(draft,version) on public.sessions to authenticated;
create policy sessions_update on public.sessions for update to authenticated
 using(private.resource_access(tenant_id,owner_id,workspace_id,visibility,true))
 with check(private.resource_access(tenant_id,owner_id,workspace_id,visibility,true));

create function public.match_documents(t uuid,w uuid,query_embedding extensions.vector(768),take integer default 6)
returns table(document_id uuid,content text,location text,distance double precision)
language sql stable security invoker set search_path = '' as $$
 select d.id,c.content,c.location,(c.embedding operator(extensions.<=>) query_embedding)::double precision
 from public.document_chunks c join public.documents d on d.id=c.document_id and d.tenant_id=c.tenant_id
 where c.tenant_id=t and d.source_kind='upload' and d.status='ready' and c.embedding is not null
 and (d.visibility='private' or d.workspace_id=w)
 order by c.embedding operator(extensions.<=>) query_embedding limit least(greatest(take,1),10)
$$;

-- Private helpers return access decisions only, never resource contents.
revoke all on all functions in schema private from public,anon;
grant execute on all functions in schema private to authenticated,service_role;
revoke execute on function public.create_document(uuid,uuid,text,text,text,bigint,uuid) from public,anon;
revoke execute on function public.save_draft(uuid,uuid,integer,text) from public,anon;
revoke execute on function public.match_documents(uuid,uuid,extensions.vector,integer) from public,anon;
grant execute on function public.create_document(uuid,uuid,text,text,text,bigint,uuid) to authenticated;
grant execute on function public.save_draft(uuid,uuid,integer,text) to authenticated;
grant execute on function public.match_documents(uuid,uuid,extensions.vector,integer) to authenticated;
