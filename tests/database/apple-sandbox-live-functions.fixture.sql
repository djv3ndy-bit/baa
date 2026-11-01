-- Synthetic-fixture function definitions copied verbatim from the read-only live metadata snapshot.
-- No business rows, IDs, credentials, receipts or tokens are included.
CREATE OR REPLACE FUNCTION private.cafe_has_paid_job_entitlement(p_cafe_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
$function$;

REVOKE ALL ON FUNCTION private.cafe_has_paid_job_entitlement(uuid) FROM public,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION private.native_checkout_is_blocked(p_user_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'private'
AS $function$
  select exists(select 1 from private.native_billing_subscriptions s
    join private.native_billing_configuration c on s.environment=c.environment
    where s.user_id=p_user_id and s.superseded_by is null and s.revision>0 and (
      s.status in ('pending','payment_required') or
      (s.status in ('active','grace') and (s.auto_renews or s.current_period_end>now() or s.grace_period_end>now()))
    )) or exists(select 1 from private.native_checkout_attempts a
    join private.native_billing_configuration c on a.environment=c.environment
    where a.user_id=p_user_id and (a.state='started' or (a.state='reserved' and a.reserved_until>now())));
$function$;

REVOKE ALL ON FUNCTION private.native_checkout_is_blocked(uuid) FROM public,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.cafe_has_hiring_access(target_user_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
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
$function$;

REVOKE ALL ON FUNCTION public.cafe_has_hiring_access(uuid) FROM public,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.cafe_has_hiring_access(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.cafe_has_hiring_access(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.native_billing_access(p_user_id uuid, p_environment text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'private'
AS $function$
  select exists(select 1 from public.profiles where id=p_user_id and role='cafe_owner_manager' and suspended_at is null)
    and exists(select 1 from private.native_billing_subscriptions where user_id=p_user_id and environment=p_environment
    and superseded_by is null and ((status='active' and current_period_end>now()) or (status='grace' and grace_period_end>now())));
$function$;

REVOKE ALL ON FUNCTION public.native_billing_access(uuid,text) FROM public,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.native_billing_access(uuid,text) TO service_role;

CREATE OR REPLACE FUNCTION public.native_billing_account(p_user_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'private'
AS $function$
declare binding uuid;
begin
  if not exists(select 1 from public.profiles where id=p_user_id and role='cafe_owner_manager' and suspended_at is null) then
    raise exception 'Native billing requires an active cafe account';
  end if;
  insert into private.native_billing_accounts(user_id) values(p_user_id) on conflict(user_id) do nothing;
  select store_binding into binding from private.native_billing_accounts where user_id=p_user_id;
  return binding;
end;
$function$;

REVOKE ALL ON FUNCTION public.native_billing_account(uuid) FROM public,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.native_billing_account(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.native_billing_apply(p_user_id uuid, p_binding uuid, p_provider text, p_environment text, p_subscription_id text, p_product_id text, p_transaction_id text, p_status text, p_period_end timestamp with time zone, p_grace_end timestamp with time zone, p_auto_renews boolean, p_expected_revision bigint, p_linked_subscription_id text DEFAULT NULL::text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'private'
AS $function$
declare existing private.native_billing_subscriptions%rowtype;
  linked private.native_billing_subscriptions%rowtype;
  new_key text;
begin
  if p_expected_revision is null or p_expected_revision<0 or not exists(
    select 1 from private.native_billing_accounts where user_id=p_user_id and store_binding=p_binding
  ) then raise exception 'Native billing ownership could not be confirmed'; end if;
  -- Serialize one account's ownership changes, including Google token replacement.
  perform pg_advisory_xact_lock(hashtextextended('native-billing:'||p_user_id::text,0));
  new_key:=encode(sha256(convert_to(p_subscription_id,'UTF8')),'hex');
  if p_linked_subscription_id is not null and (p_provider<>'google' or p_linked_subscription_id=p_subscription_id or length(p_linked_subscription_id) not between 1 and 8192) then
    raise exception 'Invalid linked native subscription';
  end if;
  -- Insert a sentinel without access; concurrent writers synchronize on the
  -- unique provider subscription key, then compare the authoritative revision.
  insert into private.native_billing_subscriptions(provider,environment,provider_subscription_id,provider_subscription_key,user_id,product_id,transaction_id,status,auto_renews,revision)
  values(p_provider,p_environment,p_subscription_id,encode(sha256(convert_to(p_subscription_id,'UTF8')),'hex'),p_user_id,p_product_id,p_transaction_id,'pending',false,0)
  on conflict(provider,environment,provider_subscription_key) do nothing;
  select * into existing from private.native_billing_subscriptions
  where provider=p_provider and environment=p_environment and provider_subscription_key=encode(sha256(convert_to(p_subscription_id,'UTF8')),'hex') and provider_subscription_id=p_subscription_id for update;
  if not found then raise exception 'Native subscription identity conflict'; end if;
  if existing.user_id<>p_user_id then raise exception 'Native subscription belongs to another account'; end if;
  if existing.superseded_by is not null then return 'superseded'; end if;
  if existing.revision<>p_expected_revision then return 'retry'; end if;
  if p_linked_subscription_id is not null and p_status<>'pending' then
    -- Retain a tombstone even if the old token never reached this server, so
    -- a delayed restoration cannot reactivate the superseded purchase.
    insert into private.native_billing_subscriptions(provider,environment,provider_subscription_id,provider_subscription_key,user_id,product_id,transaction_id,status,auto_renews,revision,superseded_by)
    values(p_provider,p_environment,p_linked_subscription_id,encode(sha256(convert_to(p_linked_subscription_id,'UTF8')),'hex'),p_user_id,p_product_id,p_linked_subscription_id,'revoked',false,0,new_key)
    on conflict(provider,environment,provider_subscription_key) do nothing;
    select * into linked from private.native_billing_subscriptions
    where provider=p_provider and environment=p_environment and provider_subscription_key=encode(sha256(convert_to(p_linked_subscription_id,'UTF8')),'hex') for update;
    if linked.user_id<>p_user_id or linked.provider_subscription_id<>p_linked_subscription_id then
      raise exception 'Linked native subscription belongs to another account';
    end if;
    if linked.superseded_by is not null and linked.superseded_by<>new_key then
      raise exception 'Linked native subscription was already replaced';
    end if;
    update private.native_billing_subscriptions set status='revoked',auto_renews=false,superseded_by=new_key,revision=revision+1,verified_at=clock_timestamp()
    where provider=p_provider and environment=p_environment and provider_subscription_key=linked.provider_subscription_key and superseded_by is distinct from new_key;
  end if;

  if existing.revision>0 and existing.product_id=p_product_id and existing.transaction_id=p_transaction_id
    and existing.status=p_status and existing.current_period_end is not distinct from p_period_end
    and existing.grace_period_end is not distinct from p_grace_end and existing.auto_renews=p_auto_renews then return 'duplicate'; end if;
  update private.native_billing_subscriptions set product_id=p_product_id,transaction_id=p_transaction_id,status=p_status,
    current_period_end=p_period_end,grace_period_end=p_grace_end,auto_renews=p_auto_renews,
    revision=revision+1,verified_at=clock_timestamp()
  where provider=p_provider and environment=p_environment and provider_subscription_key=encode(sha256(convert_to(p_subscription_id,'UTF8')),'hex') and provider_subscription_id=p_subscription_id;
  return 'applied';
end;
$function$;

REVOKE ALL ON FUNCTION public.native_billing_apply(uuid,uuid,text,text,text,text,text,text,timestamp with time zone,timestamp with time zone,boolean,bigint,text) FROM public,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.native_billing_apply(uuid,uuid,text,text,text,text,text,text,timestamp with time zone,timestamp with time zone,boolean,bigint,text) TO service_role;

CREATE OR REPLACE FUNCTION public.native_billing_claim_event(p_provider text, p_environment text, p_event_id text, p_payload_hash text, p_claim_id uuid)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'private'
AS $function$
declare existing private.native_billing_events%rowtype;
begin
  if p_claim_id is null then raise exception 'Event claim required'; end if;
  insert into private.native_billing_events(provider,environment,event_id,payload_hash)
  values(p_provider,p_environment,p_event_id,p_payload_hash) on conflict(provider,environment,event_id) do nothing;
  select * into existing from private.native_billing_events where provider=p_provider and environment=p_environment and event_id=p_event_id for update;
  if existing.payload_hash<>p_payload_hash then raise exception 'Event identity conflict'; end if;
  if existing.processed_at is not null then return 'duplicate'; end if;
  if existing.claim_expires_at>now() then return 'busy'; end if;
  update private.native_billing_events set claim_id=p_claim_id,claim_expires_at=now()+interval '5 minutes',attempts=attempts+1
  where provider=p_provider and environment=p_environment and event_id=p_event_id;
  return 'claimed';
end;
$function$;

REVOKE ALL ON FUNCTION public.native_billing_claim_event(text,text,text,text,uuid) FROM public,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.native_billing_claim_event(text,text,text,text,uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.native_billing_finish_event(p_provider text, p_environment text, p_event_id text, p_claim_id uuid, p_success boolean)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'private'
AS $function$
declare affected integer;
begin
  if p_success is null then raise exception 'Event outcome required'; end if;
  update private.native_billing_events set processed_at=case when p_success then now() else null end,claim_id=null,claim_expires_at=null
  where provider=p_provider and environment=p_environment and event_id=p_event_id and claim_id=p_claim_id and claim_expires_at>now();
  get diagnostics affected=row_count; return affected=1;
end;
$function$;

REVOKE ALL ON FUNCTION public.native_billing_finish_event(text,text,text,uuid,boolean) FROM public,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.native_billing_finish_event(text,text,text,uuid,boolean) TO service_role;

CREATE OR REPLACE FUNCTION public.native_billing_owner(p_binding uuid)
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'private'
AS $function$
  select user_id from private.native_billing_accounts where store_binding=p_binding;
$function$;

REVOKE ALL ON FUNCTION public.native_billing_owner(uuid) FROM public,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.native_billing_owner(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.native_billing_read(p_provider text, p_environment text, p_subscription_id text)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'private'
AS $function$
  select to_jsonb(subscription) from private.native_billing_subscriptions subscription
  where provider=p_provider and environment=p_environment and provider_subscription_key=encode(sha256(convert_to(p_subscription_id,'UTF8')),'hex') and provider_subscription_id=p_subscription_id;
$function$;

REVOKE ALL ON FUNCTION public.native_billing_read(text,text,text) FROM public,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.native_billing_read(text,text,text) TO service_role;

CREATE OR REPLACE FUNCTION public.native_billing_summary(p_user_id uuid, p_environment text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'private'
AS $function$
begin
  if p_environment is null or p_environment not in ('Sandbox','Production') or not exists(
    select 1 from public.profiles where id=p_user_id and role='cafe_owner_manager' and suspended_at is null
  ) then raise exception 'Native billing requires an active cafe account'; end if;
  return jsonb_build_object('accountId',p_user_id,'environment',p_environment,'subscriptions',coalesce((
    select jsonb_agg(jsonb_build_object('provider',provider,'status',status,
      'currentPeriodEnd',current_period_end,'gracePeriodEnd',grace_period_end,'autoRenews',auto_renews)
      order by verified_at desc,provider,provider_subscription_key)
    from private.native_billing_subscriptions where user_id=p_user_id and environment=p_environment
      and superseded_by is null and revision>0
  ),'[]'::jsonb));
end;
$function$;

REVOKE ALL ON FUNCTION public.native_billing_summary(uuid,text) FROM public,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.native_billing_summary(uuid,text) TO service_role;

CREATE OR REPLACE FUNCTION public.native_checkout_cancel(p_user_id uuid, p_environment text, p_attempt_id uuid, p_before_launch boolean)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'private'
AS $function$
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
$function$;

REVOKE ALL ON FUNCTION public.native_checkout_cancel(uuid,text,uuid,boolean) FROM public,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.native_checkout_cancel(uuid,text,uuid,boolean) TO service_role;

CREATE OR REPLACE FUNCTION public.native_checkout_claim(p_user_id uuid, p_provider text, p_environment text, p_attempt_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'private'
AS $function$
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
$function$;

REVOKE ALL ON FUNCTION public.native_checkout_claim(uuid,text,text,uuid) FROM public,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.native_checkout_claim(uuid,text,text,uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.native_checkout_pending(p_user_id uuid, p_environment text)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'private'
AS $function$
begin
  if not exists(select 1 from private.native_billing_configuration where environment=p_environment) then raise exception 'Native checkout environment mismatch'; end if;
  return exists(select 1 from private.native_checkout_attempts where user_id=p_user_id and environment=p_environment
    and (state='started' or (state='reserved' and reserved_until>now())));
end;
$function$;

REVOKE ALL ON FUNCTION public.native_checkout_pending(uuid,text) FROM public,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.native_checkout_pending(uuid,text) TO service_role;

CREATE OR REPLACE FUNCTION public.native_checkout_provider(p_user_id uuid, p_environment text, p_attempt_id uuid)
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'private'
AS $function$
  select a.provider
  from private.native_checkout_attempts a
  where p_environment = 'Production'
    and a.id = p_attempt_id and a.user_id = p_user_id
    and a.environment = p_environment and a.state = 'reserved'
    and a.reserved_until > now()
    and exists (
      select 1 from private.native_billing_configuration c
      where c.singleton is true and c.environment = p_environment
    )
    and exists (
      select 1 from public.profiles p
      where p.id = p_user_id and p.role = 'cafe_owner_manager'
        and p.suspended_at is null
    );
$function$;

REVOKE ALL ON FUNCTION public.native_checkout_provider(uuid,text,uuid) FROM public,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.native_checkout_provider(uuid,text,uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.native_checkout_recover_apple(p_user_id uuid, p_environment text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'private'
AS $function$
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
$function$;

REVOKE ALL ON FUNCTION public.native_checkout_recover_apple(uuid,text) FROM public,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.native_checkout_recover_apple(uuid,text) TO service_role;

CREATE OR REPLACE FUNCTION public.native_checkout_settle_verified(p_user_id uuid, p_environment text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'private'
AS $function$
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
$function$;

REVOKE ALL ON FUNCTION public.native_checkout_settle_verified(uuid,text) FROM public,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.native_checkout_settle_verified(uuid,text) TO service_role;

CREATE OR REPLACE FUNCTION public.native_checkout_start(p_user_id uuid, p_environment text, p_attempt_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'private'
AS $function$
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
$function$;

REVOKE ALL ON FUNCTION public.native_checkout_start(uuid,text,uuid) FROM public,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.native_checkout_start(uuid,text,uuid) TO service_role;

