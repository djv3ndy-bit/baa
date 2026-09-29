-- One lifetime free job, with a non-resettable 30-day publication period.
-- Existing ledger entries receive the user-approved 30 days from rollout.
-- ADD COLUMN's default backfills once; rerunning never extends a deadline.
lock table private.cafe_job_entitlements, public.jobs in share row exclusive mode;
alter table private.cafe_job_entitlements
  add column if not exists free_job_expires_at timestamptz not null
  default (now() + interval '720 hours');
comment on column private.cafe_job_entitlements.free_job_expires_at is
  'Server-owned free publication deadline: 30 days after allowance assignment, or rollout for existing entries. Editing, pausing, deletion and reopening never reset it.';

create or replace function private.job_has_publication_entitlement(p_job_id uuid, p_owner_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from private.cafe_job_entitlements e
    where e.cafe_id = p_owner_id and e.free_job_id = p_job_id
      and e.free_job_deleted_at is null and e.free_job_expires_at > now()
  ) or private.cafe_has_paid_job_entitlement(p_owner_id);
$$;
comment on function private.job_has_publication_entitlement(uuid, uuid) is
  'Publication is allowed during the original free job deadline, or with current verified paid access. Existing participant history is handled separately by RLS.';

-- Preserve the existing lifetime/three-active-job enforcement trigger. This
-- additional guard covers the original job after its private deadline.
create or replace function private.enforce_free_job_expiration()
returns trigger language plpgsql security definer set search_path = '' as $$
declare deadline timestamptz;
begin
  select e.free_job_expires_at into deadline
  from private.cafe_job_entitlements e
  where e.cafe_id = new.owner_id and e.free_job_id = new.id
    and e.free_job_deleted_at is null
  for update;
  if new.active is true and deadline <= now()
      and not private.cafe_has_paid_job_entitlement(new.owner_id) then
    if old.active is not true then
      raise exception using errcode = 'PJB05', message = 'JOB_FREE_PERIOD_EXPIRED',
        detail = 'The first free job has reached its 30-day deadline.',
        hint = 'Start or restore Pro to reopen this job. Its applicants and conversations remain saved.';
    end if;
    -- An edit to a just-expired active row is still saved, but cannot silently
    -- keep that job published while the scheduled expiry sweep catches up.
    new.active := false;
  end if;
  return new;
end;
$$;
revoke all on function private.enforce_free_job_expiration() from public, anon, authenticated, service_role;
drop trigger if exists enforce_free_job_expiration on public.jobs;
create trigger enforce_free_job_expiration before update on public.jobs
for each row execute function private.enforce_free_job_expiration();

-- Existing applications can still read their job after expiration. That
-- history exception must never grant permission to insert fresh interest.
drop policy if exists "New interest requires current job publication" on public.applications;
create policy "New interest requires current job publication" on public.applications
as restrictive for insert to authenticated with check (
  exists (select 1 from public.jobs j where j.id = applications.job_id
    and j.active is true and private.job_has_publication_entitlement(j.id, j.owner_id))
);

create or replace function public.cafe_job_access()
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'free_job_id', e.free_job_id,
    'free_job_expires_at', e.free_job_expires_at,
    'has_paid_access', private.cafe_has_paid_job_entitlement(p.id),
    'can_create', public.cafe_can_create_job(),
    'active_job_count', (select count(*) from public.jobs j where j.owner_id = p.id
      and j.active is true and private.job_has_publication_entitlement(j.id, j.owner_id)),
    'server_time', now()
  ) from public.profiles p
  left join private.cafe_job_entitlements e on e.cafe_id = p.id
  where p.id = (select auth.uid()) and p.role = 'cafe_owner_manager'
    and p.suspended_at is null;
$$;
revoke all on function public.cafe_job_access() from public, anon, authenticated, service_role;
grant execute on function public.cafe_job_access() to authenticated;
comment on function public.cafe_job_access() is
  'Self-only cafe publication status. No client can choose an owner or change a deadline.';

-- Reconciliation changes only visibility, never deletes a job or relationship.
-- RLS and write guards enforce the deadline even if this sweep is delayed.
create or replace function private.expire_free_job_posts()
returns integer language plpgsql security definer set search_path = '' as $$
declare changed integer;
begin
  update public.jobs j set active = false, updated_at = now()
  from private.cafe_job_entitlements e
  where e.cafe_id = j.owner_id and e.free_job_id = j.id
    and e.free_job_deleted_at is null and e.free_job_expires_at <= now()
    and j.active is true and not private.cafe_has_paid_job_entitlement(j.owner_id);
  get diagnostics changed = row_count;
  return changed;
end;
$$;
revoke all on function private.expire_free_job_posts() from public, anon, authenticated, service_role;

-- Keep the existing Stripe status trigger aware of the free deadline.
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
          and entitlement.free_job_expires_at > now()
      );
  end if;

  return new;
end;
$$;
