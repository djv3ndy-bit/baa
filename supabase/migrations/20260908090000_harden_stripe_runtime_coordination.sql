-- Serialize Stripe Checkout creation, make webhook claims retry-safe, and keep
-- invoice history monotonic when Stripe delivers events out of order.

alter table public.cafe_subscriptions
  add column if not exists stripe_checkout_claim_id uuid,
  add column if not exists stripe_checkout_claim_expires_at timestamptz,
  add column if not exists stripe_checkout_claim_kind text,
  add column if not exists stripe_checkout_attempt_id uuid,
  add column if not exists stripe_checkout_channel text,
  add column if not exists stripe_subscription_event_created_at timestamptz,
  add column if not exists stripe_subscription_created_at timestamptz,
  add column if not exists stripe_subscription_sync_revision bigint not null default 0;

comment on column public.cafe_subscriptions.stripe_checkout_claim_id is
  'Short-lived service-role claim that serializes Checkout Session creation.';
comment on column public.cafe_subscriptions.stripe_checkout_claim_expires_at is
  'Checkout claim expiry so an interrupted server request cannot lock billing indefinitely.';
comment on column public.cafe_subscriptions.stripe_checkout_claim_kind is
  'Identifies whether the shared billing lease belongs to Checkout or account deletion.';
comment on column public.cafe_subscriptions.stripe_checkout_attempt_id is
  'Durable Stripe idempotency attempt shared by every worker that recovers an expired claim.';
comment on column public.cafe_subscriptions.stripe_checkout_channel is
  'Checkout payload variant bound to the durable Stripe idempotency attempt.';
comment on column public.cafe_subscriptions.stripe_subscription_event_created_at is
  'Latest Stripe event time applied to subscription state; prevents out-of-order regression.';
comment on column public.cafe_subscriptions.stripe_subscription_created_at is
  'Stripe creation time for the current subscription; orders replacement subscription IDs.';
comment on column public.cafe_subscriptions.stripe_subscription_sync_revision is
  'Monotonic state revision used to fence authoritative Stripe reads that race another update.';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.cafe_subscriptions'::regclass
      and conname = 'cafe_subscriptions_stripe_checkout_claim_kind_check'
  ) then
    alter table public.cafe_subscriptions
      add constraint cafe_subscriptions_stripe_checkout_claim_kind_check
      check (stripe_checkout_claim_kind in ('checkout', 'deletion'));
  end if;
end;
$$;

drop function if exists public.claim_stripe_checkout(uuid, uuid, timestamptz);
drop function if exists public.claim_stripe_checkout(uuid, uuid, uuid, text, timestamptz);

create or replace function public.claim_stripe_checkout(
  p_user_id uuid,
  p_claim_id uuid,
  p_attempt_id uuid,
  p_channel text
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
  recovered boolean;
begin
  if p_user_id is null
     or p_claim_id is null
     or p_attempt_id is null
     or p_channel is null
     or p_channel not in ('web', 'app') then
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

  recovered := existing.stripe_checkout_attempt_id is not null;
  claimed_attempt_id := coalesce(existing.stripe_checkout_attempt_id, p_attempt_id);
  claimed_channel := coalesce(existing.stripe_checkout_channel, p_channel);

  update public.cafe_subscriptions
  set stripe_checkout_claim_id = p_claim_id,
      stripe_checkout_claim_expires_at = now() + interval '5 minutes',
      stripe_checkout_claim_kind = 'checkout',
      stripe_checkout_attempt_id = claimed_attempt_id,
      stripe_checkout_channel = claimed_channel,
      updated_at = now()
  where user_id = p_user_id;

  return jsonb_build_object(
    'attemptId', claimed_attempt_id,
    'channel', claimed_channel,
    'recovered', recovered
  );
end;
$$;

drop function if exists public.release_stripe_checkout(uuid, uuid);

create or replace function public.release_stripe_checkout(
  p_user_id uuid,
  p_claim_id uuid,
  p_clear_attempt boolean
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  affected integer := 0;
begin
  if p_clear_attempt is null then
    raise exception 'Invalid Checkout release';
  end if;

  update public.cafe_subscriptions
  set stripe_checkout_claim_id = null,
      stripe_checkout_claim_expires_at = null,
      stripe_checkout_claim_kind = null,
      stripe_checkout_attempt_id = case when p_clear_attempt then null else stripe_checkout_attempt_id end,
      stripe_checkout_channel = case when p_clear_attempt then null else stripe_checkout_channel end,
      updated_at = now()
  where user_id = p_user_id
    and stripe_checkout_claim_id = p_claim_id;
  get diagnostics affected = row_count;
  return affected = 1;
end;
$$;

revoke execute on function public.claim_stripe_checkout(uuid, uuid, uuid, text) from public, anon, authenticated;
revoke execute on function public.release_stripe_checkout(uuid, uuid, boolean) from public, anon, authenticated;
grant execute on function public.claim_stripe_checkout(uuid, uuid, uuid, text) to service_role;
grant execute on function public.release_stripe_checkout(uuid, uuid, boolean) to service_role;

create or replace function public.stripe_checkout_claim_is_current(
  p_user_id uuid,
  p_claim_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.cafe_subscriptions subscription
    where subscription.user_id = p_user_id
      and subscription.stripe_checkout_claim_id = p_claim_id
      and subscription.stripe_checkout_claim_kind = 'checkout'
      and subscription.stripe_checkout_claim_expires_at > now()
  );
$$;

drop function if exists public.attach_stripe_checkout_customer(uuid, uuid, text);

create function public.attach_stripe_checkout_customer(
  p_user_id uuid,
  p_claim_id uuid,
  p_customer_id text
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  existing public.cafe_subscriptions%rowtype;
begin
  if p_user_id is null
     or p_claim_id is null
     or p_customer_id is null
     or p_customer_id !~ '^cus_[A-Za-z0-9_]+$'
     or length(p_customer_id) > 255 then
    raise exception 'Invalid Stripe Customer attachment';
  end if;

  select * into existing
  from public.cafe_subscriptions
  where user_id = p_user_id
  for update;

  if not found then return 'missing'; end if;
  if existing.stripe_customer_id = p_customer_id then return 'owned'; end if;
  if existing.stripe_checkout_claim_id is distinct from p_claim_id
     or existing.stripe_checkout_claim_kind is distinct from 'checkout'
     or coalesce(existing.stripe_checkout_claim_expires_at <= now(), true) then
    return case
      when existing.stripe_checkout_claim_kind = 'deletion' then 'deletion'
      else 'recovering'
    end;
  end if;
  if existing.stripe_customer_id is not null then return 'conflict'; end if;

  update public.cafe_subscriptions
  set stripe_customer_id = p_customer_id,
      updated_at = now()
  where user_id = p_user_id;
  return 'attached';
end;
$$;

revoke execute on function public.stripe_checkout_claim_is_current(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.attach_stripe_checkout_customer(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.stripe_checkout_claim_is_current(uuid, uuid) to service_role;
grant execute on function public.attach_stripe_checkout_customer(uuid, uuid, text) to service_role;

drop function if exists public.claim_stripe_deletion(uuid, uuid, timestamptz);

create or replace function public.claim_stripe_deletion(
  p_user_id uuid,
  p_claim_id uuid
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  existing public.cafe_subscriptions%rowtype;
begin
  if p_user_id is null
     or p_claim_id is null then
    raise exception 'Invalid deletion claim';
  end if;

  select * into existing
  from public.cafe_subscriptions
  where user_id = p_user_id
  for update;

  if not found then return 'missing'; end if;
  if existing.stripe_checkout_claim_id is not null
     and (
       existing.stripe_checkout_claim_expires_at is null
       or existing.stripe_checkout_claim_expires_at > now() - interval '5 minutes'
     ) then
    return 'busy';
  end if;

  update public.cafe_subscriptions
  set stripe_checkout_claim_id = p_claim_id,
      stripe_checkout_claim_expires_at = now() + interval '2 minutes',
      stripe_checkout_claim_kind = 'deletion',
      updated_at = now()
  where user_id = p_user_id;
  return 'claimed';
end;
$$;

revoke execute on function public.claim_stripe_deletion(uuid, uuid) from public, anon, authenticated;
grant execute on function public.claim_stripe_deletion(uuid, uuid) to service_role;

drop function if exists public.settle_stripe_checkout_attempt_for_deletion(uuid, uuid);

create function public.settle_stripe_checkout_attempt_for_deletion(
  p_user_id uuid,
  p_claim_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  affected integer := 0;
begin
  if p_user_id is null or p_claim_id is null then
    raise exception 'Invalid deletion settlement';
  end if;

  update public.cafe_subscriptions
  set stripe_checkout_attempt_id = null,
      stripe_checkout_channel = null,
      updated_at = now()
  where user_id = p_user_id
    and stripe_checkout_claim_id = p_claim_id
    and stripe_checkout_claim_kind = 'deletion'
    and stripe_checkout_claim_expires_at > now();
  get diagnostics affected = row_count;
  return affected = 1;
end;
$$;

revoke execute on function public.settle_stripe_checkout_attempt_for_deletion(uuid, uuid) from public, anon, authenticated;
grant execute on function public.settle_stripe_checkout_attempt_for_deletion(uuid, uuid) to service_role;

drop function if exists public.sync_stripe_subscription(uuid, text, text, text, timestamptz, boolean, timestamptz);
drop function if exists public.sync_stripe_subscription(uuid, text, text, text, timestamptz, boolean, timestamptz, boolean);
drop function if exists public.sync_stripe_subscription(uuid, text, text, text, timestamptz, boolean, timestamptz, boolean, timestamptz);
drop function if exists public.sync_stripe_subscription(uuid, text, text, text, timestamptz, boolean, timestamptz, boolean, timestamptz, bigint);

create or replace function public.sync_stripe_subscription(
  p_user_id uuid,
  p_customer_id text,
  p_subscription_id text,
  p_subscription_created_at timestamptz,
  p_status text,
  p_current_period_end timestamptz,
  p_cancel_at_period_end boolean,
  p_event_created_at timestamptz,
  p_authoritative boolean,
  p_expected_event_created_at timestamptz,
  p_expected_revision bigint
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  existing public.cafe_subscriptions%rowtype;
  existing_rank integer;
  incoming_rank integer;
  existing_selection_rank integer;
  incoming_selection_rank integer;
begin
  if p_user_id is null
     or p_customer_id is null
     or p_customer_id !~ '^cus_[A-Za-z0-9_]+$'
     or length(p_customer_id) > 255
     or p_subscription_id is null
     or p_subscription_id !~ '^sub_[A-Za-z0-9_]+$'
     or length(p_subscription_id) > 255
     or p_subscription_created_at is null
     or p_status is null
     or p_status not in ('active', 'trialing', 'past_due', 'canceled', 'expired')
     or p_cancel_at_period_end is null
     or p_event_created_at is null
     or p_authoritative is null then
    raise exception 'Invalid Stripe subscription state';
  end if;

  select * into existing
  from public.cafe_subscriptions
  where user_id = p_user_id
  for update;

  if not found then return false; end if;
  if existing.stripe_customer_id is not null
     and existing.stripe_customer_id <> p_customer_id then
    return false;
  end if;
  if p_authoritative
     and (
       existing.stripe_subscription_event_created_at is distinct from p_expected_event_created_at
       or existing.stripe_subscription_sync_revision is distinct from p_expected_revision
     ) then
    return false;
  end if;

  -- Stripe timestamps have one-second precision. For ties, prefer the
  -- fail-closed state and a pending cancellation over restoring access.
  existing_rank := case existing.status
    when 'canceled' then 4
    when 'expired' then 4
    when 'past_due' then 3
    when 'active' then 2
    when 'trialing' then 2
    else 1
  end;
  incoming_rank := case p_status
    when 'canceled' then 4
    when 'expired' then 4
    when 'past_due' then 3
    when 'active' then 2
    when 'trialing' then 2
    else 1
  end;
  existing_selection_rank := case existing.status
    when 'active' then 3
    when 'trialing' then 3
    when 'past_due' then 2
    else 1
  end;
  incoming_selection_rank := case p_status
    when 'active' then 3
    when 'trialing' then 3
    when 'past_due' then 2
    else 1
  end;

  if not p_authoritative
     and existing.stripe_subscription_event_created_at > p_event_created_at then
    return true;
  end if;
  if not p_authoritative
     and existing.stripe_subscription_event_created_at = p_event_created_at
     and existing.stripe_subscription_id is not null then
    if existing.stripe_subscription_id = p_subscription_id then
      if incoming_rank < existing_rank
         or (
           incoming_rank = existing_rank
           and existing.cancel_at_period_end
           and not p_cancel_at_period_end
         ) then
        return true;
      end if;
    elsif incoming_selection_rank < existing_selection_rank
       or (
         incoming_selection_rank = existing_selection_rank
         and existing.stripe_subscription_created_at is not null
         and (
           p_subscription_created_at < existing.stripe_subscription_created_at
           or (
             p_subscription_created_at = existing.stripe_subscription_created_at
             and p_subscription_id collate "C" < existing.stripe_subscription_id collate "C"
           )
         )
       ) then
      -- All current subscriptions for the Customer are reconciled together.
      -- Equal-time concurrent observations use the same access/creation/ID
      -- preference as the application selector, independent of row arrival.
      return true;
    end if;
  end if;

  if p_authoritative
     and existing.stripe_subscription_event_created_at is not null
     and existing.stripe_customer_id is not distinct from p_customer_id
     and existing.stripe_subscription_id is not distinct from p_subscription_id
     and existing.stripe_subscription_created_at is not distinct from p_subscription_created_at
     and existing.status is not distinct from p_status
     and existing.current_period_end is not distinct from p_current_period_end
     and existing.cancel_at_period_end is not distinct from p_cancel_at_period_end then
    -- The event-time write already stored this exact current observation. Do
    -- not create needless revision contention between simultaneous webhooks.
    return true;
  end if;

  update public.cafe_subscriptions
  set stripe_customer_id = p_customer_id,
      stripe_subscription_id = p_subscription_id,
      stripe_subscription_created_at = p_subscription_created_at,
      status = p_status,
      current_period_end = p_current_period_end,
      cancel_at_period_end = p_cancel_at_period_end,
      stripe_subscription_event_created_at = case
        when p_authoritative then coalesce(stripe_subscription_event_created_at, p_event_created_at)
        else p_event_created_at
      end,
      stripe_subscription_sync_revision = stripe_subscription_sync_revision + 1,
      updated_at = now()
  where user_id = p_user_id;
  return true;
end;
$$;

revoke execute on function public.sync_stripe_subscription(uuid, text, text, timestamptz, text, timestamptz, boolean, timestamptz, boolean, timestamptz, bigint) from public, anon, authenticated;
grant execute on function public.sync_stripe_subscription(uuid, text, text, timestamptz, text, timestamptz, boolean, timestamptz, boolean, timestamptz, bigint) to service_role;

alter table public.stripe_webhook_events
  add column if not exists status text,
  add column if not exists claimed_at timestamptz,
  add column if not exists claim_id uuid;

update public.stripe_webhook_events
set status = 'processed', claim_id = null
where status is null;
alter table public.stripe_webhook_events alter column status set default 'processed';
alter table public.stripe_webhook_events alter column status set not null;
alter table public.stripe_webhook_events alter column processed_at drop not null;
alter table public.stripe_webhook_events alter column processed_at set default now();

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.stripe_webhook_events'::regclass
      and conname = 'stripe_webhook_events_status_check'
  ) then
    alter table public.stripe_webhook_events
      add constraint stripe_webhook_events_status_check
      check (status in ('processing', 'processed', 'failed'));
  end if;
end;
$$;

drop function if exists public.claim_stripe_webhook_event(text, text);
drop function if exists public.complete_stripe_webhook_event(text);
drop function if exists public.fail_stripe_webhook_event(text);

create or replace function public.claim_stripe_webhook_event(
  p_event_id text,
  p_event_type text,
  p_claim_id uuid
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  outcome text;
begin
  if p_event_id is null
     or p_event_id !~ '^evt_[A-Za-z0-9_]+$'
     or length(p_event_id) > 255
     or p_event_type is null
     or p_event_type = ''
     or length(p_event_type) > 255
     or p_claim_id is null then
    raise exception 'Invalid Stripe event identity';
  end if;

  insert into public.stripe_webhook_events as existing (
    event_id, event_type, status, claim_id, claimed_at, processed_at
  ) values (
    p_event_id, p_event_type, 'processing', p_claim_id, now(), null
  )
  on conflict (event_id) do update
  set event_type = excluded.event_type,
      status = 'processing',
      claim_id = excluded.claim_id,
      claimed_at = now(),
      processed_at = null
  where existing.event_type = excluded.event_type
    and (
      existing.status = 'failed'
      or (
        existing.status = 'processing'
        and existing.claimed_at < now() - interval '10 minutes'
      )
    )
  returning 'claimed' into outcome;

  if outcome = 'claimed' then return outcome; end if;

  select case
    when event_type <> p_event_type then 'invalid'
    when status = 'processed' then 'duplicate'
    else 'busy'
  end
  into outcome
  from public.stripe_webhook_events
  where event_id = p_event_id;
  return coalesce(outcome, 'busy');
end;
$$;

create or replace function public.complete_stripe_webhook_event(
  p_event_id text,
  p_claim_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  affected integer := 0;
begin
  update public.stripe_webhook_events
  set status = 'processed', claim_id = null, processed_at = now(), claimed_at = null
  where event_id = p_event_id
    and status = 'processing'
    and claim_id = p_claim_id;
  get diagnostics affected = row_count;
  return affected = 1;
end;
$$;

create or replace function public.fail_stripe_webhook_event(
  p_event_id text,
  p_claim_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  affected integer := 0;
begin
  update public.stripe_webhook_events
  set status = 'failed', claim_id = null, claimed_at = null
  where event_id = p_event_id
    and status = 'processing'
    and claim_id = p_claim_id;
  get diagnostics affected = row_count;
  return affected = 1;
end;
$$;

revoke execute on function public.claim_stripe_webhook_event(text, text, uuid) from public, anon, authenticated;
revoke execute on function public.complete_stripe_webhook_event(text, uuid) from public, anon, authenticated;
revoke execute on function public.fail_stripe_webhook_event(text, uuid) from public, anon, authenticated;
grant execute on function public.claim_stripe_webhook_event(text, text, uuid) to service_role;
grant execute on function public.complete_stripe_webhook_event(text, uuid) to service_role;
grant execute on function public.fail_stripe_webhook_event(text, uuid) to service_role;

alter table public.subscription_payments
  add column if not exists provider_event_created_at timestamptz;

create or replace function public.record_stripe_subscription_payment(
  p_cafe_user_id uuid,
  p_provider_payment_id text,
  p_amount_cents integer,
  p_currency text,
  p_status text,
  p_paid_at timestamptz,
  p_event_created_at timestamptz
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  recorded boolean := false;
begin
  if p_cafe_user_id is null
     or p_provider_payment_id is null
     or p_provider_payment_id = ''
     or length(p_provider_payment_id) > 255
     or p_amount_cents is null
     or p_amount_cents < 0
     or p_currency is null
     or p_currency !~ '^[a-z]{3}$'
     or p_status is null
     or p_status not in ('pending', 'succeeded', 'failed', 'refunded')
     or p_event_created_at is null then
    raise exception 'Invalid Stripe payment record';
  end if;

  insert into public.subscription_payments as existing (
    cafe_user_id,
    provider,
    provider_payment_id,
    amount_cents,
    currency,
    status,
    paid_at,
    provider_event_created_at
  ) values (
    p_cafe_user_id,
    'stripe',
    p_provider_payment_id,
    p_amount_cents,
    p_currency,
    p_status,
    p_paid_at,
    p_event_created_at
  )
  on conflict (provider_payment_id) do update
  set amount_cents = case
        when existing.status = 'refunded'
          and excluded.status = 'refunded'
          and existing.provider_event_created_at = excluded.provider_event_created_at
        then greatest(existing.amount_cents, excluded.amount_cents)
        else excluded.amount_cents
      end,
      currency = excluded.currency,
      status = excluded.status,
      paid_at = excluded.paid_at,
      provider_event_created_at = excluded.provider_event_created_at
  where existing.provider = 'stripe'
    and existing.cafe_user_id = excluded.cafe_user_id
    and (
      (
        excluded.status = 'succeeded'
        and existing.status <> 'succeeded'
      )
      or (
        excluded.provider_event_created_at >= coalesce(
          existing.provider_event_created_at,
          '-infinity'::timestamptz
        )
        and (
          existing.status <> 'succeeded'
          or excluded.status = 'succeeded'
        )
      )
    )
  returning true into recorded;

  if not coalesce(recorded, false) and exists (
    select 1
    from public.subscription_payments payment
    where payment.provider_payment_id = p_provider_payment_id
      and (
        payment.provider <> 'stripe'
        or payment.cafe_user_id <> p_cafe_user_id
      )
  ) then
    raise exception 'Stripe payment ownership conflict';
  end if;
  return coalesce(recorded, false);
end;
$$;

revoke execute on function public.record_stripe_subscription_payment(uuid, text, integer, text, text, timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.record_stripe_subscription_payment(uuid, text, integer, text, text, timestamptz, timestamptz) to service_role;
