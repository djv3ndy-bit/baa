-- REVIEW PROPOSAL ONLY. Apply after the native ledger and checkout configuration.
-- Preserve every existing Stripe predicate and job limit; add verified native
-- access for the same account in the explicitly configured backend environment.
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
  ) or public.native_billing_access(p_cafe_id, (
    select environment from private.native_billing_configuration where singleton=true
  ));
$$;

comment on function private.cafe_has_paid_job_entitlement(uuid) is
  'Paid job access from existing Stripe rules or a verified, unexpired native subscription. Complimentary access never satisfies paid job access.';
