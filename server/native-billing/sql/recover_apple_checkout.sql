-- Additive recovery query. It does not release, expire, replace or create any
-- checkout, subscription, customer or entitlement. Apply after coordination.
create function public.native_checkout_recover_apple(p_user_id uuid,p_environment text) returns jsonb
language plpgsql security definer set search_path=pg_catalog,private as $$
declare existing public.cafe_subscriptions%rowtype; result jsonb;
begin
  if not exists(select 1 from private.native_billing_configuration where environment=p_environment)
    or not exists(select 1 from public.profiles where id=p_user_id and role='cafe_owner_manager' and suspended_at is null) then return null; end if;
  -- Serialize the eligibility check with the existing website checkout lock.
  select * into existing from public.cafe_subscriptions where user_id=p_user_id for update;
  if not found then return null; end if;
  if existing.stripe_checkout_attempt_id is not null
    or (existing.stripe_checkout_claim_id is not null and existing.stripe_checkout_claim_expires_at>now())
    or (existing.stripe_subscription_id is not null and existing.status in ('active','trialing','past_due','unpaid','incomplete','paused'))
    or exists(select 1 from private.native_billing_subscriptions where user_id=p_user_id and environment=p_environment
      and superseded_by is null and revision>0 and (status in ('pending','payment_required')
        or (status in ('active','grace') and (auto_renews or current_period_end>now() or grace_period_end>now())))) then return null; end if;
  select jsonb_build_object('attemptId',a.id,'accountBinding',b.store_binding) into result
    from private.native_checkout_attempts a join private.native_billing_accounts b on b.user_id=a.user_id
    where a.user_id=p_user_id and a.environment=p_environment and a.provider='apple' and a.state='started';
  return result;
end;
$$;
revoke all on function public.native_checkout_recover_apple(uuid,text) from public,anon,authenticated;
grant execute on function public.native_checkout_recover_apple(uuid,text) to service_role;
