-- REVIEW ARTIFACT ONLY. No grant/allowlist/CID is seeded and access starts off.
-- EXECUTOR MUST independently verify hosted project ojvjlvojvozvhktbclcg before
-- applying. PostgreSQL cannot attest its Supabase project ref; Sandbox/config
-- values are defense in depth, not proof of hosted identity. Never apply this
-- Android-only artifact to Apple review or production. Explicit approval of
-- target, account allowlist, CID, enablement and expiry is required separately.
begin;
set local lock_timeout='3s';
do $$ begin
  if (select count(*)=1 and bool_and(singleton and environment='Sandbox')
      from private.native_billing_configuration) is distinct from true then
    raise exception 'Android reviewer access requires the existing Sandbox configuration';
  end if;
end $$;

create table private.android_reviewer_configuration (
  singleton boolean primary key default true check(singleton),
  enabled boolean not null default false,
  project_ref text not null default 'ojvjlvojvozvhktbclcg' check(project_ref='ojvjlvojvozvhktbclcg'),
  api_base_url text not null default 'https://android-testing.baristajobmatch.com/api'
    check(api_base_url='https://android-testing.baristajobmatch.com/api'),
  package_name text not null default 'com.baristajobmatch.app' check(package_name='com.baristajobmatch.app'),
  environment text not null default 'Sandbox' check(environment='Sandbox'),
  custom_environment_id text,
  allowed_user_ids uuid[] not null default '{}',
  check(cardinality(allowed_user_ids)<=8 and array_position(allowed_user_ids,null) is null),
  check(not enabled or (cardinality(allowed_user_ids)>0 and custom_environment_id is not null
    and custom_environment_id ~ '^[A-Za-z0-9_-]{8,128}$'
    and custom_environment_id !~* 'placeholder|replace|pending|example'))
);
insert into private.android_reviewer_configuration(singleton) values(true);
alter table private.android_reviewer_configuration enable row level security;
revoke all on private.android_reviewer_configuration from public,anon,authenticated,service_role;

create table private.android_reviewer_grants (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  check(isfinite(created_at) and isfinite(expires_at) and expires_at>created_at),
  check(revoked_at is null or (isfinite(revoked_at) and revoked_at>=created_at))
);
alter table private.android_reviewer_grants enable row level security;
revoke all on private.android_reviewer_grants from public,anon,authenticated,service_role;

-- Reuse the saved role and baseline unpaused hiring-access requirements. A
-- grant cannot label a suspended/deleted/paused account as fully accessible.
create function private.android_reviewer_account_eligible(p_user_id uuid) returns boolean
language sql stable security definer set search_path='' as $$
  select exists(select 1 from auth.users u join public.profiles p on p.id=u.id
    join public.cafe_subscriptions s on s.user_id=p.id
    where u.id=p_user_id and p.role='cafe_owner_manager' and p.suspended_at is null
      and s.owner_paused_at is null and (s.complimentary_access or s.status='active'
        or (s.status='trialing' and s.trial_ends_at>now())));
$$;
revoke all on function private.android_reviewer_account_eligible(uuid) from public,anon,authenticated,service_role;

create function private.android_reviewer_expiry(p_user_id uuid) returns timestamptz
language sql stable security definer set search_path='' as $$
  select g.expires_at from private.android_reviewer_grants g
    join private.android_reviewer_configuration c on c.singleton and c.enabled
    join private.native_billing_configuration n on n.singleton and n.environment='Sandbox'
    where g.user_id=p_user_id and p_user_id=any(c.allowed_user_ids)
      and c.project_ref='ojvjlvojvozvhktbclcg'
      and c.api_base_url='https://android-testing.baristajobmatch.com/api'
      and c.package_name='com.baristajobmatch.app' and c.environment='Sandbox'
      and g.revoked_at is null and g.created_at<=now() and g.expires_at>now()
      and private.android_reviewer_account_eligible(p_user_id);
$$;
revoke all on function private.android_reviewer_expiry(uuid) from public,anon,authenticated,service_role;

create function public.android_reviewer_access(p_user_id uuid,p_environment text,p_custom_environment_id text) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare c private.android_reviewer_configuration%rowtype; expiry timestamptz;
begin
  select * into c from private.android_reviewer_configuration where singleton;
  if not found then raise exception 'Android reviewer configuration unavailable'; end if;
  if not c.enabled then return null; end if;
  if p_environment is distinct from 'Sandbox' or p_custom_environment_id is distinct from c.custom_environment_id
    or not exists(select 1 from private.native_billing_configuration where singleton and environment='Sandbox') then
    raise exception 'Android reviewer configuration mismatch';
  end if;
  expiry:=private.android_reviewer_expiry(p_user_id);
  if expiry is null then return null; end if;
  return jsonb_build_object('accountId',p_user_id,'environment','Sandbox',
    'reviewAccess',jsonb_build_object('active',true,'expiresAt',expiry));
end $$;
revoke all on function public.android_reviewer_access(uuid,text,text) from public,anon,authenticated,service_role;
grant execute on function public.android_reviewer_access(uuid,text,text) to service_role;

-- Keep every Stripe/native entitlement predicate and the existing 3-job/free
-- ledger rules. Only this target-specific private grant is additive.
create or replace function private.cafe_has_paid_job_entitlement(p_cafe_id uuid) returns boolean
language sql stable security definer set search_path='' as $$
  select exists(select 1 from public.cafe_subscriptions s where s.user_id=p_cafe_id
    and s.stripe_customer_id ~ '^cus_[A-Za-z0-9_]+$' and length(s.stripe_customer_id)<=255
    and s.stripe_subscription_id ~ '^sub_[A-Za-z0-9_]+$' and length(s.stripe_subscription_id)<=255
    and (s.status='active' or (s.status='trialing' and s.trial_ends_at>now())))
  or public.native_billing_access(p_cafe_id,(select environment from private.native_billing_configuration where singleton))
  or private.android_reviewer_expiry(p_cafe_id) is not null;
$$;
revoke all on function private.cafe_has_paid_job_entitlement(uuid) from public,anon,authenticated,service_role;

create or replace function private.native_checkout_is_blocked(p_user_id uuid) returns boolean
language sql stable security definer set search_path=pg_catalog,private as $$
  select exists(select 1 from private.native_billing_subscriptions s
    join private.native_billing_configuration c on s.environment=c.environment
    where s.user_id=p_user_id and s.superseded_by is null and s.revision>0 and (
      s.status in ('pending','payment_required') or
      (s.status in ('active','grace') and (s.auto_renews or s.current_period_end>now() or s.grace_period_end>now()))))
  or exists(select 1 from private.native_checkout_attempts a
    join private.native_billing_configuration c on a.environment=c.environment
    where a.user_id=p_user_id and (a.state='started' or (a.state='reserved' and a.reserved_until>now())))
  or private.android_reviewer_expiry(p_user_id) is not null;
$$;
revoke all on function private.native_checkout_is_blocked(uuid) from public,anon,authenticated,service_role;

-- Checkout claim/start already lock the cafe subscription row. A trigger also
-- rechecks grants at the final reserved/started write, closing a prepare/start
-- race without replacing any receipt, provider, or existing checkout function.
create function private.android_reviewer_checkout_guard() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if new.state in ('reserved','started') and private.android_reviewer_expiry(new.user_id) is not null then
    raise exception 'Reviewer access blocks new checkout';
  end if;
  return new;
end $$;
revoke all on function private.android_reviewer_checkout_guard() from public,anon,authenticated,service_role;
create trigger android_reviewer_checkout_guard before insert or update of state on private.native_checkout_attempts
  for each row execute function private.android_reviewer_checkout_guard();

create function private.android_reviewer_checkout_open(p_user_id uuid) returns boolean
language sql stable security definer set search_path='' as $$
  select exists(select 1 from private.native_checkout_attempts where user_id=p_user_id
    and environment='Sandbox' and (state='started' or (state='reserved' and reserved_until>now())))
  or exists(select 1 from public.cafe_subscriptions where user_id=p_user_id
    and (stripe_checkout_attempt_id is not null or (stripe_checkout_claim_kind='checkout'
      and stripe_checkout_claim_id is not null and stripe_checkout_claim_expires_at>now())));
$$;
revoke all on function private.android_reviewer_checkout_open(uuid) from public,anon,authenticated,service_role;

-- Owner activation shares the existing checkout/deletion lock. It refuses to
-- activate over an already reserved/started payment; revoke/expire is allowed.
create function private.android_reviewer_activation_guard() returns trigger
language plpgsql security definer set search_path='' as $$
declare active_configuration boolean;
begin
  if tg_table_name='android_reviewer_grants' then
    perform 1 from public.cafe_subscriptions where user_id=new.user_id for update;
    if new.revoked_at is not null or new.expires_at<=now() then return new; end if;
    if tg_op='UPDATE' and new.user_id=old.user_id and new.created_at=old.created_at
      and new.revoked_at is not distinct from old.revoked_at and new.expires_at<=old.expires_at then return new; end if;
    if not private.android_reviewer_account_eligible(new.user_id) then
      raise exception 'Reviewer requires an active unpaused cafe with existing hiring access';
    end if;
    select enabled and new.user_id=any(allowed_user_ids) into active_configuration
      from private.android_reviewer_configuration where singleton;
    if active_configuration and new.revoked_at is null and new.created_at<=now() and new.expires_at>now()
      and private.android_reviewer_checkout_open(new.user_id) then raise exception 'Reviewer checkout is still pending'; end if;
  else
    perform 1 from public.cafe_subscriptions where user_id=any(new.allowed_user_ids) order by user_id for update;
    if new.enabled and exists(select 1 from private.android_reviewer_grants g
      where g.user_id=any(new.allowed_user_ids) and g.revoked_at is null and g.created_at<=now() and g.expires_at>now()
      and (not private.android_reviewer_account_eligible(g.user_id) or private.android_reviewer_checkout_open(g.user_id))) then
      raise exception 'Reviewer account unavailable or checkout is still pending';
    end if;
  end if;
  return new;
end $$;
revoke all on function private.android_reviewer_activation_guard() from public,anon,authenticated,service_role;
create trigger android_reviewer_grants_activation before insert or update on private.android_reviewer_grants
  for each row execute function private.android_reviewer_activation_guard();
create trigger android_reviewer_configuration_activation before insert or update on private.android_reviewer_configuration
  for each row execute function private.android_reviewer_activation_guard();
commit;
