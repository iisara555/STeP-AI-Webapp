-- Organization files are imported only by an operator into one tenant, in one
-- transaction. No source body or member identity is written to audit metadata.
create function public.import_harness_pack(t uuid,pack jsonb) returns void
language plpgsql security definer set search_path='' as $$
begin
 if not exists(select 1 from public.tenants where id=t and active)
 or pack->>'format'<>'step-harness-pack/v1' or pack->>'sourceCommit' !~ '^[a-f0-9]{40}$'
 or octet_length(pack::text)>20971520 or jsonb_typeof(pack->'sources')<>'array'
 or jsonb_typeof(pack->'skills')<>'array' or jsonb_array_length(pack->'sources')>500
 or jsonb_array_length(pack->'skills')>200 then raise exception 'INVALID_REQUEST'; end if;
 if not exists(select 1 from jsonb_array_elements(pack->'sources')x where x->>'source_key'='__authority')
 or not exists(select 1 from jsonb_array_elements(pack->'sources')x where x->>'source_key'='__organization')
 then raise exception 'HARNESS_INCOMPLETE'; end if;
 perform 1 from public.tenants where id=t for update;
 if exists(select 1 from public.runs where tenant_id=t and status in ('queued','running','waiting_approval'))
 then raise exception 'RUN_ACTIVE'; end if;
 delete from public.skills where tenant_id=t;
 delete from public.knowledge_sources where tenant_id=t;
 insert into public.knowledge_sources(tenant_id,source_key,title,body,source_version,provenance)
 select t,x.source_key,x.title,x.body,x.source_version,x.provenance from jsonb_to_recordset(pack->'sources')
 as x(source_key text,title text,body text,source_version text,provenance jsonb);
 insert into public.skills(tenant_id,skill_key,title,description,instructions,metadata,source_version)
 select t,x.skill_key,x.title,x.description,x.instructions,x.metadata,x.source_version from jsonb_to_recordset(pack->'skills')
 as x(skill_key text,title text,description text,instructions text,metadata jsonb,source_version text);
 insert into public.audit_events(tenant_id,event) values(t,'harness_pack_imported');
end $$;
revoke execute on function public.import_harness_pack(uuid,jsonb) from public,anon,authenticated;
grant execute on function public.import_harness_pack(uuid,jsonb) to service_role;
