-- LOCAL REVIEW SOURCE ONLY. Package via a guarded migration before any deployment.
-- Both interfaces are server-only; raw chain/binding values must never reach HTTP clients.
-- No existing billing RPC is replaced and no table/schema privilege is widened.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
DO $baseline$
DECLARE contract record;
BEGIN
  IF to_regclass('private.apple_sandbox_test_allowlist') IS NULL
    OR (SELECT count(*) FROM pg_attribute WHERE attrelid=to_regclass('private.apple_sandbox_test_accounts')
      AND attname IN ('purpose','generation','authorized_at','expires_at','enabled') AND attnum>0 AND NOT attisdropped)<>5
    OR (SELECT count(*) FROM pg_attribute WHERE attrelid=to_regclass('private.apple_sandbox_test_allowlist')
      AND attname IN ('purpose','user_id','window_starts_at','window_ends_at') AND attnum>0 AND NOT attisdropped)<>4 THEN
    RAISE EXCEPTION 'Owned Apple refresh requires the reviewed isolation schema';
  END IF;
  SELECT p.prosecdef,p.provolatile,p.proconfig,pg_get_userbyid(p.proowner) owner,md5(p.prosrc) body_md5
    INTO contract FROM pg_proc p WHERE p.oid=to_regprocedure('public.native_billing_apply(uuid,uuid,text,text,text,text,text,text,timestamptz,timestamptz,boolean,bigint,text)');
  IF NOT FOUND OR contract.owner<>'postgres' OR NOT contract.prosecdef OR contract.provolatile<>'v'
    OR contract.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, private']::text[]
    OR contract.body_md5<>'8ac198622b1cdb05c6e52a5ecae7e0f6' THEN
    RAISE EXCEPTION 'Owned Apple refresh apply baseline drift';
  END IF;
END;
$baseline$;

CREATE FUNCTION public.native_billing_owned_apple_refresh(p_user_id uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,private SET lock_timeout='1s' AS $snapshot$
DECLARE observed_at timestamptz; candidates jsonb;
BEGIN
  IF current_setting('transaction_isolation')<>'read committed' OR p_user_id IS NULL THEN RETURN NULL; END IF;
  observed_at:=clock_timestamp();
  SELECT jsonb_agg(x.item) INTO candidates FROM (
    SELECT jsonb_build_object('userId',s.user_id,'provider','apple','environment','Sandbox',
      'subscriptionId',s.provider_subscription_id,'binding',b.store_binding,'productId',s.product_id,
      'status',s.status,'autoRenews',s.auto_renews,'revision',s.revision,'generation',m.generation,
      'verifiedAt',s.verified_at,'currentPeriodEnd',s.current_period_end,'gracePeriodEnd',s.grace_period_end,
      'authorizedAt',m.authorized_at,'expiresAt',m.expires_at,
      'windowStartsAt',a.window_starts_at,'windowEndsAt',a.window_ends_at) AS item
    FROM private.native_billing_subscriptions s
    JOIN private.native_billing_accounts b ON b.user_id=s.user_id
    JOIN public.profiles p ON p.id=s.user_id
    JOIN public.cafe_subscriptions c ON c.user_id=s.user_id
    JOIN private.apple_sandbox_test_accounts m ON m.user_id=s.user_id AND m.purpose='app_review'
    JOIN private.apple_sandbox_test_allowlist a ON a.user_id=m.user_id AND a.purpose=m.purpose
    WHERE s.user_id=p_user_id AND p.role='cafe_owner_manager' AND p.suspended_at IS NULL
      AND c.owner_paused_at IS NULL
      AND EXISTS(SELECT 1 FROM private.native_billing_configuration WHERE singleton IS TRUE AND environment='Production')
      AND m.enabled IS TRUE AND m.generation BETWEEN 1 AND 9007199254740991
      AND m.authorized_at IS NOT NULL AND m.authorized_at<=observed_at
      AND m.expires_at>observed_at AND m.authorized_at>=a.window_starts_at
      AND m.expires_at<=a.window_ends_at AND a.window_starts_at<=observed_at AND a.window_ends_at>observed_at
      AND private.native_billing_environment(p_user_id,'apple')='Sandbox'
      AND b.store_binding IS NOT NULL AND s.provider='apple' AND s.environment='Sandbox'
      AND s.product_id='com.baristajobmatch.cafe.pro.monthly'
      AND s.revision BETWEEN 1 AND 9007199254740991 AND s.superseded_by IS NULL
      AND s.status IN ('active','grace','payment_required')
      AND s.verified_at IS NOT NULL AND isfinite(s.verified_at) AND s.verified_at<=observed_at-interval '60 seconds'
      AND length(s.provider_subscription_id) BETWEEN 1 AND 255 AND length(s.transaction_id)>0
      AND s.provider_subscription_key=encode(sha256(convert_to(s.provider_subscription_id,'UTF8')),'hex')
      AND (CASE WHEN s.status='grace' THEN coalesce(s.grace_period_end,s.current_period_end) ELSE s.current_period_end END)<=observed_at
    ORDER BY s.provider_subscription_key LIMIT 2
  ) x;
  IF candidates IS NULL OR jsonb_array_length(candidates)<>1 THEN RETURN NULL; END IF;
  RETURN candidates->0;
END;
$snapshot$;

CREATE FUNCTION public.native_billing_apply_owned_apple_refresh(
  p_user_id uuid,p_binding uuid,p_subscription_id text,p_expected_revision bigint,p_expected_generation bigint,
  p_expected_authorized_at timestamptz,p_expected_expires_at timestamptz,
  p_expected_window_start timestamptz,p_expected_window_end timestamptz,
  p_product_id text,p_transaction_id text,p_status text,p_period_end timestamptz,p_grace_end timestamptz,p_auto_renews boolean)
RETURNS text LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,private SET lock_timeout='1s' AS $apply_owned$
DECLARE recorded private.native_billing_subscriptions%rowtype; authority record;
  configured text; observed_at timestamptz; eligible_count integer;
BEGIN
  IF current_setting('transaction_isolation')<>'read committed' OR p_user_id IS NULL OR p_binding IS NULL
    OR p_subscription_id IS NULL OR length(p_subscription_id) NOT BETWEEN 1 AND 255
    OR p_expected_revision IS NULL OR p_expected_revision NOT BETWEEN 1 AND 9007199254740991
    OR p_expected_generation IS NULL OR p_expected_generation NOT BETWEEN 1 AND 9007199254740991
    OR p_expected_authorized_at IS NULL OR NOT isfinite(p_expected_authorized_at)
    OR p_expected_expires_at IS NULL OR NOT isfinite(p_expected_expires_at)
    OR p_expected_window_start IS NULL OR NOT isfinite(p_expected_window_start)
    OR p_expected_window_end IS NULL OR NOT isfinite(p_expected_window_end)
    OR p_product_id IS DISTINCT FROM 'com.baristajobmatch.cafe.pro.monthly'
    OR p_transaction_id IS NULL OR length(p_transaction_id) NOT BETWEEN 1 AND 8192
    OR p_status IS NULL OR p_status NOT IN ('active','grace','payment_required','expired','revoked')
    OR p_period_end IS NULL OR NOT isfinite(p_period_end) OR p_period_end<='1970-01-01'::timestamptz
    OR (p_grace_end IS NOT NULL AND (NOT isfinite(p_grace_end) OR p_grace_end<='1970-01-01'::timestamptz))
    OR p_auto_renews IS NULL THEN RETURN 'stale'; END IF;
  -- Same leading lock order as checkout, tester mutation and the existing apply.
  PERFORM 1 FROM public.cafe_subscriptions WHERE user_id=p_user_id AND owner_paused_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RETURN 'stale'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('native-billing:'||p_user_id::text,0));
  SELECT * INTO recorded FROM private.native_billing_subscriptions
    WHERE provider='apple' AND environment='Sandbox' AND user_id=p_user_id
      AND provider_subscription_key=encode(sha256(convert_to(p_subscription_id,'UTF8')),'hex')
      AND provider_subscription_id=p_subscription_id FOR UPDATE;
  IF NOT FOUND THEN RETURN 'stale'; END IF;
  -- Locks retain identity/authority while the existing apply runs. No HTTP occurs here.
  PERFORM 1 FROM private.native_billing_accounts WHERE user_id=p_user_id AND store_binding=p_binding FOR KEY SHARE;
  IF NOT FOUND THEN RETURN 'stale'; END IF;
  PERFORM 1 FROM public.profiles WHERE id=p_user_id AND role='cafe_owner_manager' AND suspended_at IS NULL FOR SHARE;
  IF NOT FOUND THEN RETURN 'stale'; END IF;
  SELECT environment INTO configured FROM private.native_billing_configuration WHERE singleton IS TRUE FOR SHARE;
  IF configured IS DISTINCT FROM 'Production' THEN RETURN 'stale'; END IF;
  SELECT m.enabled,m.generation,m.authorized_at,m.expires_at,a.window_starts_at,a.window_ends_at
    INTO authority FROM private.apple_sandbox_test_accounts m
    JOIN private.apple_sandbox_test_allowlist a ON a.user_id=m.user_id AND a.purpose=m.purpose
    WHERE m.user_id=p_user_id AND m.purpose='app_review' FOR SHARE OF m,a;
  IF NOT FOUND THEN RETURN 'stale'; END IF;
  -- Read the clock AFTER all waits; expiry during a lock wait must fail closed.
  observed_at:=clock_timestamp();
  IF authority.enabled IS DISTINCT FROM true OR authority.generation IS DISTINCT FROM p_expected_generation
    OR authority.authorized_at IS DISTINCT FROM p_expected_authorized_at
    OR authority.expires_at IS DISTINCT FROM p_expected_expires_at
    OR authority.window_starts_at IS DISTINCT FROM p_expected_window_start
    OR authority.window_ends_at IS DISTINCT FROM p_expected_window_end
    OR NOT coalesce(authority.window_starts_at<=observed_at AND authority.window_ends_at>observed_at
      AND authority.authorized_at<=observed_at AND authority.authorized_at>=authority.window_starts_at
      AND authority.expires_at>observed_at AND authority.expires_at<=authority.window_ends_at,false)
    OR private.native_billing_environment(p_user_id,'apple') IS DISTINCT FROM 'Sandbox'
    OR recorded.revision IS DISTINCT FROM p_expected_revision OR recorded.product_id IS DISTINCT FROM p_product_id
    OR recorded.superseded_by IS NOT NULL OR recorded.status NOT IN ('active','grace','payment_required')
    OR NOT coalesce(recorded.verified_at<=observed_at-interval '60 seconds',false)
    OR NOT coalesce((CASE WHEN recorded.status='grace' THEN coalesce(recorded.grace_period_end,recorded.current_period_end) ELSE recorded.current_period_end END)<=observed_at,false)
    THEN RETURN 'stale'; END IF;
  SELECT count(*) INTO eligible_count FROM private.native_billing_subscriptions s
    WHERE s.user_id=p_user_id AND s.provider='apple' AND s.environment='Sandbox'
      AND s.product_id='com.baristajobmatch.cafe.pro.monthly' AND s.revision>0 AND s.superseded_by IS NULL
      AND s.status IN ('active','grace','payment_required') AND s.verified_at<=observed_at-interval '60 seconds'
      AND (CASE WHEN s.status='grace' THEN coalesce(s.grace_period_end,s.current_period_end) ELSE s.current_period_end END)<=observed_at;
  IF eligible_count<>1 THEN RETURN 'stale'; END IF;
  -- The exact existing chain is row-locked above. No sentinel can be inserted or
  -- recreated by the delegated function: deletion/revision races return stale.
  RETURN public.native_billing_apply(p_user_id,p_binding,'apple','Sandbox',p_subscription_id,
    p_product_id,p_transaction_id,p_status,p_period_end,p_grace_end,p_auto_renews,p_expected_revision,NULL);
EXCEPTION WHEN lock_not_available THEN RETURN 'stale';
END;
$apply_owned$;

ALTER FUNCTION public.native_billing_owned_apple_refresh(uuid) OWNER TO postgres;
ALTER FUNCTION public.native_billing_apply_owned_apple_refresh(uuid,uuid,text,bigint,bigint,timestamptz,timestamptz,timestamptz,timestamptz,text,text,text,timestamptz,timestamptz,boolean) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.native_billing_owned_apple_refresh(uuid),
  public.native_billing_apply_owned_apple_refresh(uuid,uuid,text,bigint,bigint,timestamptz,timestamptz,timestamptz,timestamptz,text,text,text,timestamptz,timestamptz,boolean)
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.native_billing_owned_apple_refresh(uuid),
  public.native_billing_apply_owned_apple_refresh(uuid,uuid,text,bigint,bigint,timestamptz,timestamptz,timestamptz,timestamptz,text,text,text,timestamptz,timestamptz,boolean)
  TO service_role;

COMMIT;
