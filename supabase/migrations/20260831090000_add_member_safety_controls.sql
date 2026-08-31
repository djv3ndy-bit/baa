create table if not exists public.user_blocks (
  blocker_id uuid not null references auth.users(id) on delete cascade,
  blocked_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker_id, blocked_id),
  constraint user_blocks_distinct_members check (blocker_id <> blocked_id)
);

create table if not exists public.user_reports (
  id uuid primary key default gen_random_uuid(),
  reporter_id uuid not null references auth.users(id) on delete cascade,
  reported_id uuid references auth.users(id) on delete set null,
  conversation_id text,
  conversation_kind text check (conversation_kind in ('discovery', 'application')),
  reason text not null check (reason in ('harassment', 'spam_or_scam')),
  details text,
  created_at timestamptz not null default now()
);

create index if not exists user_blocks_blocked_id_idx on public.user_blocks(blocked_id);
create index if not exists user_reports_created_at_idx on public.user_reports(created_at desc);
create index if not exists user_reports_reported_id_idx on public.user_reports(reported_id);

alter table public.user_blocks enable row level security;
alter table public.user_reports enable row level security;

revoke all on table public.user_blocks from anon, authenticated;
revoke all on table public.user_reports from anon, authenticated;
grant select, insert, delete on table public.user_blocks to authenticated;
grant insert on table public.user_reports to authenticated;
grant all on table public.user_blocks to service_role;
grant all on table public.user_reports to service_role;

drop policy if exists "Members can view relevant blocks" on public.user_blocks;
create policy "Members can view relevant blocks"
on public.user_blocks for select to authenticated
using ((select auth.uid()) in (blocker_id, blocked_id));

drop policy if exists "Members can block another account" on public.user_blocks;
create policy "Members can block another account"
on public.user_blocks for insert to authenticated
with check ((select auth.uid()) = blocker_id and blocker_id <> blocked_id);

drop policy if exists "Members can remove their own blocks" on public.user_blocks;
create policy "Members can remove their own blocks"
on public.user_blocks for delete to authenticated
using ((select auth.uid()) = blocker_id);

drop policy if exists "Members can submit safety reports" on public.user_reports;
create policy "Members can submit safety reports"
on public.user_reports for insert to authenticated
with check (
  (select auth.uid()) = reporter_id
  and reporter_id <> reported_id
  and char_length(coalesce(details, '')) <= 2000
);

create or replace function private.members_are_blocked(first_member uuid, second_member uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.user_blocks
    where (blocker_id = first_member and blocked_id = second_member)
       or (blocker_id = second_member and blocked_id = first_member)
  );
$$;

create or replace function private.message_is_allowed(message_body text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select char_length(trim(coalesce(message_body, ''))) between 1 and 2000
    and lower(message_body) !~ '\m(kill[[:space:]]+you|rape|n[i1]gg(er|a)|f[a@]ggot|k[i1]ke)\M';
$$;

revoke all on function private.members_are_blocked(uuid, uuid) from public;
revoke all on function private.message_is_allowed(text) from public;
grant execute on function private.members_are_blocked(uuid, uuid) to authenticated, service_role;
grant execute on function private.message_is_allowed(text) to authenticated, service_role;

drop policy if exists "Members can view permitted profiles" on public.profiles;
create policy "Members can view permitted profiles"
on public.profiles for select to authenticated
using (
  private.can_view_profile(id)
  and not private.members_are_blocked((select auth.uid()), id)
);

drop policy if exists "Members can view active jobs and owners can view theirs" on public.jobs;
create policy "Members can view active jobs and owners can view theirs"
on public.jobs for select to authenticated
using (
  owner_id = (select auth.uid())
  or (
    active = true
    and not private.members_are_blocked((select auth.uid()), owner_id)
  )
);

drop policy if exists "Participants can view discovery matches" on public.discovery_matches;
create policy "Participants can view discovery matches"
on public.discovery_matches for select to authenticated
using (
  ((select auth.uid()) = barista_id or (select auth.uid()) = cafe_id)
  and not private.members_are_blocked(barista_id, cafe_id)
);

drop policy if exists "Matched members can read discovery messages" on public.discovery_messages;
create policy "Matched members can read discovery messages"
on public.discovery_messages for select to authenticated
using (exists (
  select 1 from public.discovery_matches dm
  where dm.id = discovery_messages.match_id
    and ((select auth.uid()) = dm.barista_id or (select auth.uid()) = dm.cafe_id)
    and not private.members_are_blocked(dm.barista_id, dm.cafe_id)
));

drop policy if exists "Matched members can send discovery messages" on public.discovery_messages;
create policy "Matched members can send discovery messages"
on public.discovery_messages for insert to authenticated
with check (
  sender_id = (select auth.uid())
  and public.cafe_has_hiring_access((select auth.uid()))
  and private.message_is_allowed(body)
  and exists (
    select 1 from public.discovery_matches dm
    where dm.id = discovery_messages.match_id
      and ((select auth.uid()) = dm.barista_id or (select auth.uid()) = dm.cafe_id)
      and not private.members_are_blocked(dm.barista_id, dm.cafe_id)
  )
);

drop policy if exists "matched users can read messages" on public.messages;
create policy "matched users can read messages"
on public.messages for select to authenticated
using (exists (
  select 1 from public.applications application
  join public.jobs job on job.id = application.job_id
  where application.id = messages.application_id
    and application.status = 'matched'
    and ((select auth.uid()) = application.barista_id or (select auth.uid()) = job.owner_id)
    and not private.members_are_blocked(application.barista_id, job.owner_id)
));

drop policy if exists "matched users can send messages" on public.messages;
create policy "matched users can send messages"
on public.messages for insert to authenticated
with check (
  sender_id = (select auth.uid())
  and public.cafe_has_hiring_access((select auth.uid()))
  and private.message_is_allowed(body)
  and exists (
    select 1 from public.applications application
    join public.jobs job on job.id = application.job_id
    where application.id = messages.application_id
      and application.status = 'matched'
      and ((select auth.uid()) = application.barista_id or (select auth.uid()) = job.owner_id)
      and not private.members_are_blocked(application.barista_id, job.owner_id)
  )
);
