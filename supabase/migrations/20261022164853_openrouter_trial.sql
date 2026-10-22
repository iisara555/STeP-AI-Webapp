-- Only reservation metadata is retained; trial prompts and replies are never stored.
create table private.openrouter_trial_requests (
  request_id uuid primary key,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  user_id uuid not null,
  created_at timestamptz not null default now(),
  foreign key (tenant_id,user_id) references public.tenant_members(tenant_id,user_id) on delete cascade
);
create index openrouter_trial_time on private.openrouter_trial_requests(tenant_id,created_at);
revoke all on private.openrouter_trial_requests from public,anon,authenticated;
grant all on private.openrouter_trial_requests to service_role;

create function public.reserve_openrouter_trial(t uuid, u uuid, request_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare day_count integer; minute_count integer;
begin
  if not exists(select 1 from public.tenant_members m join public.tenants x on x.id=m.tenant_id
    where m.tenant_id=t and m.user_id=u and m.active and x.active and m.role in ('owner','admin'))
    then raise exception 'ACCESS_DENIED'; end if;
  perform pg_advisory_xact_lock(hashtextextended('openrouter-trial:' || t::text,0));
  if exists(select 1 from private.openrouter_trial_requests r where r.request_id=reserve_openrouter_trial.request_id)
    then raise exception 'REQUEST_CONFLICT'; end if;
  select count(*) filter(where created_at>=date_trunc('day',now() at time zone 'UTC') at time zone 'UTC'),
    count(*) filter(where created_at>now()-interval '1 minute')
    into day_count,minute_count from private.openrouter_trial_requests
    where tenant_id=t and created_at>=least(
      date_trunc('day',now() at time zone 'UTC') at time zone 'UTC',now()-interval '1 minute');
  if day_count>=40 or minute_count>=5 then raise exception 'OPENROUTER_RATE_LIMIT'; end if;
  insert into private.openrouter_trial_requests(request_id,tenant_id,user_id)
    values(reserve_openrouter_trial.request_id,t,u);
end $$;
revoke all on function public.reserve_openrouter_trial(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.reserve_openrouter_trial(uuid,uuid,uuid) to service_role;
