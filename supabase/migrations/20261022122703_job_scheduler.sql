create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;
create function private.dispatch_due_jobs() returns void language plpgsql security definer set search_path = '' as $$
declare endpoint text; secret text; begin
 delete from private.oauth_states where expires_at<now();
 if not exists(select 1 from public.runs where status='queued' and next_attempt_at<=now()
  or status='running' and lease_until<now()) then return; end if;
 select decrypted_secret into endpoint from vault.decrypted_secrets where name='step_worker_url' limit 1;
 select decrypted_secret into secret from vault.decrypted_secrets where name='step_worker_secret' limit 1;
 if endpoint is null or secret is null then return; end if;
 -- Only the project's own worker can receive the dispatch secret.
 if endpoint !~ '^https://[a-z0-9]{20}\.supabase\.co/functions/v1/worker$' then return; end if;
 perform net.http_post(url:=endpoint,headers:=jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||secret),
 body:='{}'::jsonb,timeout_milliseconds:=110000);
 perform net.http_post(url:=endpoint,headers:=jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||secret),
 body:='{}'::jsonb,timeout_milliseconds:=110000);
end $$;
revoke all on function private.dispatch_due_jobs() from public,anon,authenticated;
select cron.schedule('step-dispatch','* * * * *','select private.dispatch_due_jobs()');

create function private.cleanup_metadata() returns void language plpgsql security definer set search_path = '' as $$
begin
 delete from public.run_events where created_at<now()-interval '30 days';
 delete from private.oauth_states where expires_at<now();
end $$;
revoke all on function private.cleanup_metadata() from public,anon,authenticated;
select cron.schedule('step-cleanup','17 19 * * *','select private.cleanup_metadata()');
