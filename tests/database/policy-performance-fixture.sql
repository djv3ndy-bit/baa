-- A separate in-memory fixture for the exact policies captured read-only from
-- production on 2026-09-07. Only columns relevant to these policies are needed.
create role anon;
create role authenticated;
create role service_role bypassrls;
create schema auth;
grant usage on schema public, auth to anon, authenticated, service_role;
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;
create table public.profiles(id uuid primary key, role text);
create table public.discovery_matches(id uuid primary key);
create table public.discovery_messages(
  id uuid primary key default gen_random_uuid(),
  match_id uuid references public.discovery_matches(id) on delete cascade,
  sender_id uuid references public.profiles(id) on delete cascade,
  created_at timestamptz default now()
);
create index discovery_messages_match_created_idx on public.discovery_messages(match_id, created_at);
create table public.notifications(id uuid primary key default gen_random_uuid(), recipient_id uuid, body text, read_at timestamptz);
create table public.notification_preferences(user_id uuid primary key, enabled boolean default true);
create table public.job_swipes(id uuid primary key default gen_random_uuid(), user_id uuid, direction text);
create table public.cafe_subscriptions(user_id uuid primary key, complimentary_access boolean default true, updated_at timestamptz default now());
create table public.product_events(id uuid primary key default gen_random_uuid(), user_id uuid, event_name text);

grant select on public.profiles to authenticated;
grant select on public.notifications, public.cafe_subscriptions to authenticated;
grant update(read_at) on public.notifications to authenticated;
grant select, insert, update on public.notification_preferences, public.job_swipes to authenticated;
grant insert(user_id, complimentary_access), update(complimentary_access, updated_at) on public.cafe_subscriptions to authenticated;
grant insert on public.product_events to authenticated;
grant select, update on public.cafe_subscriptions to service_role;
-- Match the remaining default non-DML grants, which this migration does not alter.
grant truncate, references, trigger on public.notifications, public.notification_preferences, public.job_swipes, public.cafe_subscriptions, public.product_events to anon, authenticated, service_role;

alter table public.notifications enable row level security;
alter table public.notification_preferences enable row level security;
alter table public.job_swipes enable row level security;
alter table public.cafe_subscriptions enable row level security;
alter table public.product_events enable row level security;
create policy "Users can view their notifications" on public.notifications for select to authenticated using (recipient_id = auth.uid());
create policy "Users can mark their notifications read" on public.notifications for update to authenticated using (recipient_id = auth.uid()) with check (recipient_id = auth.uid());
create policy "Users can view notification preferences" on public.notification_preferences for select to authenticated using (user_id = auth.uid());
create policy "Users can create notification preferences" on public.notification_preferences for insert to authenticated with check (user_id = auth.uid());
create policy "Users can update notification preferences" on public.notification_preferences for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "Users manage their own job swipes" on public.job_swipes for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "Cafe owners can view own subscription" on public.cafe_subscriptions for select to authenticated using (user_id = auth.uid());
create policy "Cafe owners can create own complimentary access" on public.cafe_subscriptions for insert to authenticated with check (
  user_id = (select auth.uid()) and complimentary_access = true and exists (select 1 from public.profiles p where p.id = (select auth.uid()) and p.role = 'cafe_owner_manager')
);
create policy "Cafe owners can maintain own complimentary access" on public.cafe_subscriptions for update to authenticated using (
  user_id = (select auth.uid()) and exists (select 1 from public.profiles p where p.id = (select auth.uid()) and p.role = 'cafe_owner_manager')
) with check (
  user_id = (select auth.uid()) and complimentary_access = true and exists (select 1 from public.profiles p where p.id = (select auth.uid()) and p.role = 'cafe_owner_manager')
);
create policy "Members can record own product events" on public.product_events for insert to authenticated with check (user_id = auth.uid());

insert into profiles values
 ('00000000-0000-4000-8000-000000000001', 'barista'),
 ('00000000-0000-4000-8000-000000000002', 'cafe_owner_manager');
insert into notifications(recipient_id, body) values
 ('00000000-0000-4000-8000-000000000001', 'Synthetic A'),
 ('00000000-0000-4000-8000-000000000002', 'Synthetic B');
insert into notification_preferences(user_id) select id from profiles;
insert into job_swipes(user_id, direction) select id, 'right' from profiles;
insert into cafe_subscriptions(user_id) select id from profiles;
