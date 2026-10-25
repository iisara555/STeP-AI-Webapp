-- Personal profile and assistant preferences, as in Desktop Settings. Each row belongs to one employee in one
-- tenant; only that employee can read or change it. Administrators do not see it, and nothing here grants access.
create table public.member_profiles (
  tenant_id uuid not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  display_name text not null default '' check (length(display_name) <= 60 and display_name !~ '[\r\n]'),
  team text not null default '' check (team ~ '^[a-z0-9-]{0,20}$'),
  avatar text not null default '' check (avatar = '' or avatar ~ '^avatar-[0-9]{2}$'),
  assistant_name text not null default '' check (length(assistant_name) <= 60 and assistant_name !~ '[\r\n]'),
  chat_language text not null default 'auto' check (chat_language in ('auto','th','en')),
  personality text not null default 'coworker'
    check (personality in ('coworker','professional','concise','custom')),
  assistant_tone text not null default '' check (length(assistant_tone) <= 300 and assistant_tone !~ '[\r\n]'),
  interaction_style text not null default 'standard' check (interaction_style in ('standard','witty','ob-oon')),
  language_style text not null default 'standard' check (language_style in ('standard','northern-thai')),
  updated_at timestamptz not null default now(),
  primary key (tenant_id,user_id),
  foreign key (tenant_id,user_id) references public.tenant_members(tenant_id,user_id) on delete cascade
);
create index member_profiles_user on public.member_profiles(user_id);
alter table public.member_profiles enable row level security;
revoke all on public.member_profiles from anon,authenticated;
grant select on public.member_profiles to authenticated;
grant insert(tenant_id,user_id,display_name,team,avatar,assistant_name,chat_language,personality,assistant_tone,
  interaction_style,language_style,updated_at) on public.member_profiles to authenticated;
grant update(display_name,team,avatar,assistant_name,chat_language,personality,assistant_tone,
  interaction_style,language_style,updated_at) on public.member_profiles to authenticated;
grant all on public.member_profiles to service_role;
create policy member_profiles_read on public.member_profiles for select to authenticated
 using(user_id=(select auth.uid()) and private.is_member(tenant_id));
create policy member_profiles_insert on public.member_profiles for insert to authenticated
 with check(user_id=(select auth.uid()) and private.is_member(tenant_id));
create policy member_profiles_update on public.member_profiles for update to authenticated
 using(user_id=(select auth.uid()) and private.is_member(tenant_id))
 with check(user_id=(select auth.uid()) and private.is_member(tenant_id));

-- Desktop memories also record project context, and their type can be corrected after saving.
alter table public.memories drop constraint memories_kind_check;
alter table public.memories add constraint memories_kind_check
  check (kind in ('preference','reference','feedback','project'));
grant update(kind) on public.memories to authenticated;
