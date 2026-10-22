-- Supabase grants EXECUTE to authenticated/anon by default in public, in
-- addition to PostgreSQL's PUBLIC default. Revoke BOTH defaults and existing
-- ACLs; retain an explicit list of authenticated, identity-checking operations.
alter default privileges revoke execute on functions from public,anon,authenticated;
alter default privileges in schema public revoke execute on functions from public,anon,authenticated;
revoke execute on all functions in schema public from public,anon,authenticated;
grant execute on all functions in schema public to service_role;
grant execute on function
 public.accept_invites(),
 public.invite_member(uuid,text,text),
 public.set_member_active(uuid,uuid,boolean),
 public.add_workspace_member(uuid,uuid,text,text),
 public.create_document(uuid,uuid,text,text,text,bigint,uuid),
 public.save_draft(uuid,uuid,integer,text),
 public.match_documents(uuid,uuid,extensions.vector,integer),
 public.start_run(uuid,uuid,uuid,text,uuid,jsonb),
 public.cancel_run(uuid,uuid),
 public.configure_ai(uuid,integer,numeric,numeric),
 public.usage_summary(uuid),
 public.save_receipt_review(uuid,uuid,uuid,jsonb,boolean)
 to authenticated;
revoke execute on all functions in schema private from public,anon,authenticated;
grant execute on function private.is_member(uuid),private.is_admin(uuid),
 private.owns_workspace(uuid,uuid),private.workspace_access(uuid,uuid,boolean),
 private.resource_access(uuid,uuid,uuid,text,boolean),private.session_access(uuid,uuid,boolean),
 private.document_access(uuid,uuid,boolean) to authenticated,service_role;
-- These are service-only tables; no client policies are appropriate.
alter table private.google_grants enable row level security;
alter table private.oauth_states enable row level security;

drop policy members_read on public.tenant_members;
drop policy members_workspace_invite on public.tenant_members;
create policy members_read on public.tenant_members for select to authenticated
 using(private.is_member(tenant_id) and (active or user_id=(select auth.uid()) or private.is_admin(tenant_id)));

create index audit_tenant on public.audit_events(tenant_id);
create index audit_actor on public.audit_events(actor_id);
create index documents_owner_fk on public.documents(owner_id);
create index documents_parent on public.documents(tenant_id,derived_from);
create index memories_owner_fk on public.memories(owner_id);
create index receipt_run on public.receipt_reviews(run_id);
create index receipt_document on public.receipt_reviews(tenant_id,document_id);
create index receipt_owner on public.receipt_reviews(tenant_id,owner_id);
create index runs_actor on public.runs(tenant_id,actor_id);
create index runs_document on public.runs(tenant_id,document_id);
create index runs_session on public.runs(tenant_id,session_id);
create index sessions_owner_fk on public.sessions(owner_id);
create index sessions_workspace on public.sessions(tenant_id,workspace_id);
create index invites_creator on public.tenant_invites(created_by);
create index workspace_members_tenant_user on public.workspace_members(tenant_id,user_id);
create index workspace_members_tenant_workspace on public.workspace_members(tenant_id,workspace_id);
create index workspaces_creator on public.workspaces(created_by);
