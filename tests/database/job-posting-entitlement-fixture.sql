-- Minimal production-shaped schema for the cafe job entitlement migration.
-- All identities and Stripe IDs are synthetic and exist only in PGlite.

create role anon;
create role authenticated;
create role service_role bypassrls;

create schema auth;
create schema private;
grant usage on schema public, auth, private to anon, authenticated, service_role;

create function auth.uid()
returns uuid
language sql
stable
as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;

create table public.profiles (
  id uuid primary key,
  role text not null check (role in ('barista', 'cafe_owner_manager')),
  suspended_at timestamptz
);

create table public.cafe_subscriptions (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  status text not null default 'trialing'
    check (status in ('trialing', 'active', 'past_due', 'canceled', 'expired')),
  trial_started_at timestamptz not null default now(),
  trial_ends_at timestamptz not null default (now() + interval '30 days'),
  current_period_end timestamptz,
  stripe_customer_id text,
  stripe_subscription_id text,
  cancel_at_period_end boolean not null default false,
  complimentary_access boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.user_blocks (
  blocker_id uuid not null references public.profiles(id),
  blocked_id uuid not null references public.profiles(id),
  primary key (blocker_id, blocked_id)
);

create function private.members_are_blocked(first_member uuid, second_member uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.user_blocks block
    where (block.blocker_id = first_member and block.blocked_id = second_member)
       or (block.blocker_id = second_member and block.blocked_id = first_member)
  );
$$;

grant execute on function private.members_are_blocked(uuid, uuid) to authenticated;

create table public.jobs (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles(id) on delete cascade,
  title text not null,
  location text not null,
  city text,
  state text,
  postal_code text,
  description text not null default '',
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index jobs_owner_id_idx on public.jobs(owner_id);

grant select, insert, update, delete on table public.jobs to authenticated;
grant references, trigger, truncate on table public.jobs to anon, authenticated;
grant select on table public.profiles, public.cafe_subscriptions to authenticated;
grant all on table public.profiles, public.cafe_subscriptions, public.user_blocks to service_role;

alter table public.profiles enable row level security;
create policy "Members can read profiles"
on public.profiles for select to authenticated using (true);

alter table public.cafe_subscriptions enable row level security;
create policy "Cafe owners can read their subscription"
on public.cafe_subscriptions for select to authenticated
using (user_id = (select auth.uid()));

-- This is the applied production shape before the repair: self-only and
-- SECURITY INVOKER, but referencing no owner-pause column because that older
-- migration was skipped in production.
create function public.cafe_has_hiring_access(target_user_id uuid)
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select target_user_id = (select auth.uid()) and (
    coalesce((
      select profile.role
      from public.profiles profile
      where profile.id = target_user_id
    ), '') <> 'cafe_owner_manager'
    or exists (
      select 1
      from public.cafe_subscriptions subscription
      where subscription.user_id = target_user_id
        and (
          subscription.complimentary_access is true
          or subscription.status = 'active'
          or (
            subscription.status = 'trialing'
            and subscription.trial_ends_at > now()
          )
        )
    )
  );
$$;

grant execute on function public.cafe_has_hiring_access(uuid) to authenticated, service_role;

alter table public.jobs enable row level security;
create policy "Cafe owners can create their own jobs"
on public.jobs for insert to authenticated
with check (
  owner_id = (select auth.uid())
  and exists (
    select 1
    from public.profiles profile
    where profile.id = (select auth.uid())
      and profile.role = 'cafe_owner_manager'
      and profile.suspended_at is null
  )
);
create policy "Cafe owners can update their jobs"
on public.jobs for update to authenticated
using (owner_id = (select auth.uid()))
with check (owner_id = (select auth.uid()));
create policy "Cafe owners can delete their jobs"
on public.jobs for delete to authenticated
using (owner_id = (select auth.uid()));
create policy "Members can view active jobs and owners can view theirs"
on public.jobs for select to authenticated
using (
  owner_id = (select auth.uid())
  or (
    active is true
    and not private.members_are_blocked((select auth.uid()), owner_id)
  )
);

create table public.applications (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.jobs(id) on delete cascade,
  barista_id uuid not null references public.profiles(id) on delete cascade,
  status text not null default 'interested'
    check (status in ('interested', 'matched', 'declined', 'withdrawn')),
  created_at timestamptz not null default now(),
  unique (job_id, barista_id)
);

create index applications_job_id_idx on public.applications(job_id);

grant select, insert, update on table public.applications to authenticated;
alter table public.applications enable row level security;
create policy "Complete baristas can apply to jobs"
on public.applications for insert to authenticated
with check (
  status = 'interested'
  and barista_id = (select auth.uid())
  and exists (
    select 1
    from public.profiles profile
    where profile.id = (select auth.uid())
      and profile.role = 'barista'
      and profile.suspended_at is null
  )
  and exists (
    select 1
    from public.jobs job
    where job.id = applications.job_id
      and job.active is true
  )
);
create policy "Participants can view relevant applications"
on public.applications for select to authenticated
using (
  barista_id = (select auth.uid())
  or exists (
    select 1
    from public.jobs job
    where job.id = applications.job_id
      and job.owner_id = (select auth.uid())
  )
);
create policy "Participants can update relevant applications"
on public.applications for update to authenticated
using (
  barista_id = (select auth.uid())
  or exists (
    select 1
    from public.jobs job
    where job.id = applications.job_id
      and job.owner_id = (select auth.uid())
  )
)
with check (
  (
    barista_id = (select auth.uid())
    and status = 'withdrawn'
  )
  or exists (
    select 1
    from public.jobs job
    where job.id = applications.job_id
      and job.owner_id = (select auth.uid())
  )
  and public.cafe_has_hiring_access((select auth.uid()))
);

create function private.message_is_allowed(candidate text)
returns boolean
language sql
immutable
as $$
  select candidate is not null and btrim(candidate) <> '' and length(candidate) <= 5000;
$$;

grant execute on function private.message_is_allowed(text) to authenticated;

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null references public.applications(id) on delete cascade,
  sender_id uuid not null references public.profiles(id) on delete cascade,
  body text not null,
  created_at timestamptz not null default now(),
  read_at timestamptz
);

grant select, insert on table public.messages to authenticated;
alter table public.messages enable row level security;
create policy "matched users can read messages"
on public.messages for select to authenticated
using (
  exists (
    select 1
    from public.applications application
    join public.jobs job on job.id = application.job_id
    where application.id = messages.application_id
      and application.status = 'matched'
      and (
        (select auth.uid()) = application.barista_id
        or (select auth.uid()) = job.owner_id
      )
      and not private.members_are_blocked(application.barista_id, job.owner_id)
  )
);
create policy "matched users can send messages"
on public.messages for insert to authenticated
with check (
  sender_id = (select auth.uid())
  and public.cafe_has_hiring_access((select auth.uid()))
  and private.message_is_allowed(body)
  and exists (
    select 1
    from public.applications application
    join public.jobs job on job.id = application.job_id
    where application.id = messages.application_id
      and application.status = 'matched'
      and (
        (select auth.uid()) = application.barista_id
        or (select auth.uid()) = job.owner_id
      )
      and not private.members_are_blocked(application.barista_id, job.owner_id)
  )
);

-- Exercise the migration's explicit revokes even under broad Supabase-style
-- defaults for newly created private tables.
alter default privileges in schema private
grant all on tables to anon, authenticated, service_role;

insert into public.profiles (id, role) values
  ('00000000-0000-4000-8000-000000000001', 'barista'),
  ('00000000-0000-4000-8000-000000000002', 'cafe_owner_manager'),
  ('00000000-0000-4000-8000-000000000003', 'cafe_owner_manager'),
  ('00000000-0000-4000-8000-000000000004', 'cafe_owner_manager'),
  ('00000000-0000-4000-8000-000000000005', 'cafe_owner_manager'),
  ('00000000-0000-4000-8000-000000000006', 'cafe_owner_manager'),
  ('00000000-0000-4000-8000-000000000007', 'cafe_owner_manager'),
  ('00000000-0000-4000-8000-000000000008', 'cafe_owner_manager'),
  ('00000000-0000-4000-8000-000000000009', 'barista'),
  ('00000000-0000-4000-8000-000000000010', 'cafe_owner_manager'),
  ('00000000-0000-4000-8000-000000000011', 'cafe_owner_manager');

insert into public.cafe_subscriptions (
  user_id,
  status,
  trial_ends_at,
  current_period_end,
  stripe_customer_id,
  stripe_subscription_id,
  complimentary_access
) values
  -- Live-like legacy cafe: a default local trial and complimentary access are
  -- deliberately not paid entitlement without a Stripe subscription ID.
  ('00000000-0000-4000-8000-000000000002', 'trialing', '2099-01-01', null, null, null, true),
  -- Active remains entitled even when the recorded period end is in the past;
  -- Stripe status is authoritative for active subscriptions.
  ('00000000-0000-4000-8000-000000000003', 'active', '2000-01-01', '2000-01-01', 'cus_active_synthetic', 'sub_active_synthetic', false),
  ('00000000-0000-4000-8000-000000000004', 'trialing', '2099-01-01', null, null, null, true),
  ('00000000-0000-4000-8000-000000000005', 'trialing', '2099-01-01', null, 'cus_trial_synthetic', 'sub_trial_synthetic', false),
  ('00000000-0000-4000-8000-000000000006', 'trialing', '2000-01-01', null, 'cus_expired_synthetic', 'sub_expired_synthetic', true),
  ('00000000-0000-4000-8000-000000000007', 'past_due', '2099-01-01', null, 'cus_past_due_synthetic', 'sub_past_due_synthetic', true),
  ('00000000-0000-4000-8000-000000000008', 'active', '2099-01-01', null, 'cus_invalid_synthetic', 'not_a_stripe_subscription', true),
  ('00000000-0000-4000-8000-000000000010', 'active', '2099-01-01', null, null, 'sub_orphan_synthetic', true),
  ('00000000-0000-4000-8000-000000000011', 'active', '2099-01-01', null, 'cus_overflow_synthetic', 'sub_overflow_synthetic', false);

insert into public.jobs (
  id,
  owner_id,
  title,
  location,
  active,
  created_at,
  updated_at
) values
  ('10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002', 'Legacy first', 'Miami, FL', true, '2026-01-01', '2026-01-01'),
  ('10000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000002', 'Legacy second', 'Miami, FL', true, '2026-02-01', '2026-02-01'),
  ('10000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000003', 'Paid first', 'Orlando, FL', true, '2026-01-01', '2026-01-01'),
  ('10000000-0000-4000-8000-000000000004', '00000000-0000-4000-8000-000000000003', 'Paid second', 'Orlando, FL', true, '2026-02-01', '2026-02-01'),
  ('11000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000011', 'Overflow first', 'Tallahassee, FL', true, '2026-01-01', '2026-01-01'),
  ('11000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000011', 'Overflow second', 'Tallahassee, FL', true, '2026-02-01', '2026-02-01'),
  ('11000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000011', 'Overflow third', 'Tallahassee, FL', true, '2026-03-01', '2026-03-01'),
  ('11000000-0000-4000-8000-000000000004', '00000000-0000-4000-8000-000000000011', 'Overflow fourth', 'Tallahassee, FL', true, '2026-04-01', '2026-04-01');
