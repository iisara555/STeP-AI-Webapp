-- Exact allowlist only. Client roles never receive decrypted server secrets.
create function public.read_server_runtime_config() returns jsonb
language sql security definer set search_path='' as $$
 select coalesce(jsonb_object_agg(m.env_name,v.decrypted_secret),'{}'::jsonb)
 from (values
  ('step_ai_provider','AI_PROVIDER'),
  ('step_openrouter_api_key','OPENROUTER_API_KEY'),
  ('step_openrouter_model','OPENROUTER_MODEL'),
  ('step_openrouter_provider','OPENROUTER_PROVIDER'),
  ('step_worker_secret','WORKER_SECRET'),
  ('step_app_origin','APP_ORIGIN')
 )m(vault_name,env_name)
 join vault.decrypted_secrets v on v.name=m.vault_name
$$;
revoke all on function public.read_server_runtime_config() from public,anon,authenticated;
grant execute on function public.read_server_runtime_config() to service_role;


