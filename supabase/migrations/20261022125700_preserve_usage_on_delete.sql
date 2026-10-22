-- A client cannot mark pending uploads deleted to bypass the pending-file cap,
-- or cascade workspace metadata away while leaving untracked Storage objects.
revoke update(deleted_at) on public.documents from authenticated;
revoke delete on public.workspaces from authenticated;

-- Deleting content must not refund a call that may already have been billed.
-- Retain only the job's accounting metadata; erase its input/output and detach
-- it from the deleted resource. Normal RLS hides these detached accounting rows.
alter table public.runs add column purged boolean not null default false;
alter table public.runs drop constraint runs_check;
alter table public.runs add constraint runs_resource_check check(
 (purged and session_id is null and document_id is null and input='{}'::jsonb and result is null and partial='')
 or (not purged and ((kind='chat' and session_id is not null) or (kind in('document','receipt') and document_id is not null)))
);
alter table public.runs drop constraint runs_tenant_id_session_id_fkey;
alter table public.runs drop constraint runs_tenant_id_document_id_fkey;
alter table public.runs add foreign key(tenant_id,session_id) references public.sessions(tenant_id,id);
alter table public.runs add foreign key(tenant_id,document_id) references public.documents(tenant_id,id);

create function private.purge_resource_jobs() returns trigger language plpgsql security definer set search_path='' as $$
begin
 with purged_jobs as (
  update public.runs set purged=true,session_id=null,document_id=null,input='{}',result=null,partial='',
   status=case when status in('queued','running','waiting_approval')then 'cancelled'else status end,
   lease_until=null,lease_token=null,updated_at=now()
  where tenant_id=old.tenant_id and ((tg_table_name='sessions' and session_id=old.id)
    or (tg_table_name='documents' and document_id=old.id)) returning id
 ) delete from public.run_events where run_id in(select id from purged_jobs);
 return old;
end $$;
revoke execute on function private.purge_resource_jobs() from public,anon,authenticated;
create trigger session_purge_jobs before delete on public.sessions
for each row execute function private.purge_resource_jobs();
create trigger document_purge_jobs before delete on public.documents
for each row execute function private.purge_resource_jobs();
