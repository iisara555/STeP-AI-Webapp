-- Explicit, administrator-only, text-only free pilot; paid budgets stay off.
alter table public.tenants add column free_ai_trial_enabled boolean not null default false;
alter table public.tenants add column free_ai_daily_limit integer not null default 20 check(free_ai_daily_limit between 1 and 50);
alter table public.runs add column ai_provider text not null default 'gemini' check(ai_provider in ('gemini','openrouter_free'));
create index runs_free_trial_usage on public.runs(created_at,tenant_id) where ai_provider='openrouter_free';

create function public.configure_free_trial(t uuid,enabled boolean,daily_limit integer) returns void
language plpgsql security definer set search_path='' as $$ begin
 if not private.is_admin(t) or enabled is null or daily_limit is null or daily_limit not between 1 and 50 then raise exception 'ACCESS_DENIED'; end if;
 update public.tenants set free_ai_trial_enabled=enabled,free_ai_daily_limit=daily_limit where id=t;
 insert into public.audit_events(tenant_id,actor_id,event)values(t,auth.uid(),'free_ai_trial_updated');
end $$;
revoke all on function public.configure_free_trial(uuid,boolean,integer) from public,anon,authenticated;
grant execute on function public.configure_free_trial(uuid,boolean,integer) to authenticated;

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
 select * into limits from public.tenants where id=t for update;
 selected_provider=coalesce(payload->>'aiProvider','gemini');
 if selected_provider not in ('gemini','openrouter_free') then raise exception 'ACCESS_DENIED'; end if;
 if selected_provider='openrouter_free' then
  if not private.is_admin(t) then raise exception 'ACCESS_DENIED'; end if;
  if not limits.free_ai_trial_enabled then raise exception 'AI_NOT_CONFIGURED'; end if;
  if job_kind<>'chat' then raise exception 'AI_TRIAL_TEXT_ONLY'; end if;
  -- All tenants share one upstream key. Serialize admission across tenants;
  -- purged/failed/cancelled attempts still count and cannot refund quota.
  perform pg_advisory_xact_lock(hashtext('openrouter-free-admission'));
  if (select count(*) from public.runs where ai_provider='openrouter_free' and created_at>=date_trunc('day',now() at time zone 'UTC') at time zone 'UTC')>=40
   or (select count(*) from public.runs where tenant_id=t and ai_provider='openrouter_free' and created_at>=date_trunc('day',now() at time zone 'UTC') at time zone 'UTC')>=limits.free_ai_daily_limit
  then raise exception 'AI_FREE_QUOTA'; end if;
  if (select count(*) from public.runs where ai_provider='openrouter_free' and created_at>now()-interval '1 minute')>=15
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

create or replace function public.worker_payload(job_id uuid,lease uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare job public.runs; s public.sessions; d public.documents; prepared public.documents; docs jsonb; memories jsonb; sources jsonb; skills jsonb; history jsonb; begin
 select * into job from public.runs where id=job_id and lease_token=lease and status='running' and lease_until>now();
 if job.id is null then raise exception 'RUN_INTERRUPTED'; end if;
 perform set_config('request.jwt.claim.sub',job.actor_id::text,true);
 if not private.is_member(job.tenant_id) then raise exception 'ACCESS_DENIED'; end if;
 if job.ai_provider='openrouter_free' and (not private.is_admin(job.tenant_id)
  or not exists(select 1 from public.tenants where id=job.tenant_id and free_ai_trial_enabled))
 then raise exception 'ACCESS_DENIED'; end if;
 if job.kind='chat' then
  if not private.session_access(job.tenant_id,job.session_id,true) then raise exception 'ACCESS_DENIED'; end if;
  select * into s from public.sessions where id=job.session_id and tenant_id=job.tenant_id;
  select coalesce(jsonb_agg(to_jsonb(x)),'[]') into docs from public.documents x
   where x.tenant_id=job.tenant_id and x.id::text in(select jsonb_array_elements_text(coalesce(job.input->'documentIds','[]')))
   and private.document_access(x.tenant_id,x.id) and (s.visibility='private' or x.visibility='workspace' and x.source_kind='upload' and x.workspace_id=s.workspace_id);
  if jsonb_array_length(docs)<>jsonb_array_length(coalesce(job.input->'documentIds','[]')) then raise exception 'ACCESS_DENIED'; end if;
  select coalesce(jsonb_agg(to_jsonb(m)),'[]') into memories from public.memories m where m.tenant_id=job.tenant_id
   and m.confirmed and (m.expires_at is null or m.expires_at>now()) and (job.input->>'useMemory')='true'
   and ((s.visibility='private' and m.visibility='private' and m.owner_id=job.actor_id)
   or (m.visibility='workspace' and m.workspace_id=s.workspace_id and private.workspace_access(job.tenant_id,m.workspace_id)));
  select coalesce(jsonb_agg(to_jsonb(h) order by h.created_at),'[]') into history from (
   select role,body,created_at from public.messages where tenant_id=job.tenant_id and session_id=job.session_id order by created_at desc limit 12
  )h;
 else
  if not private.document_access(job.tenant_id,job.document_id,true) then raise exception 'ACCESS_DENIED'; end if;
  select * into d from public.documents where tenant_id=job.tenant_id and id=job.document_id and status='ready';
  if d.id is null or d.source_kind<>'upload' then raise exception 'ACCESS_DENIED'; end if;
  select * into prepared from public.documents p where p.tenant_id=job.tenant_id and p.derived_from=d.id
   and p.status='ready' and p.deleted_at is null and private.document_access(p.tenant_id,p.id,true)
   order by created_at desc limit 1;
 end if;
 select coalesce(jsonb_agg(to_jsonb(k)),'[]') into sources from public.knowledge_sources k where tenant_id=job.tenant_id;
 select coalesce(jsonb_agg(to_jsonb(k)),'[]') into skills from public.skills k where tenant_id=job.tenant_id;
 return jsonb_build_object('run',to_jsonb(job),'session',to_jsonb(s),'document',to_jsonb(d),'prepared_document',to_jsonb(prepared),
 'documents',coalesce(docs,'[]'),'memories',coalesce(memories,'[]'),'sources',sources,'skills',skills,'history',coalesce(history,'[]'));
end $$;

create or replace function public.finish_run(job_id uuid,lease uuid,answer jsonb,error text,input_count integer,output_count integer)
returns boolean language plpgsql security definer set search_path = '' as $$
declare job public.runs; rates public.tenants; cost integer; begin
 select * into job from public.runs where id=job_id for update;
 if job.status<>'running' or job.lease_token is distinct from lease or job.lease_until<now() then return false; end if;
 perform set_config('request.jwt.claim.sub',job.actor_id::text,true);
 if not private.is_member(job.tenant_id) or (job.ai_provider='openrouter_free' and (not private.is_admin(job.tenant_id) or not exists(select 1 from public.tenants where id=job.tenant_id and free_ai_trial_enabled))) or (job.kind='chat' and not private.session_access(job.tenant_id,job.session_id,true))
 or (job.kind<>'chat' and not private.document_access(job.tenant_id,job.document_id,true)) then
  update public.runs set status='cancelled',error_code='ACCESS_DENIED',updated_at=now(),lease_until=null where id=job_id;
  return false;
 end if;
 select * into rates from public.tenants where id=job.tenant_id;
 cost=ceil((greatest(input_count,0)*job.input_rate+greatest(output_count,0)*job.output_rate)/1000000)::integer;
 if cost>job.reserved_cents then
  update public.tenants set monthly_ai_budget_cents=0 where id=job.tenant_id;
  insert into public.audit_events(tenant_id,event) values(job.tenant_id,'ai_reservation_exceeded');
 end if;
 update public.runs set status=case when error is null then 'completed' else 'failed' end,
 result=case when error is null then answer else null end,error_code=error,
 partial=case when error is null then coalesce(answer->>'text',partial) else partial end,
 input_tokens=greatest(input_count,0),output_tokens=greatest(output_count,0),
 reserved_cents=case when error is null then greatest(cost,0) else greatest(reserved_cents,coalesce(cost,0)) end,
 updated_at=now(),lease_until=null where id=job_id;
 if error is null and job.kind='chat' then
  insert into public.messages(tenant_id,session_id,role,body,sources)
  values(job.tenant_id,job.session_id,'assistant',coalesce(answer->>'text',''),coalesce(answer->'sources','[]'));
 end if;
 insert into public.run_events(tenant_id,run_id,event,data) values(job.tenant_id,job.id,
 case when error is null then 'completed' else 'error' end,jsonb_build_object('code',error));
 return true;
end $$;
-- CREATE OR REPLACE retains the previously hardened function ACLs.
revoke execute on function public.worker_payload(uuid,uuid) from public,anon,authenticated;
revoke execute on function public.finish_run(uuid,uuid,jsonb,text,integer,integer) from public,anon,authenticated;

create or replace function public.usage_summary(t uuid) returns jsonb language plpgsql security definer set search_path = '' as $$
declare administrator boolean; jobs jsonb; used bigint; own_bytes bigint; begin
 if not private.is_member(t) then raise exception 'ACCESS_DENIED'; end if;
 administrator=private.is_admin(t);
 select coalesce(jsonb_agg(to_jsonb(x)),'[]') into jobs from (
  select kind,status,count(*)::integer count,coalesce(sum(input_tokens),0)::bigint input_tokens,
  coalesce(sum(output_tokens),0)::bigint output_tokens,coalesce(sum(reserved_cents),0)::bigint reserved_cents
  from public.runs where tenant_id=t and (administrator or actor_id=auth.uid())
  and created_at>=date_trunc('month',now() at time zone 'Asia/Bangkok') at time zone 'Asia/Bangkok'
  group by kind,status
 )x;
 select coalesce(sum(bytes),0),coalesce(sum(bytes) filter(where owner_id=auth.uid()),0) into used,own_bytes
 from public.documents where tenant_id=t;
 return jsonb_build_object('runs',jobs,'visibleBytes',case when administrator then used else own_bytes end,'ownBytes',own_bytes,'organizationSummary',administrator,'freeTrialUsed',(select count(*) from public.runs where tenant_id=t and ai_provider='openrouter_free' and (administrator or actor_id=auth.uid()) and created_at>=date_trunc('day',now() at time zone 'UTC') at time zone 'UTC'));
end $$;


