-- Both OpenRouter channels share one account: use the same transaction lock and
-- include all accepted attempts, even failed/cancelled/purged jobs, in its quota.
-- This migration never enables a trial or changes a paid budget.
alter table private.openrouter_trial_requests enable row level security;
create index openrouter_trial_global_time on private.openrouter_trial_requests(created_at);

create or replace function public.reserve_openrouter_trial(t uuid, u uuid, request_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare day_count bigint; minute_count bigint; sandbox_minute_count bigint;
begin
  if not exists(select 1 from public.tenant_members m join public.tenants x on x.id=m.tenant_id
    where m.tenant_id=t and m.user_id=u and m.active and x.active and m.role in ('owner','admin'))
    then raise exception 'ACCESS_DENIED'; end if;
  perform pg_advisory_xact_lock(hashtext('openrouter-free-admission'));
  if exists(select 1 from private.openrouter_trial_requests r where r.request_id=reserve_openrouter_trial.request_id)
    then raise exception 'REQUEST_CONFLICT'; end if;
  select count(*) filter(where created_at>=date_trunc('day',now() at time zone 'UTC') at time zone 'UTC'),
    count(*) filter(where created_at>now()-interval '1 minute'),
    count(*) filter(where sandbox and tenant_id=t and created_at>now()-interval '1 minute')
    into day_count,minute_count,sandbox_minute_count from (
      select tenant_id,created_at,true as sandbox from private.openrouter_trial_requests
      where created_at>=least(date_trunc('day',now() at time zone 'UTC') at time zone 'UTC',now()-interval '1 minute')
      union all
      select tenant_id,created_at,false as sandbox from public.runs where ai_provider='openrouter_free'
      and created_at>=least(date_trunc('day',now() at time zone 'UTC') at time zone 'UTC',now()-interval '1 minute')
    )attempts;
  if day_count>=40 or minute_count>=15 or sandbox_minute_count>=5
    then raise exception 'OPENROUTER_RATE_LIMIT'; end if;
  insert into private.openrouter_trial_requests(request_id,tenant_id,user_id)
    values(reserve_openrouter_trial.request_id,t,u);
end $$;
revoke all on function public.reserve_openrouter_trial(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.reserve_openrouter_trial(uuid,uuid,uuid) to service_role;

create or replace function public.start_run(t uuid,s uuid,d uuid,job_kind text,request uuid,payload jsonb)
returns public.runs language plpgsql security definer set search_path = '' as $$
declare limits public.tenants; existing public.runs; created public.runs; reserve integer; used bigint; selected_provider text; rate_in numeric; rate_out numeric; begin
 if not private.is_member(t) or length(payload::text)>220000 or job_kind not in ('chat','document','receipt')
 then raise exception 'ACCESS_DENIED'; end if;
 select * into existing from public.runs where actor_id=auth.uid() and request_id=request;
 if existing.id is not null then
  if existing.tenant_id<>t or existing.kind<>job_kind or existing.session_id is distinct from s
   or existing.document_id is distinct from d or existing.input<>payload then raise exception 'REQUEST_CONFLICT'; end if;
  return existing;
 end if;
 if (job_kind='chat' and (not private.session_access(t,s,true) or d is not null))
 or (job_kind in ('document','receipt') and (not private.document_access(t,d,true) or s is not null))
 or (payload->>'consent') is distinct from 'true' then raise exception 'ACCESS_DENIED'; end if;
 selected_provider=coalesce(payload->>'aiProvider','gemini');
 if selected_provider not in ('gemini','openrouter_free') then raise exception 'ACCESS_DENIED'; end if;
 -- Lock the shared account before the tenant row. Sandbox inserts also acquire
 -- tenant foreign-key locks, so the opposite order can deadlock.
 if selected_provider='openrouter_free' then
  perform pg_advisory_xact_lock(hashtext('openrouter-free-admission'));
 end if;
 select * into limits from public.tenants where id=t for update;
 if selected_provider='openrouter_free' then
  if not private.is_admin(t) then raise exception 'ACCESS_DENIED'; end if;
  if not limits.free_ai_trial_enabled then raise exception 'AI_NOT_CONFIGURED'; end if;
  if job_kind<>'chat' then raise exception 'AI_TRIAL_TEXT_ONLY'; end if;
  -- Purged/failed/cancelled attempts retain the shared account quota.
  if ((select count(*) from public.runs where ai_provider='openrouter_free' and created_at>=date_trunc('day',now() at time zone 'UTC') at time zone 'UTC')
   +(select count(*) from private.openrouter_trial_requests where created_at>=date_trunc('day',now() at time zone 'UTC') at time zone 'UTC'))>=40
   or (select count(*) from public.runs where tenant_id=t and ai_provider='openrouter_free' and created_at>=date_trunc('day',now() at time zone 'UTC') at time zone 'UTC')>=limits.free_ai_daily_limit
  then raise exception 'AI_FREE_QUOTA'; end if;
  if ((select count(*) from public.runs where ai_provider='openrouter_free' and created_at>now()-interval '1 minute')
   +(select count(*) from private.openrouter_trial_requests where created_at>now()-interval '1 minute'))>=15
  then raise exception 'AI_FREE_RATE_LIMIT'; end if;
  reserve=0; rate_in=0; rate_out=0;
 else
  if limits.monthly_ai_budget_cents<=0 or limits.input_cents_per_million is null or limits.output_cents_per_million is null
  then raise exception 'AI_NOT_CONFIGURED'; end if;
  rate_in=limits.input_cents_per_million; rate_out=limits.output_cents_per_million;
  -- A free trial never enables this paid branch or changes its budget.
  reserve=greatest(1,ceil((64000*rate_in+4096*rate_out)/1000000)::integer);
  select coalesce(sum(reserved_cents),0) into used from public.runs where tenant_id=t and created_at>=date_trunc('month',now() at time zone 'Asia/Bangkok') at time zone 'Asia/Bangkok';
  if used+reserve>limits.monthly_ai_budget_cents then raise exception 'AI_QUOTA'; end if;
 end if;
 if exists(select 1 from public.runs where tenant_id=t and actor_id=auth.uid() and status in ('queued','running','waiting_approval')) then raise exception 'RUN_ACTIVE'; end if;
 if (select count(*) from public.runs where tenant_id=t and actor_id=auth.uid() and created_at>=date_trunc('day',now() at time zone 'Asia/Bangkok') at time zone 'Asia/Bangkok')>=50
 then raise exception 'AI_QUOTA'; end if;
 if job_kind='chat' and (length(trim(coalesce(payload->>'message','')))=0 or length(payload->>'message')>20000) then raise exception 'MESSAGE_INVALID'; end if;
 insert into public.runs(tenant_id,actor_id,session_id,document_id,kind,request_id,input,reserved_cents,input_rate,output_rate,ai_provider)
 values(t,auth.uid(),s,d,job_kind,request,payload,reserve,rate_in,rate_out,selected_provider) returning * into created;
 if job_kind='chat' then
  insert into public.messages(tenant_id,session_id,role,body) values(t,s,'user',payload->>'message');
  update public.sessions set title=case when title='เริ่มงานใหม่' then left(payload->>'message',100) else title end where id=s and tenant_id=t;
 end if;
 insert into public.run_events(tenant_id,run_id,event,data) values(t,created.id,'status','{"status":"queued"}');
 return created;
end $$;

-- Exact allowlist only. Client roles never receive decrypted server secrets.
create or replace function public.read_server_runtime_config() returns jsonb
language sql security definer set search_path='' as $$
 select coalesce(jsonb_object_agg(m.env_name,v.decrypted_secret),'{}'::jsonb)
 from (values
  ('step_ai_provider','AI_PROVIDER'),
  ('step_openrouter_api_key','OPENROUTER_API_KEY'),
  ('step_openrouter_trial_tenant_id','OPENROUTER_TRIAL_TENANT_ID'),
  ('step_openrouter_model','OPENROUTER_MODEL'),
  ('step_openrouter_provider','OPENROUTER_PROVIDER'),
  ('step_worker_secret','WORKER_SECRET'),
  ('step_app_origin','APP_ORIGIN')
 )m(vault_name,env_name)
 join vault.decrypted_secrets v on v.name=m.vault_name
$$;
revoke all on function public.read_server_runtime_config() from public,anon,authenticated;
grant execute on function public.read_server_runtime_config() to service_role;


