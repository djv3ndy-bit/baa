-- TEST FIXTURE ONLY: exact installed c9 schema/function overlay, excluding its pre/post deployment guards.
-- Provenance SHA256 c9ae045d25be7a1b6ab868b2db92a271032d9130d9fd151785f7f8ead7f54c75; production history20261102135619.
-- Applied AFTER existing apple-sandbox-fixture; original fixture files unchanged.
ALTER TABLE public.profiles ADD COLUMN is_discoverable boolean NOT NULL DEFAULT false, ADD COLUMN cafe_name text;
-- At most ONE identity for each purpose; app_review remains an exact known UUID.
CREATE TABLE private.apple_sandbox_test_allowlist (
  purpose text PRIMARY KEY CHECK(purpose IN ('app_review','owner_qa')),
  user_id uuid NOT NULL UNIQUE REFERENCES public.profiles(id) ON DELETE CASCADE,
  window_starts_at timestamptz,
  window_ends_at timestamptz,
  UNIQUE(user_id,purpose),
  CHECK((purpose='app_review' AND user_id='afc55a3d-4a94-4893-bd78-ac6410ac6aed'::uuid)
     OR (purpose='owner_qa' AND user_id<>'afc55a3d-4a94-4893-bd78-ac6410ac6aed'::uuid)),
  CHECK((window_starts_at IS NULL AND window_ends_at IS NULL)
     OR (window_starts_at IS NOT NULL AND window_ends_at IS NOT NULL
         AND isfinite(window_starts_at) AND isfinite(window_ends_at)
         AND window_ends_at>window_starts_at
         AND window_ends_at<=window_starts_at+CASE WHEN purpose='owner_qa' THEN interval '24 hours' ELSE interval '30 days' END))
);
ALTER TABLE private.apple_sandbox_test_allowlist ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.apple_sandbox_test_allowlist FROM public,anon,authenticated,service_role;

-- This is only a trusted registry entry for the EXISTING primary reviewer.
-- NULL windows plus EMPTY mapping grant no Sandbox routing or paid entitlement.
INSERT INTO private.apple_sandbox_test_allowlist(purpose,user_id)
  VALUES('app_review','afc55a3d-4a94-4893-bd78-ac6410ac6aed'::uuid);

ALTER TABLE private.apple_sandbox_test_accounts
  DROP CONSTRAINT apple_sandbox_test_accounts_user_id_check,
  ADD COLUMN purpose text NOT NULL,
  ADD COLUMN authorized_at timestamptz,
  ADD CONSTRAINT apple_sandbox_mapping_allowlist_fk FOREIGN KEY(user_id,purpose)
    REFERENCES private.apple_sandbox_test_allowlist(user_id,purpose)
    ON UPDATE NO ACTION ON DELETE NO ACTION DEFERRABLE INITIALLY IMMEDIATE,
  ADD CONSTRAINT apple_sandbox_mapping_purpose_window CHECK(
    (NOT enabled AND authorized_at IS NULL AND expires_at IS NULL)
    OR (enabled AND authorized_at IS NOT NULL AND expires_at IS NOT NULL
        AND isfinite(authorized_at) AND isfinite(expires_at)
        AND expires_at>authorized_at
        AND expires_at<=authorized_at+CASE WHEN purpose='owner_qa' THEN interval '24 hours' ELSE interval '30 days' END));

CREATE OR REPLACE FUNCTION private.native_billing_environment(p_user_id uuid,p_provider text DEFAULT NULL)
RETURNS text LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,private AS $environment$
DECLARE configured text; tester private.apple_sandbox_test_accounts%rowtype;
  admission private.apple_sandbox_test_allowlist%rowtype; observed_now timestamptz;
BEGIN
  IF current_setting('transaction_isolation')<>'read committed' THEN RETURN NULL; END IF;
  IF p_user_id IS NULL OR (p_provider IS NOT NULL AND p_provider NOT IN ('apple','google')) THEN RETURN NULL; END IF;
  SELECT environment INTO configured FROM private.native_billing_configuration WHERE singleton=true;
  IF configured IS NULL OR configured NOT IN ('Production','Sandbox') THEN RETURN NULL; END IF;
  SELECT * INTO tester FROM private.apple_sandbox_test_accounts WHERE user_id=p_user_id;
  observed_now:=clock_timestamp();
  IF configured='Production' AND FOUND AND tester.enabled AND tester.expires_at>observed_now THEN
    SELECT * INTO admission FROM private.apple_sandbox_test_allowlist WHERE user_id=p_user_id AND purpose=tester.purpose;
    IF NOT FOUND OR admission.window_starts_at IS NULL OR admission.window_ends_at IS NULL
      OR admission.window_starts_at>observed_now OR admission.window_ends_at<=observed_now
      OR tester.authorized_at<admission.window_starts_at OR tester.expires_at>admission.window_ends_at THEN RETURN NULL; END IF;
    IF p_provider='google' OR NOT EXISTS(
      SELECT 1 FROM public.profiles WHERE id=p_user_id AND role='cafe_owner_manager' AND suspended_at IS NULL
        AND (admission.purpose='app_review' OR (is_discoverable IS false AND left(btrim(cafe_name),9)='TEST ONLY'))
    ) THEN RETURN NULL; END IF;
    RETURN 'Sandbox';
  END IF;
  RETURN configured;
END;
$environment$;
REVOKE ALL ON FUNCTION private.native_billing_environment(uuid,text) FROM public,anon,authenticated,service_role;

-- Recorded authorized identities retain their own obligations after revoke or
-- expiry. Owner-QA state never becomes the primary reviewer's billing state.
CREATE OR REPLACE FUNCTION private.native_billing_retained_environment(p_user_id uuid,p_provider text,p_environment text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,private AS $retained$
  SELECT EXISTS(SELECT 1 FROM private.native_billing_configuration WHERE singleton=true AND environment=p_environment)
    OR (p_provider='apple' AND p_environment='Sandbox' AND EXISTS(
      SELECT 1 FROM private.apple_sandbox_test_accounts m
      JOIN private.apple_sandbox_test_allowlist a ON a.user_id=m.user_id AND a.purpose=m.purpose
      WHERE m.user_id=p_user_id));
$retained$;
REVOKE ALL ON FUNCTION private.native_billing_retained_environment(uuid,text,text) FROM public,anon,authenticated,service_role;

-- Same service-only RPC signature, with no client-provided purpose/window grant.
CREATE OR REPLACE FUNCTION public.native_billing_set_apple_sandbox_tester(p_user_id uuid,p_enabled boolean,p_expires_at timestamptz DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,private AS $set_tester$
DECLARE subscription public.cafe_subscriptions%rowtype;
  admission private.apple_sandbox_test_allowlist%rowtype; authorized_now timestamptz;
BEGIN
  IF p_user_id IS NULL OR p_enabled IS NULL OR current_setting('transaction_isolation')<>'read committed' THEN
    RAISE EXCEPTION 'Sandbox tester account is not eligible';
  END IF;
  -- Preserve subscription-row then advisory-lock order before reading authority.
  SELECT * INTO subscription FROM public.cafe_subscriptions WHERE user_id=p_user_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Sandbox tester account is unavailable'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('native-billing:'||p_user_id::text,0));
  SELECT * INTO admission FROM private.apple_sandbox_test_allowlist WHERE user_id=p_user_id FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Sandbox tester account is not eligible'; END IF;
  authorized_now:=clock_timestamp();
  IF p_enabled THEN
    IF NOT EXISTS(SELECT 1 FROM private.native_billing_configuration WHERE singleton=true AND environment='Production')
      OR NOT EXISTS(SELECT 1 FROM public.profiles WHERE id=p_user_id AND role='cafe_owner_manager' AND suspended_at IS NULL
        AND (admission.purpose='app_review' OR (is_discoverable IS false AND left(btrim(cafe_name),9)='TEST ONLY')))
      OR subscription.owner_paused_at IS NOT NULL
      OR admission.window_starts_at IS NULL OR admission.window_ends_at IS NULL
      OR admission.window_starts_at>authorized_now OR admission.window_ends_at<=authorized_now
      OR p_expires_at IS NULL OR p_expires_at<=authorized_now OR p_expires_at>admission.window_ends_at
      OR p_expires_at>(authorized_now+CASE WHEN admission.purpose='owner_qa' THEN interval '24 hours' ELSE interval '30 days' END)
      OR subscription.stripe_customer_id IS NOT NULL OR subscription.stripe_subscription_id IS NOT NULL
      OR subscription.stripe_checkout_attempt_id IS NOT NULL OR subscription.stripe_checkout_claim_id IS NOT NULL
      OR subscription.stripe_checkout_claim_expires_at IS NOT NULL
      OR subscription.status NOT IN ('trialing','canceled','expired')
      OR EXISTS(SELECT 1 FROM private.native_billing_subscriptions s WHERE s.user_id=p_user_id AND s.superseded_by IS NULL
        AND (s.status IN ('pending','payment_required')
          OR (s.status IN ('active','grace') AND (s.auto_renews OR s.current_period_end>clock_timestamp()
            OR s.grace_period_end>clock_timestamp() OR (s.current_period_end IS NULL AND s.grace_period_end IS NULL)))))
      OR EXISTS(SELECT 1 FROM private.native_checkout_attempts WHERE user_id=p_user_id AND state IN ('reserved','started')) THEN
      RAISE EXCEPTION 'Sandbox tester activation blocked by account, billing or approved window';
    END IF;
  END IF;
  INSERT INTO private.apple_sandbox_test_accounts(user_id,purpose,enabled,authorized_at,expires_at)
    VALUES(p_user_id,admission.purpose,p_enabled,CASE WHEN p_enabled THEN authorized_now ELSE NULL END,CASE WHEN p_enabled THEN p_expires_at ELSE NULL END)
  ON CONFLICT(user_id) DO UPDATE SET purpose=excluded.purpose,enabled=excluded.enabled,authorized_at=excluded.authorized_at,expires_at=excluded.expires_at,
    generation=private.apple_sandbox_test_accounts.generation+1,updated_at=clock_timestamp();
  RETURN public.native_billing_context(p_user_id,NULL);
END;
$set_tester$;
REVOKE ALL ON FUNCTION public.native_billing_set_apple_sandbox_tester(uuid,boolean,timestamptz) FROM public,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.native_billing_set_apple_sandbox_tester(uuid,boolean,timestamptz) TO service_role;

-- Owner-QA-only real-payment admission denials; wire signatures unchanged.
CREATE OR REPLACE FUNCTION public.native_checkout_claim(p_user_id uuid,p_provider text,p_environment text,p_attempt_id uuid,p_guard_protocol text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,private AS $claim$
DECLARE existing public.cafe_subscriptions%rowtype; binding uuid; tester_generation bigint;
BEGIN
  IF p_attempt_id IS NULL OR p_provider IS NULL OR p_provider NOT IN ('apple','google')
    OR p_environment IS NULL OR p_environment NOT IN ('Production','Sandbox')
    OR (p_guard_protocol IS NOT NULL AND p_guard_protocol<>'apple-app-transaction-v1') THEN RAISE EXCEPTION 'Native checkout unavailable'; END IF;
  SELECT * INTO existing FROM public.cafe_subscriptions WHERE user_id=p_user_id FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF p_environment='Production' AND EXISTS(SELECT 1 FROM private.apple_sandbox_test_allowlist WHERE user_id=p_user_id AND purpose='owner_qa') THEN RETURN NULL; END IF;
  IF p_environment IS DISTINCT FROM private.native_billing_environment(p_user_id,p_provider)
    OR existing.owner_paused_at IS NOT NULL
    OR NOT EXISTS(SELECT 1 FROM public.profiles WHERE id=p_user_id AND role='cafe_owner_manager' AND suspended_at IS NULL) THEN RETURN NULL; END IF;
  IF p_environment='Sandbox' AND EXISTS(SELECT 1 FROM private.native_billing_configuration WHERE environment='Production') THEN
    IF p_provider<>'apple' OR p_guard_protocol IS DISTINCT FROM 'apple-app-transaction-v1' THEN RETURN NULL; END IF;
    SELECT generation INTO tester_generation FROM private.apple_sandbox_test_accounts WHERE user_id=p_user_id AND enabled AND expires_at>clock_timestamp();
    IF NOT FOUND THEN RETURN NULL; END IF;
  END IF;
  IF existing.stripe_checkout_attempt_id IS NOT NULL
    OR (existing.stripe_checkout_claim_id IS NOT NULL AND existing.stripe_checkout_claim_expires_at>now())
    OR (existing.stripe_subscription_id IS NOT NULL AND existing.status IN ('active','trialing','past_due','unpaid','incomplete','paused'))
    OR private.native_checkout_is_blocked(p_user_id) THEN RETURN NULL; END IF;
  binding:=public.native_billing_account(p_user_id);
  UPDATE private.native_checkout_attempts SET state='expired',updated_at=now()
    WHERE user_id=p_user_id AND environment=p_environment AND state='reserved' AND reserved_until<=now();
  INSERT INTO private.native_checkout_attempts(id,user_id,provider,environment,state,reserved_until,guard_protocol,sandbox_tester_generation)
    VALUES(p_attempt_id,p_user_id,p_provider,p_environment,'reserved',now()+interval '5 minutes',p_guard_protocol,tester_generation);
  RETURN jsonb_build_object('attemptId',p_attempt_id,'accountBinding',binding);
END;
$claim$;

CREATE OR REPLACE FUNCTION public.native_checkout_start(p_user_id uuid,p_environment text,p_attempt_id uuid,p_guard_protocol text DEFAULT NULL)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,private AS $start$
DECLARE affected integer; attempt private.native_checkout_attempts%rowtype;
BEGIN
  PERFORM 1 FROM public.cafe_subscriptions WHERE user_id=p_user_id AND owner_paused_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  IF p_environment='Production' AND EXISTS(SELECT 1 FROM private.apple_sandbox_test_allowlist WHERE user_id=p_user_id AND purpose='owner_qa') THEN RETURN false; END IF;
  SELECT * INTO attempt FROM private.native_checkout_attempts WHERE user_id=p_user_id AND id=p_attempt_id AND environment=p_environment
    AND state='reserved' AND reserved_until>now();
  IF NOT FOUND OR p_environment IS DISTINCT FROM private.native_billing_environment(p_user_id,attempt.provider)
    OR (p_guard_protocol IS NOT NULL AND p_guard_protocol<>'apple-app-transaction-v1')
    OR NOT EXISTS(SELECT 1 FROM public.profiles WHERE id=p_user_id AND role='cafe_owner_manager' AND suspended_at IS NULL) THEN RETURN false; END IF;
  IF p_environment='Sandbox' AND EXISTS(SELECT 1 FROM private.native_billing_configuration WHERE environment='Production')
    AND (attempt.provider<>'apple' OR p_guard_protocol IS DISTINCT FROM 'apple-app-transaction-v1'
      OR attempt.guard_protocol IS DISTINCT FROM 'apple-app-transaction-v1'
      OR NOT EXISTS(SELECT 1 FROM private.apple_sandbox_test_accounts WHERE user_id=p_user_id AND enabled AND expires_at>clock_timestamp()
        AND generation=attempt.sandbox_tester_generation)) THEN RETURN false; END IF;
  IF EXISTS(SELECT 1 FROM public.cafe_subscriptions WHERE user_id=p_user_id
      AND (stripe_checkout_attempt_id IS NOT NULL OR (stripe_checkout_claim_id IS NOT NULL AND stripe_checkout_claim_expires_at>now())
        OR (stripe_subscription_id IS NOT NULL AND status IN ('active','trialing','past_due','unpaid','incomplete','paused'))))
    OR EXISTS(SELECT 1 FROM private.native_billing_subscriptions WHERE user_id=p_user_id AND superseded_by IS NULL AND revision>0
      AND private.native_billing_retained_environment(p_user_id,provider,environment)
      AND (status IN ('pending','payment_required') OR (status IN ('active','grace') AND (auto_renews OR current_period_end>now() OR grace_period_end>now())))) THEN RETURN false; END IF;
  UPDATE private.native_checkout_attempts SET state='started',updated_at=now()
    WHERE id=p_attempt_id AND user_id=p_user_id AND environment=p_environment AND state='reserved' AND reserved_until>now();
  GET DIAGNOSTICS affected=row_count; RETURN affected=1;
END;
$start$;

CREATE OR REPLACE FUNCTION public.native_checkout_recover_apple(p_user_id uuid,p_environment text,p_guard_protocol text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,private AS $recover$
DECLARE existing public.cafe_subscriptions%rowtype; result jsonb;
BEGIN
  SELECT * INTO existing FROM public.cafe_subscriptions WHERE user_id=p_user_id FOR UPDATE;
  IF p_environment='Production' AND EXISTS(SELECT 1 FROM private.apple_sandbox_test_allowlist WHERE user_id=p_user_id AND purpose='owner_qa') THEN RETURN NULL; END IF;
  IF NOT FOUND OR existing.owner_paused_at IS NOT NULL
    OR p_environment IS DISTINCT FROM private.native_billing_environment(p_user_id,'apple')
    OR (p_guard_protocol IS NOT NULL AND p_guard_protocol<>'apple-app-transaction-v1')
    OR NOT EXISTS(SELECT 1 FROM public.profiles WHERE id=p_user_id AND role='cafe_owner_manager' AND suspended_at IS NULL) THEN RETURN NULL; END IF;
  IF existing.stripe_checkout_attempt_id IS NOT NULL
    OR (existing.stripe_checkout_claim_id IS NOT NULL AND existing.stripe_checkout_claim_expires_at>now())
    OR (existing.stripe_subscription_id IS NOT NULL AND existing.status IN ('active','trialing','past_due','unpaid','incomplete','paused'))
    OR EXISTS(SELECT 1 FROM private.native_billing_subscriptions WHERE user_id=p_user_id AND superseded_by IS NULL AND revision>0
      AND private.native_billing_retained_environment(p_user_id,provider,environment)
      AND (status IN ('pending','payment_required') OR (status IN ('active','grace') AND (auto_renews OR current_period_end>now() OR grace_period_end>now())))) THEN RETURN NULL; END IF;
  SELECT jsonb_build_object('attemptId',a.id,'accountBinding',b.store_binding) INTO result
    FROM private.native_checkout_attempts a JOIN private.native_billing_accounts b ON b.user_id=a.user_id
    WHERE a.user_id=p_user_id AND a.environment=p_environment AND a.provider='apple' AND a.state='started'
      AND (NOT EXISTS(SELECT 1 FROM private.native_billing_configuration WHERE environment='Production') OR p_environment<>'Sandbox'
        OR (p_guard_protocol='apple-app-transaction-v1' AND a.guard_protocol='apple-app-transaction-v1'
          AND EXISTS(SELECT 1 FROM private.apple_sandbox_test_accounts t WHERE t.user_id=p_user_id AND t.enabled
            AND t.expires_at>clock_timestamp() AND t.generation=a.sandbox_tester_generation)));
  RETURN result;
END;
$recover$;

CREATE OR REPLACE FUNCTION public.native_checkout_provider(p_user_id uuid,p_environment text,p_attempt_id uuid)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,private AS $provider$
  SELECT a.provider FROM private.native_checkout_attempts a
  WHERE a.id=p_attempt_id AND a.user_id=p_user_id AND a.environment=p_environment
    AND NOT (p_environment='Production' AND EXISTS(SELECT 1 FROM private.apple_sandbox_test_allowlist WHERE user_id=p_user_id AND purpose='owner_qa'))
    AND a.state='reserved' AND a.reserved_until>now()
    AND p_environment=private.native_billing_environment(p_user_id,a.provider)
    AND EXISTS(SELECT 1 FROM public.profiles WHERE id=p_user_id AND role='cafe_owner_manager' AND suspended_at IS NULL)
    AND EXISTS(SELECT 1 FROM public.cafe_subscriptions WHERE user_id=p_user_id AND owner_paused_at IS NULL)
    AND (p_environment<>'Sandbox' OR NOT EXISTS(SELECT 1 FROM private.native_billing_configuration WHERE environment='Production')
      OR (a.guard_protocol='apple-app-transaction-v1' AND EXISTS(
        SELECT 1 FROM private.apple_sandbox_test_accounts t WHERE t.user_id=p_user_id AND t.enabled AND t.expires_at>clock_timestamp()
          AND t.generation=a.sandbox_tester_generation)));
$provider$;

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
  -- Serialize current authorization with mapping changes and existing web checkout.
  -- A deleted owner may still receive an owned historical financial reversal.
  perform 1 from public.cafe_subscriptions where user_id=p_user_id for update;
  perform pg_advisory_xact_lock(hashtextextended('native-billing:'||p_user_id::text,0));
  -- A dedicated owner-QA identity may never acquire fresh real-store access.
  -- Exact owned historical terminal corrections remain authoritative cleanup.
  if p_environment='Production' and EXISTS(SELECT 1 FROM private.apple_sandbox_test_allowlist WHERE user_id=p_user_id AND purpose='owner_qa')
    and not (p_status in ('expired','revoked') and exists(
      select 1 from private.native_billing_subscriptions where user_id=p_user_id
        and provider=p_provider and environment=p_environment and revision>0
        and provider_subscription_key=encode(sha256(convert_to(p_subscription_id,'UTF8')),'hex')
        and provider_subscription_id=p_subscription_id
    )) then raise exception 'Owner-QA Production native state is not authorized'; end if;
  if p_environment is distinct from private.native_billing_environment(p_user_id,p_provider) and not (
    p_status in ('expired','revoked') and exists(
      select 1 from private.native_billing_subscriptions where user_id=p_user_id
        and provider=p_provider and environment=p_environment and revision>0
        and provider_subscription_key=encode(sha256(convert_to(p_subscription_id,'UTF8')),'hex')
        and provider_subscription_id=p_subscription_id
    )
  ) then raise exception 'Native billing account environment is not authorized'; end if;
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

CREATE OR REPLACE FUNCTION public.native_billing_access(p_user_id uuid,p_environment text)
RETURNS boolean LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,private AS $access$
  SELECT NOT (p_environment='Production' AND EXISTS(SELECT 1 FROM private.apple_sandbox_test_allowlist WHERE user_id=p_user_id AND purpose='owner_qa'))
    AND EXISTS(SELECT 1 FROM public.profiles WHERE id=p_user_id AND role='cafe_owner_manager' AND suspended_at IS NULL)
    AND EXISTS(SELECT 1 FROM public.cafe_subscriptions WHERE user_id=p_user_id AND owner_paused_at IS NULL)
    AND EXISTS(SELECT 1 FROM private.native_billing_subscriptions s
      WHERE s.user_id=p_user_id AND s.environment=p_environment AND s.superseded_by IS NULL AND s.revision>0
        AND s.environment=private.native_billing_environment(p_user_id,s.provider)
        AND ((s.status='active' AND s.current_period_end>now()) OR (s.status='grace' AND s.grace_period_end>now())));
$access$;

CREATE OR REPLACE FUNCTION public.claim_stripe_checkout(p_user_id uuid, p_claim_id uuid, p_attempt_id uuid, p_channel text, p_ui_mode text DEFAULT 'hosted'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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

  -- After the shared cafe row lock, require fresh authority. A stale
  -- repeatable/serializable snapshot cannot safely establish non-QA admission.
  if current_setting('transaction_isolation')<>'read committed' then return null; end if;
  -- Dedicated owner-QA is Sandbox-only; never create a real Stripe checkout.
  if EXISTS(SELECT 1 FROM private.apple_sandbox_test_allowlist WHERE user_id=p_user_id AND purpose='owner_qa') then return null; end if;

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
$function$;

REVOKE ALL ON FUNCTION public.native_checkout_claim(uuid,text,text,uuid,text),
  public.native_checkout_start(uuid,text,uuid,text),public.native_checkout_recover_apple(uuid,text,text),
  public.native_checkout_provider(uuid,text,uuid),
  public.native_billing_apply(uuid,uuid,text,text,text,text,text,text,timestamptz,timestamptz,boolean,bigint,text),
  public.native_billing_access(uuid,text),public.claim_stripe_checkout(uuid,uuid,uuid,text,text)
  FROM public,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.native_checkout_claim(uuid,text,text,uuid,text),
  public.native_checkout_start(uuid,text,uuid,text),public.native_checkout_recover_apple(uuid,text,text),
  public.native_checkout_provider(uuid,text,uuid),
  public.native_billing_apply(uuid,uuid,text,text,text,text,text,text,timestamptz,timestamptz,boolean,bigint,text),
  public.native_billing_access(uuid,text),public.claim_stripe_checkout(uuid,uuid,uuid,text,text) TO service_role;


REVOKE USAGE ON SCHEMA private FROM service_role;
