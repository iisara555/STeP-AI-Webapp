-- First-owner reservations are operator-only and are never exposed by Data API.
create table private.owner_invites (
 tenant_id uuid primary key references public.tenants(id) on delete cascade,
 email text not null check(email=lower(trim(email)) and length(email)<=254),
 expires_at timestamptz not null default now()+interval '30 days',
 accepted_at timestamptz
);
alter table private.owner_invites enable row level security;
revoke all on private.owner_invites from public,anon,authenticated;
grant all on private.owner_invites to service_role;

create function public.bootstrap_tenant(tenant_name text,owner_email text) returns uuid
language plpgsql security definer set search_path='' as $$
declare t uuid; reserved text; begin
 if length(trim(tenant_name)) not between 1 and 100 or length(owner_email)>254
 or owner_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
 then raise exception 'INVALID_REQUEST'; end if;
 perform pg_advisory_xact_lock(hashtext('bootstrap:'||trim(tenant_name)));
 select x.id,i.email into t,reserved from public.tenants x
 join private.owner_invites i on i.tenant_id=x.id where x.name=trim(tenant_name) limit 1;
 if t is not null then
  if reserved<>lower(trim(owner_email)) then raise exception 'REQUEST_CONFLICT'; end if;
  return t;
 end if;
 if exists(select 1 from public.tenants where name=trim(tenant_name)) then raise exception 'REQUEST_CONFLICT'; end if;
 insert into public.tenants(name) values(trim(tenant_name)) returning id into t;
 insert into private.owner_invites(tenant_id,email) values(t,lower(trim(owner_email)));
 insert into public.audit_events(tenant_id,event) values(t,'tenant_bootstrapped');
 return t;
end $$;
revoke execute on function public.bootstrap_tenant(text,text) from public,anon,authenticated;
grant execute on function public.bootstrap_tenant(text,text) to service_role;

create or replace function public.accept_invites() returns integer
language plpgsql security definer set search_path='' as $$
declare u auth.users; n integer; owners integer; begin
 select * into u from auth.users where id=auth.uid();
 if u.id is null or u.email_confirmed_at is null or not exists(select 1 from auth.identities i
 where i.user_id=u.id and i.provider='google' and lower(i.identity_data->>'email')=lower(u.email)
 and coalesce((i.identity_data->>'email_verified')::boolean,false)) then raise exception 'GOOGLE_IDENTITY_REQUIRED'; end if;
 with accepted as (
  update private.owner_invites i set accepted_at=now()
  where i.email=lower(u.email) and i.accepted_at is null and i.expires_at>now()
  and exists(select 1 from public.tenants t where t.id=i.tenant_id and t.active)
  and not exists(select 1 from public.tenant_members m where m.tenant_id=i.tenant_id and m.role='owner')
  returning i.tenant_id
 ) insert into public.tenant_members(tenant_id,user_id,role,email,display_name)
 select tenant_id,u.id,'owner',lower(u.email),left(coalesce(u.raw_user_meta_data->>'full_name',''),100) from accepted
 on conflict(tenant_id,user_id) do update set role='owner',active=true;
 get diagnostics owners=row_count;
 with accepted as (
  update public.tenant_invites i set accepted_at=now() where lower(i.email)=lower(u.email)
  and accepted_at is null and expires_at>now()
  and exists(select 1 from public.tenants t where t.id=i.tenant_id and t.active)
  returning i.tenant_id,i.role
 ) insert into public.tenant_members(tenant_id,user_id,role,email,display_name)
 select tenant_id,u.id,role,lower(u.email),left(coalesce(u.raw_user_meta_data->>'full_name',''),100) from accepted
 on conflict(tenant_id,user_id) do nothing;
 get diagnostics n=row_count;
 return n+owners;
end $$;

-- The initial free-plan pilot is bounded even when clients call the Data API.
create function private.limit_members() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if new.active and (tg_op='INSERT' or not old.active) then
  perform 1 from public.tenants where id=new.tenant_id for update;
  if (select count(*) from public.tenant_members where tenant_id=new.tenant_id and active)>=20
  then raise exception 'MEMBER_LIMIT'; end if;
 end if;
 return new;
end $$;
create trigger pilot_member_limit before insert or update of active on public.tenant_members
for each row execute function private.limit_members();

create function private.limit_memories() returns trigger language plpgsql security definer set search_path='' as $$
begin
 perform 1 from public.tenant_members where tenant_id=new.tenant_id and user_id=new.owner_id for update;
 if (select count(*) from public.memories where tenant_id=new.tenant_id and owner_id=new.owner_id)>=200
 then raise exception 'MEMORY_LIMIT'; end if;
 return new;
end $$;
create trigger member_memory_limit before insert on public.memories
for each row execute function private.limit_memories();
revoke execute on function private.limit_members(),private.limit_memories() from public,anon,authenticated;
