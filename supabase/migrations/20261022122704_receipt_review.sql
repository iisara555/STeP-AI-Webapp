create table public.receipt_reviews (
 id uuid primary key default gen_random_uuid(),tenant_id uuid not null,
 owner_id uuid not null references auth.users(id),run_id uuid not null references public.runs(id) on delete cascade,
 document_id uuid not null,review jsonb not null check(length(review::text)<=50000),
 source_confirmed boolean not null check(source_confirmed),reviewed_at timestamptz not null default now(),
 foreign key(tenant_id,owner_id) references public.tenant_members(tenant_id,user_id),
 foreign key(tenant_id,document_id) references public.documents(tenant_id,id) on delete cascade,
 unique(owner_id,run_id)
);
alter table public.receipt_reviews enable row level security;
revoke all on public.receipt_reviews from public,anon,authenticated;
grant select on public.receipt_reviews to authenticated;
grant all on public.receipt_reviews to service_role;
create policy review_read on public.receipt_reviews for select to authenticated
 using(private.is_member(tenant_id) and owner_id=(select auth.uid()));
create function public.save_receipt_review(t uuid,r uuid,d uuid,reviewed jsonb,source_checked boolean)
returns public.receipt_reviews language plpgsql security definer set search_path = '' as $$
declare result public.receipt_reviews; begin
 if source_checked is distinct from true or length(reviewed::text)>50000 or not private.document_access(t,d)
 or not exists(select 1 from public.runs where id=r and tenant_id=t and document_id=d
 and actor_id=auth.uid() and kind='receipt' and status='completed') then raise exception 'ACCESS_DENIED'; end if;
 insert into public.receipt_reviews(tenant_id,owner_id,run_id,document_id,review,source_confirmed)
 values(t,auth.uid(),r,d,reviewed,true) on conflict(owner_id,run_id) do update
 set review=excluded.review,source_confirmed=true,reviewed_at=now() returning * into result;
 return result;
end $$;
revoke execute on function public.save_receipt_review(uuid,uuid,uuid,jsonb,boolean) from public,anon;
grant execute on function public.save_receipt_review(uuid,uuid,uuid,jsonb,boolean) to authenticated;
