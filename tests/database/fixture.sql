-- Relevant production-shaped schema, policies and trigger behavior.
-- All identities are synthetic and live only in the in-memory PostgreSQL engine.
create role anon;
create role authenticated;
create role service_role bypassrls;
create schema auth;
create schema private;
grant usage on schema public,auth,private to anon,authenticated,service_role;
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid;
$$;
create table auth.users(id uuid primary key,raw_user_meta_data jsonb);
create table public.profiles(
  id uuid primary key references auth.users(id) on delete cascade,
  role text not null check(role in ('barista','cafe_owner_manager')),
  display_name text,cafe_name text,avatar_url text,location text,bio text,
  skills text[] default '{}',availability text,experience text,pay_expectation text,
  cafe_address text,open_hours text,shop_type text,barista_preferences text[] default '{}',
  is_discoverable boolean default false,visible_to_cafes boolean default false,
  suspended_at timestamptz,verification_status text default 'unverified',trust_updated_at timestamptz
);
create table public.jobs(
  id uuid primary key default gen_random_uuid(),owner_id uuid references public.profiles(id),
  title text,location text not null,address_line1 text,address_line2 text,city text,state text,postal_code text,
  active boolean default true,description text
);
create table public.applications(
  id uuid primary key default gen_random_uuid(),job_id uuid references public.jobs(id),
  barista_id uuid references public.profiles(id),status text default 'interested'
    check(status in ('interested','matched','declined','withdrawn')),
  note text,created_at timestamptz default now(),unique(job_id,barista_id)
);
create table public.discovery_matches(id uuid primary key default gen_random_uuid(),barista_id uuid references public.profiles(id),cafe_id uuid references public.profiles(id));
create table public.user_blocks(blocker_id uuid,blocked_id uuid);
create function private.members_are_blocked(a uuid,b uuid) returns boolean language sql stable security definer set search_path='' as $$
  select exists(select 1 from public.user_blocks where (blocker_id=a and blocked_id=b) or (blocker_id=b and blocked_id=a));
$$;
create table public.discovery_messages(id uuid primary key default gen_random_uuid(),match_id uuid references public.discovery_matches(id),sender_id uuid references public.profiles(id),body text);
create table public.notifications(
  id uuid primary key default gen_random_uuid(),recipient_id uuid references public.profiles(id),actor_id uuid references public.profiles(id),
  type text,title text,body text,application_id uuid references public.applications(id),created_at timestamptz default now(),read_at timestamptz
);
create table public.cafe_subscriptions(user_id uuid primary key references public.profiles(id),complimentary_access boolean default true);
create table public.profile_demographics(user_id uuid primary key references public.profiles(id),date_of_birth date);
grant select,insert,update,delete on public.profiles,public.jobs,public.applications,public.discovery_messages,public.discovery_matches to authenticated;
grant select,update on public.notifications to authenticated;
grant select on public.cafe_subscriptions to authenticated;
grant all on all tables in schema public to service_role;
alter table public.profiles enable row level security;
create policy profile_read on public.profiles for select to authenticated using (true);
create policy profile_insert on public.profiles for insert to authenticated with check(id=auth.uid());
create policy profile_update on public.profiles for update to authenticated using(id=auth.uid()) with check(id=auth.uid());
alter table public.jobs enable row level security;
create policy jobs_read on public.jobs for select to authenticated using(active or owner_id=auth.uid());
create policy jobs_insert on public.jobs for insert to authenticated with check(owner_id=auth.uid() and exists(select 1 from public.profiles p where p.id=auth.uid() and p.role='cafe_owner_manager' and p.suspended_at is null));
create policy jobs_update on public.jobs for update to authenticated using(owner_id=auth.uid()) with check(owner_id=auth.uid());
create function public.cafe_has_hiring_access(target_user_id uuid) returns boolean language sql stable set search_path='' as $$
  select target_user_id=auth.uid() and (coalesce((select role from public.profiles where id=target_user_id),'') <> 'cafe_owner_manager'
  or exists(select 1 from public.cafe_subscriptions where user_id=target_user_id and complimentary_access));
$$;
alter table public.applications enable row level security;
create policy "Complete baristas can apply to jobs" on public.applications for insert to authenticated with check(true);
create policy application_read on public.applications for select to authenticated using(barista_id=auth.uid() or exists(select 1 from public.jobs j where j.id=applications.job_id and j.owner_id=auth.uid()));
create policy application_update on public.applications for update to authenticated
using(barista_id=auth.uid() or exists(select 1 from public.jobs j where j.id=applications.job_id and j.owner_id=auth.uid()))
with check(((barista_id=auth.uid() and status='withdrawn') or exists(select 1 from public.jobs j where j.id=applications.job_id and j.owner_id=auth.uid())) and public.cafe_has_hiring_access(auth.uid()));
alter table public.discovery_matches enable row level security;
create policy match_read on public.discovery_matches for select to authenticated using(auth.uid() in (barista_id,cafe_id) and not private.members_are_blocked(barista_id,cafe_id));
alter table public.discovery_messages enable row level security;
create policy discovery_message_insert on public.discovery_messages for insert to authenticated with check(sender_id=auth.uid() and exists(select 1 from public.discovery_matches where id=match_id and auth.uid() in (barista_id,cafe_id)));
create policy discovery_message_read on public.discovery_messages for select to authenticated using(exists(select 1 from public.discovery_matches where id=match_id));
alter table public.notifications enable row level security;
create policy notification_read on public.notifications for select to authenticated using(recipient_id=auth.uid());
create policy notification_update on public.notifications for update to authenticated using(recipient_id=auth.uid()) with check(recipient_id=auth.uid());
alter table public.profile_demographics enable row level security;
alter table public.cafe_subscriptions enable row level security;
create policy subscription_read on public.cafe_subscriptions for select to authenticated using(user_id=auth.uid());

create function public.profile_meets_visibility_requirements(p public.profiles) returns boolean language sql immutable as $$select false$$;
create function public.enforce_profile_discoverability() returns trigger language plpgsql security definer set search_path=public as $$
begin
  if new.suspended_at is not null or not public.profile_meets_visibility_requirements(new) then new.is_discoverable:=false; end if;
  new.trust_updated_at:=now(); return new;
end;
$$;
create trigger trg_enforce_profile_discoverability before insert or update on public.profiles for each row execute function public.enforce_profile_discoverability();

insert into auth.users(id,raw_user_meta_data) values
 ('00000000-0000-4000-8000-000000000001','{}'),
 ('00000000-0000-4000-8000-000000000002','{}'),
 ('00000000-0000-4000-8000-000000000003','{}'),
 ('00000000-0000-4000-8000-000000000004','{}');
insert into public.profiles(id,role,display_name,cafe_name,avatar_url,location,bio,skills,availability,experience,pay_expectation,cafe_address,open_hours,shop_type,barista_preferences) values
 ('00000000-0000-4000-8000-000000000001','barista','Barista One',null,'https://example.com/a','Miami, FL','Coffee','{Espresso}','Morning','One year','$20',null,null,null,'{}'),
 ('00000000-0000-4000-8000-000000000002','cafe_owner_manager',null,'Cafe One','https://example.com/b','Miami, FL','Coffee','{}',null,null,null,'123 Example St','Monday 9-5','Specialty','{Espresso}'),
 ('00000000-0000-4000-8000-000000000003','barista','Barista Two',null,'https://example.com/c','Miami, FL','Coffee','{Espresso}','Morning','One year','$20',null,null,null,'{}'),
 ('00000000-0000-4000-8000-000000000004','cafe_owner_manager',null,'Cafe Two','https://example.com/d','Miami, FL','Coffee','{}',null,null,null,'456 Example St','Monday 9-5','Specialty','{Espresso}');
insert into public.cafe_subscriptions(user_id) values('00000000-0000-4000-8000-000000000002'),('00000000-0000-4000-8000-000000000004');
insert into public.jobs(id,owner_id,title,location,address_line1,city,state,postal_code) values
 ('10000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002','Barista','Miami, FL','123 Example St','Miami','FL','33101'),
 ('10000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000004','Barista','Miami, FL','456 Example St','Miami','FL','33101'),
 ('10000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000002','Legacy job','Miami',null,null,null,null);
insert into public.discovery_matches(id,barista_id,cafe_id) values
 ('20000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002'),
 ('20000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000002');
create function private.handle_new_email_profile() returns trigger language plpgsql as $$begin return new; end$$;
create trigger on_auth_user_created_create_profile after insert on auth.users for each row execute function private.handle_new_email_profile();

-- Supabase may automatically grant broad privileges on newly created tables.
-- The repair must explicitly remove these rather than passing only on an empty
-- local PostgreSQL privilege baseline.
alter default privileges in schema public grant all on tables to anon,authenticated,service_role;
create publication supabase_realtime for table public.notifications;
