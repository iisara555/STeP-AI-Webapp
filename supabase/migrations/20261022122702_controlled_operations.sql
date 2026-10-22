alter default privileges revoke execute on functions from public;
alter table public.tenant_members add column email text;
alter table public.tenant_members add column display_name text not null default '';
create unique index tenant_member_email on public.tenant_members(tenant_id,lower(email));

create function public.accept_invites() returns integer language plpgsql security definer set search_path = '' as $$
declare u auth.users; n integer; begin
 select * into u from auth.users where id=auth.uid();
 if u.id is null or u.email_confirmed_at is null or not exists(select 1 from auth.identities i
 where i.user_id=u.id and i.provider='google' and lower(i.identity_data->>'email')=lower(u.email)
 and coalesce((i.identity_data->>'email_verified')::boolean,false)) then raise exception 'GOOGLE_IDENTITY_REQUIRED'; end if;
 with accepted as (
 update public.tenant_invites i set accepted_at=now() where lower(i.email)=lower(u.email)
 and accepted_at is null and expires_at>now() and exists(select 1 from public.tenants t where t.id=i.tenant_id and t.active)
 returning i.tenant_id,i.role
 ) insert into public.tenant_members(tenant_id,user_id,role,email,display_name)
 select tenant_id,u.id,role,lower(u.email),left(coalesce(u.raw_user_meta_data->>'full_name',''),100) from accepted
 on conflict(tenant_id,user_id) do nothing;
 get diagnostics n=row_count;
 return n;
end $$;
grant execute on function public.accept_invites() to authenticated;

create function public.invite_member(t uuid,invite_email text,member_role text default 'member') returns void
language plpgsql security definer set search_path = '' as $$
begin
 if not private.is_admin(t) or member_role not in ('member','admin') or length(invite_email)>254
 or invite_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then raise exception 'ACCESS_DENIED'; end if;
 if member_role='admin' and not exists(select 1 from public.tenant_members where tenant_id=t and user_id=auth.uid() and role='owner')
 then raise exception 'ACCESS_DENIED'; end if;
 insert into public.tenant_invites(tenant_id,email,role,created_by) values(t,lower(trim(invite_email)),member_role,auth.uid())
 on conflict(tenant_id,email) do update set role=excluded.role,created_by=excluded.created_by,
 expires_at=now()+interval '7 days',accepted_at=null;
 insert into public.audit_events(tenant_id,actor_id,event) values(t,auth.uid(),'member_invited');
end $$;
grant execute on function public.invite_member(uuid,text,text) to authenticated;

create function public.set_member_active(t uuid,member uuid,enabled boolean) returns void
language plpgsql security definer set search_path = '' as $$
begin
 if not private.is_admin(t) or member=auth.uid() then raise exception 'ACCESS_DENIED'; end if;
 update public.tenant_members set active=enabled where tenant_id=t and user_id=member and role='member';
 if not found then raise exception 'ACCESS_DENIED'; end if;
 insert into public.audit_events(tenant_id,actor_id,event,resource_id) values(t,auth.uid(),case when enabled then 'member_resumed' else 'member_suspended' end,member);
end $$;
grant execute on function public.set_member_active(uuid,uuid,boolean) to authenticated;

create function public.add_workspace_member(t uuid,w uuid,member_email text,member_role text) returns void
language plpgsql security definer set search_path = '' as $$
declare member uuid; begin
 if not private.owns_workspace(t,w) or member_role not in ('editor','viewer') then raise exception 'ACCESS_DENIED'; end if;
 select user_id into member from public.tenant_members where tenant_id=t and lower(email)=lower(trim(member_email)) and active;
 if member is null or member=auth.uid() then raise exception 'MEMBER_NOT_FOUND'; end if;
 insert into public.workspace_members(tenant_id,workspace_id,user_id,role) values(t,w,member,member_role)
 on conflict(workspace_id,user_id) do update set role=excluded.role;
 insert into public.audit_events(tenant_id,actor_id,event,resource_id) values(t,auth.uid(),'workspace_member_added',w);
end $$;
grant execute on function public.add_workspace_member(uuid,uuid,text,text) to authenticated;

-- Only the checked function can write drafts: direct UPDATE would bypass the
-- optimistic version check and silently overwrite another editor's changes.
revoke update on public.sessions from authenticated;
revoke update(draft,version) on public.sessions from authenticated;
alter function public.save_draft(uuid,uuid,integer,text) security definer;

create function public.start_run(t uuid,s uuid,d uuid,job_kind text,request uuid,payload jsonb)
returns public.runs language plpgsql security definer set search_path = '' as $$
declare limits public.tenants; existing public.runs; created public.runs; reserve integer; used bigint; begin
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
 if limits.monthly_ai_budget_cents<=0 or limits.input_cents_per_million is null or limits.output_cents_per_million is null
 then raise exception 'AI_NOT_CONFIGURED'; end if;
 if exists(select 1 from public.runs where tenant_id=t and actor_id=auth.uid() and status in ('queued','running','waiting_approval')) then raise exception 'RUN_ACTIVE'; end if;
 if (select count(*) from public.runs where tenant_id=t and actor_id=auth.uid() and created_at>=date_trunc('day',now() at time zone 'Asia/Bangkok') at time zone 'Asia/Bangkok')>=50
 then raise exception 'AI_QUOTA'; end if;
 -- Reserve the maximum input/output cost; a network failure keeps its reserve.
 reserve=greatest(1,ceil((64000*limits.input_cents_per_million+4096*limits.output_cents_per_million)/1000000)::integer);
 select coalesce(sum(reserved_cents),0) into used from public.runs where tenant_id=t and created_at>=date_trunc('month',now() at time zone 'Asia/Bangkok') at time zone 'Asia/Bangkok';
 if used+reserve>limits.monthly_ai_budget_cents then raise exception 'AI_QUOTA'; end if;
 if job_kind='chat' and (length(trim(coalesce(payload->>'message','')))=0 or length(payload->>'message')>20000) then raise exception 'MESSAGE_INVALID'; end if;
 insert into public.runs(tenant_id,actor_id,session_id,document_id,kind,request_id,input,reserved_cents,input_rate,output_rate)
 values(t,auth.uid(),s,d,job_kind,request,payload,reserve,limits.input_cents_per_million,limits.output_cents_per_million) returning * into created;
 if job_kind='chat' then
  insert into public.messages(tenant_id,session_id,role,body) values(t,s,'user',payload->>'message');
  update public.sessions set title=case when title='เริ่มงานใหม่' then left(payload->>'message',100) else title end where id=s and tenant_id=t;
 end if;
 insert into public.run_events(tenant_id,run_id,event,data) values(t,created.id,'status','{"status":"queued"}');
 return created;
end $$;
grant execute on function public.start_run(uuid,uuid,uuid,text,uuid,jsonb) to authenticated;

create function public.cancel_run(t uuid,job uuid) returns void language plpgsql security definer set search_path = '' as $$
begin
 if not private.is_member(t) then raise exception 'ACCESS_DENIED'; end if;
 update public.runs set status='cancelled',updated_at=now(),lease_until=null
 where id=job and tenant_id=t and actor_id=auth.uid() and status in ('queued','running','waiting_approval');
end $$;
grant execute on function public.cancel_run(uuid,uuid) to authenticated;

create function public.configure_ai(t uuid,budget_cents integer,input_rate numeric,output_rate numeric) returns void
language plpgsql security definer set search_path = '' as $$
begin
 if not private.is_admin(t) or budget_cents not between 0 and 100000 or input_rate<=0 or output_rate<=0
 or input_rate>100000 or output_rate>100000 then raise exception 'ACCESS_DENIED'; end if;
 update public.tenants set monthly_ai_budget_cents=budget_cents,input_cents_per_million=input_rate,output_cents_per_million=output_rate where id=t;
 insert into public.audit_events(tenant_id,actor_id,event) values(t,auth.uid(),'ai_budget_updated');
end $$;
grant execute on function public.configure_ai(uuid,integer,numeric,numeric) to authenticated;

create function public.claim_run() returns public.runs language plpgsql security definer set search_path = '' as $$
declare job public.runs; begin
 -- An expired model invocation may have been billed or executed. Never replay it.
 update public.runs set status='interrupted',error_code='RUN_INTERRUPTED',updated_at=now(),lease_until=null
 where status='running' and lease_until<now();
 -- One transaction serializes the global free-pilot concurrency ceiling.
 perform pg_advisory_xact_lock(7312271);
 if (select count(*) from public.runs where status='running')>=2 then return null; end if;
 select * into job from public.runs where status='queued' and next_attempt_at<=now() order by created_at for update skip locked limit 1;
 if job.id is null then return null; end if;
 perform set_config('request.jwt.claim.sub',job.actor_id::text,true);
 if not private.is_member(job.tenant_id) or (job.kind='chat' and not private.session_access(job.tenant_id,job.session_id,true))
 or (job.kind<>'chat' and not private.document_access(job.tenant_id,job.document_id,true)) then
  update public.runs set status='cancelled',error_code='ACCESS_DENIED',updated_at=now() where id=job.id;
  return null;
 end if;
 update public.runs set status='running',lease_token=gen_random_uuid(),lease_until=now()+interval '120 seconds',attempts=attempts+1,updated_at=now()
 where id=job.id returning * into job;
 return job;
end $$;
grant execute on function public.claim_run() to service_role;

create function public.worker_user_context(t uuid,u uuid) returns jsonb language plpgsql security definer set search_path = '' as $$
declare m public.tenant_members; begin
 select * into m from public.tenant_members where tenant_id=t and user_id=u and active;
 if m.user_id is null or not exists(select 1 from public.tenants where id=t and active) then raise exception 'ACCESS_DENIED'; end if;
 return jsonb_build_object('tenant_id',t,'user_id',u,'role',m.role);
end $$;
grant execute on function public.worker_user_context(uuid,uuid) to service_role;

create function public.finish_run(job_id uuid,lease uuid,answer jsonb,error text,input_count integer,output_count integer)
returns boolean language plpgsql security definer set search_path = '' as $$
declare job public.runs; rates public.tenants; cost integer; begin
 select * into job from public.runs where id=job_id for update;
 if job.status<>'running' or job.lease_token is distinct from lease or job.lease_until<now() then return false; end if;
 perform set_config('request.jwt.claim.sub',job.actor_id::text,true);
 if not private.is_member(job.tenant_id) or (job.kind='chat' and not private.session_access(job.tenant_id,job.session_id,true))
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
grant execute on function public.finish_run(uuid,uuid,jsonb,text,integer,integer) to service_role;

-- Worker access to private OAuth records stays behind service-role-only RPCs.
create function public.read_google_grant(t uuid,u uuid) returns jsonb language sql security definer set search_path = '' as $$
 select to_jsonb(g) from private.google_grants g where tenant_id=t and user_id=u
$$;
create function public.write_google_grant(t uuid,u uuid,encrypted text,granted_scopes text[],subject text,grant_status text default 'ready') returns void
language plpgsql security definer set search_path = '' as $$ begin
 if grant_status not in ('ready','paused','reauth_required') then raise exception 'INVALID_STATE'; end if;
 insert into private.google_grants(tenant_id,user_id,ciphertext,scopes,google_subject,status)
 values(t,u,encrypted,granted_scopes,subject,grant_status) on conflict(tenant_id,user_id) do update
 set ciphertext=excluded.ciphertext,scopes=excluded.scopes,google_subject=excluded.google_subject,status=excluded.status,updated_at=now();
end $$;
create function public.delete_google_grant(t uuid,u uuid) returns void language sql security definer set search_path = '' as $$
 delete from private.google_grants where tenant_id=t and user_id=u
$$;
create function public.put_oauth_state(state_digest text,t uuid,u uuid,encrypted text,services text[]) returns void
language sql security definer set search_path = '' as $$
 insert into private.oauth_states(digest,tenant_id,user_id,verifier_ciphertext,services,expires_at)
 values(state_digest,t,u,encrypted,services,now()+interval '10 minutes')
$$;
create function public.consume_oauth_state(state_digest text) returns jsonb language sql security definer set search_path = '' as $$
 with used as(delete from private.oauth_states where digest=state_digest returning *)
 select to_jsonb(used) from used where expires_at>now()
$$;
grant execute on function public.read_google_grant(uuid,uuid) to service_role;
grant execute on function public.write_google_grant(uuid,uuid,text,text[],text,text) to service_role;
grant execute on function public.delete_google_grant(uuid,uuid) to service_role;
grant execute on function public.put_oauth_state(text,uuid,uuid,text,text[]) to service_role;
grant execute on function public.consume_oauth_state(text) to service_role;

create function public.worker_payload(job_id uuid,lease uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare job public.runs; s public.sessions; d public.documents; prepared public.documents; docs jsonb; memories jsonb; sources jsonb; skills jsonb; history jsonb; begin
 select * into job from public.runs where id=job_id and lease_token=lease and status='running' and lease_until>now();
 if job.id is null then raise exception 'RUN_INTERRUPTED'; end if;
 perform set_config('request.jwt.claim.sub',job.actor_id::text,true);
 if not private.is_member(job.tenant_id) then raise exception 'ACCESS_DENIED'; end if;
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
grant execute on function public.worker_payload(uuid,uuid) to service_role;

create function public.worker_store_document(job_id uuid,lease uuid,body text,chunks jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare job public.runs; begin
 select * into job from public.runs where id=job_id and lease_token=lease and status='running' and lease_until>now() for update;
 if job.id is null or job.kind<>'document' or length(body)>200000 or jsonb_array_length(chunks)>160 then raise exception 'ACCESS_DENIED'; end if;
 perform set_config('request.jwt.claim.sub',job.actor_id::text,true);
 if not private.document_access(job.tenant_id,job.document_id,true) then raise exception 'ACCESS_DENIED'; end if;
 delete from public.document_chunks where tenant_id=job.tenant_id and document_id=job.document_id;
 insert into public.document_chunks(tenant_id,document_id,ordinal,content,location,embedding)
 select job.tenant_id,job.document_id,(x->>'ordinal')::integer,x->>'content',x->>'location',
 case when x->'embedding' is not null then (x->>'embedding')::extensions.vector(768) else null end
 from jsonb_array_elements(chunks)x;
 update public.documents set extracted_text=body,status='ready',error_code=null where tenant_id=job.tenant_id and id=job.document_id;
end $$;
grant execute on function public.worker_store_document(uuid,uuid,text,jsonb) to service_role;

create function public.worker_search(job_id uuid,lease uuid,query_embedding extensions.vector(768))
returns table(document_id uuid,content text,location text) language plpgsql security definer set search_path = '' as $$
declare job public.runs; s public.sessions; begin
 select * into job from public.runs where id=job_id and lease_token=lease and status='running' and lease_until>now();
 if job.id is null or job.kind<>'chat' then raise exception 'ACCESS_DENIED'; end if;
 perform set_config('request.jwt.claim.sub',job.actor_id::text,true);
 if not private.session_access(job.tenant_id,job.session_id) then raise exception 'ACCESS_DENIED'; end if;
 select * into s from public.sessions where id=job.session_id and tenant_id=job.tenant_id;
 return query select d.id,c.content,c.location from public.document_chunks c join public.documents d
 on d.id=c.document_id and d.tenant_id=c.tenant_id where d.tenant_id=job.tenant_id and d.source_kind='upload' and d.status='ready'
 and d.id::text in(select jsonb_array_elements_text(coalesce(job.input->'documentIds','[]')))
 and private.document_access(d.tenant_id,d.id) and (s.visibility='private' or d.visibility='workspace' and d.workspace_id=s.workspace_id)
 and c.embedding is not null order by c.embedding operator(extensions.<=>) query_embedding limit 6;
end $$;
grant execute on function public.worker_search(uuid,uuid,extensions.vector) to service_role;

-- The built-in global PUBLIC default cannot be undone with a schema-only
-- default privilege change. Strip it explicitly; role-specific grants remain.
revoke execute on all functions in schema public from public,anon;

create function public.usage_summary(t uuid) returns jsonb language plpgsql security definer set search_path = '' as $$
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
 return jsonb_build_object('runs',jobs,'visibleBytes',case when administrator then used else own_bytes end,'ownBytes',own_bytes,'organizationSummary',administrator);
end $$;
revoke execute on function public.usage_summary(uuid) from public,anon;
grant execute on function public.usage_summary(uuid) to authenticated;
