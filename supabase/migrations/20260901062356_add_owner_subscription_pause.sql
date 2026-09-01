-- Owner-controlled pauses apply to complimentary BaristaMatch access only.
-- Stripe-connected subscriptions are deliberately rejected by the API so a
-- local access change can never be mistaken for stopping payment collection.
alter table public.cafe_subscriptions
  add column if not exists owner_paused_at timestamptz;

comment on column public.cafe_subscriptions.owner_paused_at is
  'Owner-confirmed pause of complimentary cafe platform access. Does not alter Stripe billing.';

-- The owner-only server endpoint reads only job location fields to provide a
-- café city/ZIP fallback. No browser role receives this table grant.
grant select (owner_id, city, state, postal_code, created_at) on table public.jobs to service_role;

create or replace function public.cafe_has_hiring_access(target_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when coalesce((select role from public.profiles where id = target_user_id), '') <> 'cafe_owner_manager' then true
    else exists (
      select 1
      from public.cafe_subscriptions s
      where s.user_id = target_user_id
        and s.owner_paused_at is null
        and (
          s.complimentary_access = true
          or s.status = 'active'
          or (s.status = 'trialing' and s.trial_ends_at > now())
        )
    )
  end;
$$;

revoke execute on function public.cafe_has_hiring_access(uuid) from public, anon, authenticated;
grant execute on function public.cafe_has_hiring_access(uuid) to authenticated, service_role;

create or replace function public.ensure_cafe_subscription()
returns public.cafe_subscriptions
language plpgsql
security definer
set search_path = ''
as $$
declare
  result public.cafe_subscriptions;
begin
  if not exists (
    select 1
    from public.profiles
    where id = auth.uid() and role = 'cafe_owner_manager'
  ) then
    raise exception 'Cafe account required';
  end if;

  insert into public.cafe_subscriptions (user_id, complimentary_access)
  values (auth.uid(), true)
  on conflict (user_id) do update
  set updated_at = now();

  select * into result
  from public.cafe_subscriptions
  where user_id = auth.uid();

  return result;
end;
$$;

revoke execute on function public.ensure_cafe_subscription() from public, anon;
grant execute on function public.ensure_cafe_subscription() to authenticated;
