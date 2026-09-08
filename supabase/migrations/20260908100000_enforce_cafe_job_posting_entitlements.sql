-- Give every cafe one durable free job row. Any distinct later job requires a
-- real Stripe subscription, and paid-only jobs are hidden when that access is
-- no longer current.

-- Repair the production drift where the owner-pause migration was skipped
-- before the later security-invoker migration was recorded.
alter table public.cafe_subscriptions
  add column if not exists owner_paused_at timestamptz;

comment on column public.cafe_subscriptions.owner_paused_at is
  'Owner-confirmed pause of complimentary cafe platform access. Does not alter Stripe billing.';

grant select (owner_id, city, state, postal_code, created_at)
on table public.jobs to service_role;

-- These table-level privileges are not used by PostgREST clients and could
-- bypass row triggers or attach hostile trigger behavior if left inherited
-- from broad historical defaults.
revoke references, trigger, truncate on table public.jobs from anon, authenticated;

create or replace function public.cafe_has_hiring_access(target_user_id uuid)
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
        and subscription.owner_paused_at is null
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

comment on function public.cafe_has_hiring_access(uuid) is
  'Self-only hiring-flow access. Keeps complimentary first-job matching and messaging while honoring an owner pause.';

revoke all on function public.cafe_has_hiring_access(uuid) from public, anon, authenticated, service_role;
grant execute on function public.cafe_has_hiring_access(uuid) to authenticated, service_role;

create table if not exists private.cafe_job_entitlements (
  cafe_id uuid primary key references public.profiles(id) on delete cascade,
  free_job_id uuid not null unique,
  created_at timestamptz not null default now(),
  free_job_deleted_at timestamptz
);

comment on table private.cafe_job_entitlements is
  'Internal lifetime ledger for the one free job row assigned to each cafe.';
comment on column private.cafe_job_entitlements.free_job_id is
  'The first job row assigned to this cafe. It intentionally has no jobs foreign key so deletion cannot reset the lifetime allowance.';
comment on column private.cafe_job_entitlements.free_job_deleted_at is
  'Set when the original free job is deleted so reusing its UUID cannot recreate the lifetime allowance.';

alter table private.cafe_job_entitlements enable row level security;
revoke all on table private.cafe_job_entitlements from public, anon, authenticated, service_role;

create or replace function private.cafe_has_paid_job_entitlement(p_cafe_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.cafe_subscriptions subscription
    where subscription.user_id = p_cafe_id
      and subscription.stripe_customer_id ~ '^cus_[A-Za-z0-9_]+$'
      and length(subscription.stripe_customer_id) <= 255
      and subscription.stripe_subscription_id ~ '^sub_[A-Za-z0-9_]+$'
      and length(subscription.stripe_subscription_id) <= 255
      and (
        subscription.status = 'active'
        or (
          subscription.status = 'trialing'
          and subscription.trial_ends_at > now()
        )
      )
  );
$$;

comment on function private.cafe_has_paid_job_entitlement(uuid) is
  'True only for a real active Stripe subscription or a real unexpired Stripe trial. Complimentary access never satisfies paid job access.';

create or replace function private.job_caller_is_application_participant(
  p_job_id uuid,
  p_owner_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.applications application
    where application.job_id = p_job_id
      and application.barista_id = (select auth.uid())
      and not private.members_are_blocked(application.barista_id, p_owner_id)
  );
$$;

comment on function private.job_caller_is_application_participant(uuid, uuid) is
  'Non-recursive RLS helper that lets an existing applicant retain the related job row without reopening it to public discovery.';

create or replace function private.job_has_publication_entitlement(
  p_job_id uuid,
  p_owner_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    exists (
      select 1
      from private.cafe_job_entitlements entitlement
      where entitlement.cafe_id = p_owner_id
        and entitlement.free_job_id = p_job_id
        and entitlement.free_job_deleted_at is null
    )
    or private.cafe_has_paid_job_entitlement(p_owner_id);
$$;

comment on function private.job_has_publication_entitlement(uuid, uuid) is
  'RLS helper: the original free job stays publishable; every other job is publishable only while Stripe access is current.';

create or replace function public.cafe_can_create_job()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  with caller as (
    select (select auth.uid()) as id
  )
  select exists (
    select 1
    from caller
    join public.profiles profile on profile.id = caller.id
    where profile.role = 'cafe_owner_manager'
      and profile.suspended_at is null
      and (
        select count(*)
        from public.jobs job
        where job.owner_id = caller.id
          and job.active is true
      ) < 3
      and (
        not exists (
          select 1
          from private.cafe_job_entitlements entitlement
          where entitlement.cafe_id = caller.id
        )
        or private.cafe_has_paid_job_entitlement(caller.id)
      )
  );
$$;

comment on function public.cafe_can_create_job() is
  'Self-only preflight for job creation. False after the lifetime free row exists unless current Stripe access permits another job.';

create or replace function private.enforce_job_posting_entitlement()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  assigned_free_job_id uuid;
  assigned_free_job_deleted_at timestamptz;
  active_job_count integer;
  becoming_active boolean;
begin
  if tg_op = 'UPDATE' and (
    new.id is distinct from old.id
    or new.owner_id is distinct from old.owner_id
  ) then
    raise exception using
      errcode = 'PJB02',
      message = 'JOB_IDENTITY_IMMUTABLE',
      detail = 'A job ID and cafe owner cannot be changed after creation.';
  end if;

  -- The entitlement row is also the per-cafe serialization point. INSERT ON
  -- CONFLICT waits for a concurrent first insert, so exactly one committed job
  -- receives the lifetime allowance.
  insert into private.cafe_job_entitlements (cafe_id, free_job_id)
  values (new.owner_id, new.id)
  on conflict (cafe_id) do nothing;

  select entitlement.free_job_id, entitlement.free_job_deleted_at
  into assigned_free_job_id, assigned_free_job_deleted_at
  from private.cafe_job_entitlements entitlement
  where entitlement.cafe_id = new.owner_id
  for update;

  if assigned_free_job_id is null then
    raise exception using
      errcode = 'PJB03',
      message = 'JOB_ENTITLEMENT_STATE_UNAVAILABLE';
  end if;

  if tg_op = 'INSERT' then
    if not (
      new.id = assigned_free_job_id
      and assigned_free_job_deleted_at is null
    ) and not private.cafe_has_paid_job_entitlement(new.owner_id) then
      raise exception using
        errcode = 'PJB01',
        message = 'JOB_PRO_SUBSCRIPTION_REQUIRED',
        detail = 'A second lifetime job requires an active or unexpired trialing Stripe subscription.',
        hint = 'Start or restore Pro, then retry the job creation.';
    end if;
  elsif new.active is true
        and old.active is not true
        and not (
          new.id = assigned_free_job_id
          and assigned_free_job_deleted_at is null
        )
        and not private.cafe_has_paid_job_entitlement(new.owner_id) then
    raise exception using
      errcode = 'PJB01',
      message = 'JOB_PRO_SUBSCRIPTION_REQUIRED',
      detail = 'Publishing a paid-only job requires an active or unexpired trialing Stripe subscription.',
      hint = 'Start or restore Pro, then retry publishing the job.';
  end if;

  if tg_op = 'INSERT' then
    becoming_active := new.active is true;
  else
    becoming_active := new.active is true and old.active is not true;
  end if;

  if becoming_active then
    select count(*)::integer
    into active_job_count
    from public.jobs job
    where job.owner_id = new.owner_id
      and job.active is true;

    if active_job_count >= 3 then
      raise exception using
        errcode = 'PJB04',
        message = 'JOB_ACTIVE_LIMIT_REACHED',
        detail = 'Pro permits at most three concurrent active job posts.',
        hint = 'Pause an active job, then retry publishing this job.';
    end if;
  end if;

  return new;
end;
$$;

create or replace function private.record_free_job_deletion()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update private.cafe_job_entitlements entitlement
  set free_job_deleted_at = coalesce(entitlement.free_job_deleted_at, now())
  where entitlement.cafe_id = old.owner_id
    and entitlement.free_job_id = old.id;
  return old;
end;
$$;

create or replace function private.pause_jobs_without_paid_entitlement()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  affected_cafe_id uuid;
begin
  affected_cafe_id := new.user_id;

  if not private.cafe_has_paid_job_entitlement(affected_cafe_id) then
    update public.jobs job
    set active = false,
        updated_at = now()
    where job.owner_id = affected_cafe_id
      and job.active is true
      and not exists (
        select 1
        from private.cafe_job_entitlements entitlement
        where entitlement.cafe_id = affected_cafe_id
          and entitlement.free_job_id = job.id
          and entitlement.free_job_deleted_at is null
      );
  end if;

  return new;
end;
$$;

revoke all on function private.cafe_has_paid_job_entitlement(uuid) from public, anon, authenticated, service_role;
revoke all on function private.job_caller_is_application_participant(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function private.enforce_job_posting_entitlement() from public, anon, authenticated, service_role;
revoke all on function private.record_free_job_deletion() from public, anon, authenticated, service_role;
revoke all on function private.pause_jobs_without_paid_entitlement() from public, anon, authenticated, service_role;
revoke all on function private.job_has_publication_entitlement(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public.cafe_can_create_job() from public, anon, authenticated, service_role;
grant execute on function private.job_caller_is_application_participant(uuid, uuid) to authenticated;
grant execute on function private.job_has_publication_entitlement(uuid, uuid) to authenticated;
grant execute on function public.cafe_can_create_job() to authenticated;

-- Keep job and subscription writes stable while the lifetime ledger is
-- backfilled and the triggers are installed. Readers remain available.
lock table public.cafe_subscriptions, public.jobs in share row exclusive mode;

insert into private.cafe_job_entitlements (cafe_id, free_job_id)
select first_jobs.owner_id, first_jobs.id
from (
  select distinct on (job.owner_id)
    job.owner_id,
    job.id
  from public.jobs job
  order by job.owner_id, job.created_at, job.id
) first_jobs
on conflict (cafe_id) do nothing;

drop trigger if exists enforce_job_posting_entitlement on public.jobs;
create trigger enforce_job_posting_entitlement
before insert or update on public.jobs
for each row execute function private.enforce_job_posting_entitlement();

drop trigger if exists record_free_job_deletion on public.jobs;
create trigger record_free_job_deletion
after delete on public.jobs
for each row execute function private.record_free_job_deletion();

drop trigger if exists pause_jobs_without_paid_entitlement on public.cafe_subscriptions;
create trigger pause_jobs_without_paid_entitlement
after insert or update on public.cafe_subscriptions
for each row execute function private.pause_jobs_without_paid_entitlement();

-- A restrictive policy composes with every existing permissive jobs SELECT
-- policy. Owners retain access to all of their rows, while other authenticated
-- members can only receive the free row or a currently entitled paid row.
drop policy if exists "Members need publication entitlement for paid jobs" on public.jobs;
create policy "Members need publication entitlement for paid jobs"
on public.jobs
as restrictive
for select
to authenticated
using (
  owner_id = (select auth.uid())
  or private.job_has_publication_entitlement(id, owner_id)
  or private.job_caller_is_application_participant(id, owner_id)
);

drop policy if exists "Application participants can view their jobs" on public.jobs;
create policy "Application participants can view their jobs"
on public.jobs
for select
to authenticated
using (
  private.job_caller_is_application_participant(id, owner_id)
);

-- Existing application and conversation relationships outlive publication.
-- These policies retain their identity, transition, content, and block checks;
-- only the obsolete broad hiring-access gate is removed from those existing
-- participant workflows.
alter policy "Participants can update relevant applications"
on public.applications
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
);

alter policy "matched users can send messages"
on public.messages
with check (
  sender_id = (select auth.uid())
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

-- Preserve every legacy row, but make the stored active flag agree with what
-- baristas can actually see after this rule ships.
update public.jobs job
set active = false,
    updated_at = now()
from private.cafe_job_entitlements entitlement
where entitlement.cafe_id = job.owner_id
  and entitlement.free_job_id <> job.id
  and job.active is true
  and not private.cafe_has_paid_job_entitlement(job.owner_id);

-- Keep at most the three earliest currently active rows for any paid legacy
-- cafe that somehow already exceeds the advertised concurrent-post limit.
with ranked_active_jobs as (
  select
    job.id,
    row_number() over (
      partition by job.owner_id
      order by job.created_at, job.id
    ) as active_rank
  from public.jobs job
  where job.active is true
)
update public.jobs job
set active = false,
    updated_at = now()
from ranked_active_jobs ranked
where ranked.id = job.id
  and ranked.active_rank > 3;
