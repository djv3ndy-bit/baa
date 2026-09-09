-- Preserve the exact Checkout payload across retries when the website adopts
-- embedded Checkout. Apply before deploying code that requests embedded mode.
alter table public.cafe_subscriptions
  add column if not exists stripe_checkout_ui_mode text;

comment on column public.cafe_subscriptions.stripe_checkout_ui_mode is
  'Immutable Checkout UI variant for the durable Stripe idempotency attempt; pre-existing attempts use hosted.';

update public.cafe_subscriptions
set stripe_checkout_ui_mode = 'hosted'
where stripe_checkout_attempt_id is not null
  and stripe_checkout_ui_mode is null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.cafe_subscriptions'::regclass
      and conname = 'cafe_subscriptions_stripe_checkout_ui_mode_check'
  ) then
    alter table public.cafe_subscriptions
      add constraint cafe_subscriptions_stripe_checkout_ui_mode_check
      check (stripe_checkout_ui_mode in ('hosted', 'embedded'));
  end if;
end;
$$;

-- Keep one RPC signature: existing callers that omit p_ui_mode resolve its
-- default, rather than competing with an overloaded four-argument function.
drop function if exists public.claim_stripe_checkout(uuid, uuid, uuid, text);

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
      stripe_checkout_ui_mode = case when p_clear_attempt then null else stripe_checkout_ui_mode end,
      updated_at = now()
  where user_id = p_user_id
    and stripe_checkout_claim_id = p_claim_id;
  get diagnostics affected = row_count;
  return affected = 1;
end;
$$;

create or replace function public.settle_stripe_checkout_attempt_for_deletion(
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
      stripe_checkout_ui_mode = null,
      updated_at = now()
  where user_id = p_user_id
    and stripe_checkout_claim_id = p_claim_id
    and stripe_checkout_claim_kind = 'deletion'
    and stripe_checkout_claim_expires_at > now();
  get diagnostics affected = row_count;
  return affected = 1;
end;
$$;

revoke execute on function public.claim_stripe_checkout(uuid, uuid, uuid, text, text) from public, anon, authenticated;
revoke execute on function public.release_stripe_checkout(uuid, uuid, boolean) from public, anon, authenticated;
revoke execute on function public.settle_stripe_checkout_attempt_for_deletion(uuid, uuid) from public, anon, authenticated;
grant execute on function public.claim_stripe_checkout(uuid, uuid, uuid, text, text) to service_role;
grant execute on function public.release_stripe_checkout(uuid, uuid, boolean) to service_role;
grant execute on function public.settle_stripe_checkout_attempt_for_deletion(uuid, uuid) to service_role;

notify pgrst, 'reload schema';
