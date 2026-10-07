-- REVIEWED DEPLOYMENT PREREQUISITE, NOT APPLIED BY THE APPLICATION.
-- Apply after review/native-checkout-coordination.sql and before enabling the
-- separate Google gate. Default-off Apple APIs need no new schema.
-- One transaction ensures Google capability cannot appear partially installed.
begin;

create or replace function public.native_checkout_start_for_provider(
  p_user_id uuid,p_environment text,p_attempt_id uuid,p_provider text
) returns boolean
language plpgsql security definer set search_path=pg_catalog,private as $$
declare affected integer;
begin
  if p_provider is null or p_provider not in ('apple','google')
    or not exists(select 1 from private.native_billing_configuration where environment=p_environment)
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
    where id=p_attempt_id and user_id=p_user_id and environment=p_environment
      and provider=p_provider and state='reserved' and reserved_until>now();
  get diagnostics affected=row_count;return affected=1;
end;
$$;

-- Existing Apple API deployments keep their three-argument contract. They may
-- never use the older generic start path for a new Google reservation.
create or replace function public.native_checkout_start(p_user_id uuid,p_environment text,p_attempt_id uuid) returns boolean
language sql security definer set search_path=pg_catalog,private as $$
  select public.native_checkout_start_for_provider(p_user_id,p_environment,p_attempt_id,'apple');
$$;

-- Only server-side service-role transport can read an authenticated account's
-- reservation provider. No token, account binding or other account is exposed.
create or replace function public.native_checkout_provider(p_user_id uuid,p_environment text,p_attempt_id uuid) returns text
language plpgsql stable security definer set search_path=pg_catalog,private as $$
begin
  if not exists(select 1 from private.native_billing_configuration where environment=p_environment) then
    raise exception 'Native checkout environment mismatch';
  end if;
  if not exists(select 1 from public.profiles where id=p_user_id and role='cafe_owner_manager' and suspended_at is null) then return null; end if;
  return (select provider from private.native_checkout_attempts
    where id=p_attempt_id and user_id=p_user_id and environment=p_environment
      and state='reserved' and reserved_until>now());
end;
$$;

revoke all on function public.native_checkout_start_for_provider(uuid,text,uuid,text) from public,anon,authenticated;
revoke all on function public.native_checkout_start(uuid,text,uuid) from public,anon,authenticated;
revoke all on function public.native_checkout_provider(uuid,text,uuid) from public,anon,authenticated;
grant execute on function public.native_checkout_start_for_provider(uuid,text,uuid,text) to service_role;
grant execute on function public.native_checkout_start(uuid,text,uuid) to service_role;
grant execute on function public.native_checkout_provider(uuid,text,uuid) to service_role;

commit;
