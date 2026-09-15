-- REVIEW PROPOSAL ONLY: apply after native-billing-ledger.sql and the current
-- Stripe migrations. Not deployed. Does not modify prices or subscriber rows.
create table private.native_billing_configuration (
  singleton boolean primary key default true check(singleton),
  environment text not null check(environment in ('Production','Sandbox'))
);
insert into private.native_billing_configuration values(true,'Production');
alter table private.native_billing_configuration enable row level security;
revoke all on private.native_billing_configuration from public,anon,authenticated,service_role;

create table private.native_checkout_attempts (
  id uuid primary key,
  user_id uuid not null references private.native_billing_accounts(user_id),
  provider text not null check(provider in ('apple','google')),
  environment text not null check(environment in ('Production','Sandbox')),
  state text not null check(state in ('reserved','started','cancelled','expired','verified')),
  reserved_until timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index native_checkout_one_open_account on private.native_checkout_attempts(user_id,environment) where state in ('reserved','started');
alter table private.native_checkout_attempts enable row level security;
revoke all on private.native_checkout_attempts from public,anon,authenticated,service_role;

create function private.native_checkout_is_blocked(p_user_id uuid) returns boolean
language sql stable security definer set search_path=pg_catalog,private as $$
  select exists(select 1 from private.native_billing_subscriptions s
    join private.native_billing_configuration c on s.environment=c.environment
    where s.user_id=p_user_id and s.superseded_by is null and s.revision>0 and (
      s.status in ('pending','payment_required') or
      (s.status in ('active','grace') and (s.auto_renews or s.current_period_end>now() or s.grace_period_end>now()))
    )) or exists(select 1 from private.native_checkout_attempts a
    join private.native_billing_configuration c on a.environment=c.environment
    where a.user_id=p_user_id and (a.state='started' or (a.state='reserved' and a.reserved_until>now())));
$$;
revoke all on function private.native_checkout_is_blocked(uuid) from public,anon,authenticated,service_role;

create function public.native_checkout_claim(p_user_id uuid,p_provider text,p_environment text,p_attempt_id uuid) returns jsonb
language plpgsql security definer set search_path=pg_catalog,private as $$
declare existing public.cafe_subscriptions%rowtype; binding uuid;
begin
  if p_attempt_id is null or p_provider is null or p_provider not in ('apple','google')
    or not exists(select 1 from private.native_billing_configuration where environment=p_environment)
    or not exists(select 1 from public.profiles where id=p_user_id and role='cafe_owner_manager' and suspended_at is null) then
    raise exception 'Native checkout unavailable';
  end if;
  -- The same row is locked by the existing Stripe checkout/deletion claims.
  select * into existing from public.cafe_subscriptions where user_id=p_user_id for update;
  if not found then return null; end if;
  if existing.stripe_checkout_attempt_id is not null
    or (existing.stripe_checkout_claim_id is not null and existing.stripe_checkout_claim_expires_at>now())
    or (existing.stripe_subscription_id is not null and existing.status in ('active','trialing','past_due','unpaid','incomplete','paused'))
    or private.native_checkout_is_blocked(p_user_id) then return null; end if;
  binding:=public.native_billing_account(p_user_id);
  -- Only a reservation that never authorized a store launch can time out.
  update private.native_checkout_attempts set state='expired',updated_at=now()
    where user_id=p_user_id and environment=p_environment and state='reserved' and reserved_until<=now();
  insert into private.native_checkout_attempts(id,user_id,provider,environment,state,reserved_until)
    values(p_attempt_id,p_user_id,p_provider,p_environment,'reserved',now()+interval '5 minutes');
  return jsonb_build_object('attemptId',p_attempt_id,'accountBinding',binding);
end;
$$;

create function public.native_checkout_start(p_user_id uuid,p_environment text,p_attempt_id uuid) returns boolean
language plpgsql security definer set search_path=pg_catalog,private as $$
declare affected integer;
begin
  if not exists(select 1 from private.native_billing_configuration where environment=p_environment)
    or not exists(select 1 from public.profiles where id=p_user_id and role='cafe_owner_manager' and suspended_at is null) then return false; end if;
  perform 1 from public.cafe_subscriptions where user_id=p_user_id for update;
  if not found then return false; end if;
  if exists(select 1 from public.cafe_subscriptions where user_id=p_user_id
      and (stripe_checkout_attempt_id is not null or (stripe_checkout_claim_id is not null and stripe_checkout_claim_expires_at>now())
        or (stripe_subscription_id is not null and status in ('active','trialing','past_due','unpaid','incomplete','paused'))))
    or exists(select 1 from private.native_billing_subscriptions where user_id=p_user_id and environment=p_environment
      and superseded_by is null and revision>0 and (status in ('pending','payment_required')
        or (status in ('active','grace') and (auto_renews or current_period_end>now() or grace_period_end>now())))) then return false; end if;
  update private.native_checkout_attempts set state='started',updated_at=now()
    where id=p_attempt_id and user_id=p_user_id and environment=p_environment and state='reserved' and reserved_until>now();
  get diagnostics affected=row_count;return affected=1;
end;
$$;

-- Called only when the native SDK explicitly reports user cancellation, or
-- when preflight fails before authorizing a store launch. Transport errors,
-- pending purchases and empty restore results must never call this operation.
create function public.native_checkout_cancel(p_user_id uuid,p_environment text,p_attempt_id uuid,p_before_launch boolean) returns boolean
language plpgsql security definer set search_path=pg_catalog,private as $$
declare affected integer;
begin
  if p_before_launch is null or not exists(select 1 from private.native_billing_configuration where environment=p_environment) then return false; end if;
  perform 1 from public.cafe_subscriptions where user_id=p_user_id for update;
  if not found then return false; end if;
  update private.native_checkout_attempts set state='cancelled',updated_at=now()
    where id=p_attempt_id and user_id=p_user_id and environment=p_environment
      and (state='reserved' or (not p_before_launch and state='started') or state='cancelled');
  get diagnostics affected=row_count;return affected=1;
end;
$$;

create function public.native_checkout_pending(p_user_id uuid,p_environment text) returns boolean
language plpgsql stable security definer set search_path=pg_catalog,private as $$
begin
  if not exists(select 1 from private.native_billing_configuration where environment=p_environment) then raise exception 'Native checkout environment mismatch'; end if;
  return exists(select 1 from private.native_checkout_attempts where user_id=p_user_id and environment=p_environment
    and (state='started' or (state='reserved' and reserved_until>now())));
end;
$$;

-- Clear the purchase reservation only after a current provider record already
-- blocks another purchase. An old expired/refunded restoration is not evidence
-- that a different in-flight store checkout has ended.
create function public.native_checkout_settle_verified(p_user_id uuid,p_environment text) returns boolean
language plpgsql security definer set search_path=pg_catalog,private as $$
begin
  if not exists(select 1 from private.native_billing_configuration where environment=p_environment) then return false; end if;
  perform 1 from public.cafe_subscriptions where user_id=p_user_id for update;
  if not found then return false; end if;
  update private.native_checkout_attempts a set state='verified',updated_at=now()
  where a.user_id=p_user_id and a.environment=p_environment and a.state in ('reserved','started')
    and exists(select 1 from private.native_billing_subscriptions s where s.user_id=p_user_id and s.environment=p_environment
      and s.provider=a.provider and s.superseded_by is null and s.revision>0
      and (s.status in ('pending','payment_required') or (s.status in ('active','grace') and (s.auto_renews or s.current_period_end>now() or s.grace_period_end>now()))));
  return true;
end;
$$;

revoke all on function public.native_checkout_claim(uuid,text,text,uuid) from public,anon,authenticated;
revoke all on function public.native_checkout_start(uuid,text,uuid) from public,anon,authenticated;
revoke all on function public.native_checkout_cancel(uuid,text,uuid,boolean) from public,anon,authenticated;
revoke all on function public.native_checkout_pending(uuid,text) from public,anon,authenticated;
revoke all on function public.native_checkout_settle_verified(uuid,text) from public,anon,authenticated;
grant execute on function public.native_checkout_claim(uuid,text,text,uuid) to service_role;
grant execute on function public.native_checkout_start(uuid,text,uuid) to service_role;
grant execute on function public.native_checkout_cancel(uuid,text,uuid,boolean) to service_role;
grant execute on function public.native_checkout_pending(uuid,text) to service_role;
grant execute on function public.native_checkout_settle_verified(uuid,text) to service_role;

-- Existing Stripe function preserved verbatim except for one guard after its
-- row lock; existing signatures, payload recovery and lease rules stay intact.
create or replace function public.claim_stripe_checkout(
  p_user_id uuid,
  p_claim_id uuid,
  p_attempt_id uuid,
  p_channel text,
  p_ui_mode text default 'hosted'
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  existing public.cafe_subscriptions%rowtype;
  claimed_attempt_id uuid;
  claimed_channel text;
  claimed_ui_mode text;
  recovered boolean;
begin
  if p_user_id is null
     or p_claim_id is null
     or p_attempt_id is null
     or p_channel is null
     or p_channel not in ('web', 'app')
     or p_ui_mode is null
     or p_ui_mode not in ('hosted', 'embedded') then
    raise exception 'Invalid Checkout claim';
  end if;

  select * into existing
  from public.cafe_subscriptions
  where user_id = p_user_id
  for update;

  if not found
     or (
       existing.stripe_checkout_claim_id is not null
       and existing.stripe_checkout_claim_expires_at is not null
       and existing.stripe_checkout_claim_expires_at > now()
     ) then
    return null;
  end if;

  if private.native_checkout_is_blocked(p_user_id) then return null; end if;

  recovered := existing.stripe_checkout_attempt_id is not null;
  if not recovered and p_channel = 'app' and p_ui_mode <> 'hosted' then
    raise exception 'Invalid Checkout claim';
  end if;

  claimed_attempt_id := coalesce(existing.stripe_checkout_attempt_id, p_attempt_id);
  claimed_channel := case when recovered then coalesce(existing.stripe_checkout_channel, p_channel) else p_channel end;
  claimed_ui_mode := case when recovered then coalesce(existing.stripe_checkout_ui_mode, 'hosted') else p_ui_mode end;

  update public.cafe_subscriptions
  set stripe_checkout_claim_id = p_claim_id,
      stripe_checkout_claim_expires_at = now() + interval '5 minutes',
      stripe_checkout_claim_kind = 'checkout',
      stripe_checkout_attempt_id = claimed_attempt_id,
      stripe_checkout_channel = claimed_channel,
      stripe_checkout_ui_mode = claimed_ui_mode,
      updated_at = now()
  where user_id = p_user_id;

  return jsonb_build_object(
    'attemptId', claimed_attempt_id,
    'channel', claimed_channel,
    'uiMode', claimed_ui_mode,
    'recovered', recovered
  );
end;
$$;
