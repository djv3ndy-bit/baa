-- LOCAL REVIEW DRAFT ONLY. Not applied to any database; never auto-run on startup.
-- Baseline: live function metadata read 2026-10-31 13:18 UTC, project lmwqrxoitraofaftpwhe.
-- Backend source baseline badfed14682a4e8aa0f96bfa97a14dd53ee01e22 is separate provenance:
-- production DB DDL differs from source proposals (notably checkout_provider).
-- Atomic one-time fragment. Empty tester mapping; enabling requires separate owner approval.
BEGIN;

DO $baseline$
DECLARE expected record; actual record; table_name text;
BEGIN
  IF to_regclass('private.apple_sandbox_test_accounts') IS NOT NULL
     OR to_regprocedure('public.native_billing_context(uuid,text)') IS NOT NULL
     OR to_regprocedure('public.native_checkout_attempt_context(uuid,uuid)') IS NOT NULL THEN
    RAISE EXCEPTION 'Apple Sandbox draft already present or schema drift; manual review required';
  END IF;
  IF (SELECT count(*) FROM private.native_billing_configuration) <> 1
     OR (SELECT environment FROM private.native_billing_configuration WHERE singleton=true) <> 'Production' THEN
    RAISE EXCEPTION 'Expected one unchanged Production native billing configuration';
  END IF;
  FOR expected IN SELECT * FROM (VALUES
    ('private.cafe_has_paid_job_entitlement(uuid)', '
  select exists (
    select 1
    from public.cafe_subscriptions subscription
    where subscription.user_id = p_cafe_id
      and subscription.stripe_customer_id ~ ''^cus_[A-Za-z0-9_]+$''
      and length(subscription.stripe_customer_id) <= 255
      and subscription.stripe_subscription_id ~ ''^sub_[A-Za-z0-9_]+$''
      and length(subscription.stripe_subscription_id) <= 255
      and (
        subscription.status = ''active''
        or (
          subscription.status = ''trialing''
          and subscription.trial_ends_at > now()
        )
      )
  ) or public.native_billing_access(p_cafe_id, (
    select environment from private.native_billing_configuration where singleton=true
  ));
', true, ARRAY['search_path=""']::text[], false, false),
    ('private.native_checkout_is_blocked(uuid)', '
  select exists(select 1 from private.native_billing_subscriptions s
    join private.native_billing_configuration c on s.environment=c.environment
    where s.user_id=p_user_id and s.superseded_by is null and s.revision>0 and (
      s.status in (''pending'',''payment_required'') or
      (s.status in (''active'',''grace'') and (s.auto_renews or s.current_period_end>now() or s.grace_period_end>now()))
    )) or exists(select 1 from private.native_checkout_attempts a
    join private.native_billing_configuration c on a.environment=c.environment
    where a.user_id=p_user_id and (a.state=''started'' or (a.state=''reserved'' and a.reserved_until>now())));
', true, ARRAY['search_path=pg_catalog, private']::text[], false, false),
    ('public.cafe_has_hiring_access(uuid)', '
  select target_user_id = (select auth.uid()) and (
    coalesce((
      select profile.role
      from public.profiles profile
      where profile.id = target_user_id
    ), '''') <> ''cafe_owner_manager''
    or exists (
      select 1
      from public.cafe_subscriptions subscription
      where subscription.user_id = target_user_id
        and subscription.owner_paused_at is null
        and (
          subscription.complimentary_access is true
          or subscription.status = ''active''
          or (
            subscription.status = ''trialing''
            and subscription.trial_ends_at > now()
          )
        )
    )
  );
', false, ARRAY['search_path=""']::text[], true, true),
    ('public.native_billing_access(uuid,text)', '
  select exists(select 1 from public.profiles where id=p_user_id and role=''cafe_owner_manager'' and suspended_at is null)
    and exists(select 1 from private.native_billing_subscriptions where user_id=p_user_id and environment=p_environment
    and superseded_by is null and ((status=''active'' and current_period_end>now()) or (status=''grace'' and grace_period_end>now())));
', true, ARRAY['search_path=pg_catalog, private']::text[], false, true),
    ('public.native_billing_account(uuid)', '
declare binding uuid;
begin
  if not exists(select 1 from public.profiles where id=p_user_id and role=''cafe_owner_manager'' and suspended_at is null) then
    raise exception ''Native billing requires an active cafe account'';
  end if;
  insert into private.native_billing_accounts(user_id) values(p_user_id) on conflict(user_id) do nothing;
  select store_binding into binding from private.native_billing_accounts where user_id=p_user_id;
  return binding;
end;
', true, ARRAY['search_path=pg_catalog, private']::text[], false, true),
    ('public.native_billing_apply(uuid,uuid,text,text,text,text,text,text,timestamp with time zone,timestamp with time zone,boolean,bigint,text)', '
declare existing private.native_billing_subscriptions%rowtype;
  linked private.native_billing_subscriptions%rowtype;
  new_key text;
begin
  if p_expected_revision is null or p_expected_revision<0 or not exists(
    select 1 from private.native_billing_accounts where user_id=p_user_id and store_binding=p_binding
  ) then raise exception ''Native billing ownership could not be confirmed''; end if;
  -- Serialize one account''s ownership changes, including Google token replacement.
  perform pg_advisory_xact_lock(hashtextextended(''native-billing:''||p_user_id::text,0));
  new_key:=encode(sha256(convert_to(p_subscription_id,''UTF8'')),''hex'');
  if p_linked_subscription_id is not null and (p_provider<>''google'' or p_linked_subscription_id=p_subscription_id or length(p_linked_subscription_id) not between 1 and 8192) then
    raise exception ''Invalid linked native subscription'';
  end if;
  -- Insert a sentinel without access; concurrent writers synchronize on the
  -- unique provider subscription key, then compare the authoritative revision.
  insert into private.native_billing_subscriptions(provider,environment,provider_subscription_id,provider_subscription_key,user_id,product_id,transaction_id,status,auto_renews,revision)
  values(p_provider,p_environment,p_subscription_id,encode(sha256(convert_to(p_subscription_id,''UTF8'')),''hex''),p_user_id,p_product_id,p_transaction_id,''pending'',false,0)
  on conflict(provider,environment,provider_subscription_key) do nothing;
  select * into existing from private.native_billing_subscriptions
  where provider=p_provider and environment=p_environment and provider_subscription_key=encode(sha256(convert_to(p_subscription_id,''UTF8'')),''hex'') and provider_subscription_id=p_subscription_id for update;
  if not found then raise exception ''Native subscription identity conflict''; end if;
  if existing.user_id<>p_user_id then raise exception ''Native subscription belongs to another account''; end if;
  if existing.superseded_by is not null then return ''superseded''; end if;
  if existing.revision<>p_expected_revision then return ''retry''; end if;
  if p_linked_subscription_id is not null and p_status<>''pending'' then
    -- Retain a tombstone even if the old token never reached this server, so
    -- a delayed restoration cannot reactivate the superseded purchase.
    insert into private.native_billing_subscriptions(provider,environment,provider_subscription_id,provider_subscription_key,user_id,product_id,transaction_id,status,auto_renews,revision,superseded_by)
    values(p_provider,p_environment,p_linked_subscription_id,encode(sha256(convert_to(p_linked_subscription_id,''UTF8'')),''hex''),p_user_id,p_product_id,p_linked_subscription_id,''revoked'',false,0,new_key)
    on conflict(provider,environment,provider_subscription_key) do nothing;
    select * into linked from private.native_billing_subscriptions
    where provider=p_provider and environment=p_environment and provider_subscription_key=encode(sha256(convert_to(p_linked_subscription_id,''UTF8'')),''hex'') for update;
    if linked.user_id<>p_user_id or linked.provider_subscription_id<>p_linked_subscription_id then
      raise exception ''Linked native subscription belongs to another account'';
    end if;
    if linked.superseded_by is not null and linked.superseded_by<>new_key then
      raise exception ''Linked native subscription was already replaced'';
    end if;
    update private.native_billing_subscriptions set status=''revoked'',auto_renews=false,superseded_by=new_key,revision=revision+1,verified_at=clock_timestamp()
    where provider=p_provider and environment=p_environment and provider_subscription_key=linked.provider_subscription_key and superseded_by is distinct from new_key;
  end if;

  if existing.revision>0 and existing.product_id=p_product_id and existing.transaction_id=p_transaction_id
    and existing.status=p_status and existing.current_period_end is not distinct from p_period_end
    and existing.grace_period_end is not distinct from p_grace_end and existing.auto_renews=p_auto_renews then return ''duplicate''; end if;
  update private.native_billing_subscriptions set product_id=p_product_id,transaction_id=p_transaction_id,status=p_status,
    current_period_end=p_period_end,grace_period_end=p_grace_end,auto_renews=p_auto_renews,
    revision=revision+1,verified_at=clock_timestamp()
  where provider=p_provider and environment=p_environment and provider_subscription_key=encode(sha256(convert_to(p_subscription_id,''UTF8'')),''hex'') and provider_subscription_id=p_subscription_id;
  return ''applied'';
end;
', true, ARRAY['search_path=pg_catalog, private']::text[], false, true),
    ('public.native_billing_claim_event(text,text,text,text,uuid)', '
declare existing private.native_billing_events%rowtype;
begin
  if p_claim_id is null then raise exception ''Event claim required''; end if;
  insert into private.native_billing_events(provider,environment,event_id,payload_hash)
  values(p_provider,p_environment,p_event_id,p_payload_hash) on conflict(provider,environment,event_id) do nothing;
  select * into existing from private.native_billing_events where provider=p_provider and environment=p_environment and event_id=p_event_id for update;
  if existing.payload_hash<>p_payload_hash then raise exception ''Event identity conflict''; end if;
  if existing.processed_at is not null then return ''duplicate''; end if;
  if existing.claim_expires_at>now() then return ''busy''; end if;
  update private.native_billing_events set claim_id=p_claim_id,claim_expires_at=now()+interval ''5 minutes'',attempts=attempts+1
  where provider=p_provider and environment=p_environment and event_id=p_event_id;
  return ''claimed'';
end;
', true, ARRAY['search_path=pg_catalog, private']::text[], false, true),
    ('public.native_billing_finish_event(text,text,text,uuid,boolean)', '
declare affected integer;
begin
  if p_success is null then raise exception ''Event outcome required''; end if;
  update private.native_billing_events set processed_at=case when p_success then now() else null end,claim_id=null,claim_expires_at=null
  where provider=p_provider and environment=p_environment and event_id=p_event_id and claim_id=p_claim_id and claim_expires_at>now();
  get diagnostics affected=row_count; return affected=1;
end;
', true, ARRAY['search_path=pg_catalog, private']::text[], false, true),
    ('public.native_billing_owner(uuid)', '
  select user_id from private.native_billing_accounts where store_binding=p_binding;
', true, ARRAY['search_path=pg_catalog, private']::text[], false, true),
    ('public.native_billing_read(text,text,text)', '
  select to_jsonb(subscription) from private.native_billing_subscriptions subscription
  where provider=p_provider and environment=p_environment and provider_subscription_key=encode(sha256(convert_to(p_subscription_id,''UTF8'')),''hex'') and provider_subscription_id=p_subscription_id;
', true, ARRAY['search_path=pg_catalog, private']::text[], false, true),
    ('public.native_billing_summary(uuid,text)', '
begin
  if p_environment is null or p_environment not in (''Sandbox'',''Production'') or not exists(
    select 1 from public.profiles where id=p_user_id and role=''cafe_owner_manager'' and suspended_at is null
  ) then raise exception ''Native billing requires an active cafe account''; end if;
  return jsonb_build_object(''accountId'',p_user_id,''environment'',p_environment,''subscriptions'',coalesce((
    select jsonb_agg(jsonb_build_object(''provider'',provider,''status'',status,
      ''currentPeriodEnd'',current_period_end,''gracePeriodEnd'',grace_period_end,''autoRenews'',auto_renews)
      order by verified_at desc,provider,provider_subscription_key)
    from private.native_billing_subscriptions where user_id=p_user_id and environment=p_environment
      and superseded_by is null and revision>0
  ),''[]''::jsonb));
end;
', true, ARRAY['search_path=pg_catalog, private']::text[], false, true),
    ('public.native_checkout_cancel(uuid,text,uuid,boolean)', '
declare affected integer;
begin
  if p_before_launch is null or not exists(select 1 from private.native_billing_configuration where environment=p_environment) then return false; end if;
  perform 1 from public.cafe_subscriptions where user_id=p_user_id for update;
  if not found then return false; end if;
  update private.native_checkout_attempts set state=''cancelled'',updated_at=now()
    where id=p_attempt_id and user_id=p_user_id and environment=p_environment
      and (state=''reserved'' or (not p_before_launch and state=''started'') or state=''cancelled'');
  get diagnostics affected=row_count;return affected=1;
end;
', true, ARRAY['search_path=pg_catalog, private']::text[], false, true),
    ('public.native_checkout_claim(uuid,text,text,uuid)', '
declare existing public.cafe_subscriptions%rowtype; binding uuid;
begin
  if p_attempt_id is null or p_provider is null or p_provider not in (''apple'',''google'')
    or not exists(select 1 from private.native_billing_configuration where environment=p_environment)
    or not exists(select 1 from public.profiles where id=p_user_id and role=''cafe_owner_manager'' and suspended_at is null) then
    raise exception ''Native checkout unavailable'';
  end if;
  -- The same row is locked by the existing Stripe checkout/deletion claims.
  select * into existing from public.cafe_subscriptions where user_id=p_user_id for update;
  if not found then return null; end if;
  if existing.stripe_checkout_attempt_id is not null
    or (existing.stripe_checkout_claim_id is not null and existing.stripe_checkout_claim_expires_at>now())
    or (existing.stripe_subscription_id is not null and existing.status in (''active'',''trialing'',''past_due'',''unpaid'',''incomplete'',''paused''))
    or private.native_checkout_is_blocked(p_user_id) then return null; end if;
  binding:=public.native_billing_account(p_user_id);
  -- Only a reservation that never authorized a store launch can time out.
  update private.native_checkout_attempts set state=''expired'',updated_at=now()
    where user_id=p_user_id and environment=p_environment and state=''reserved'' and reserved_until<=now();
  insert into private.native_checkout_attempts(id,user_id,provider,environment,state,reserved_until)
    values(p_attempt_id,p_user_id,p_provider,p_environment,''reserved'',now()+interval ''5 minutes'');
  return jsonb_build_object(''attemptId'',p_attempt_id,''accountBinding'',binding);
end;
', true, ARRAY['search_path=pg_catalog, private']::text[], false, true),
    ('public.native_checkout_pending(uuid,text)', '
begin
  if not exists(select 1 from private.native_billing_configuration where environment=p_environment) then raise exception ''Native checkout environment mismatch''; end if;
  return exists(select 1 from private.native_checkout_attempts where user_id=p_user_id and environment=p_environment
    and (state=''started'' or (state=''reserved'' and reserved_until>now())));
end;
', true, ARRAY['search_path=pg_catalog, private']::text[], false, true),
    ('public.native_checkout_provider(uuid,text,uuid)', '
  select a.provider
  from private.native_checkout_attempts a
  where p_environment = ''Production''
    and a.id = p_attempt_id and a.user_id = p_user_id
    and a.environment = p_environment and a.state = ''reserved''
    and a.reserved_until > now()
    and exists (
      select 1 from private.native_billing_configuration c
      where c.singleton is true and c.environment = p_environment
    )
    and exists (
      select 1 from public.profiles p
      where p.id = p_user_id and p.role = ''cafe_owner_manager''
        and p.suspended_at is null
    );
', true, ARRAY['search_path=pg_catalog, private']::text[], false, true),
    ('public.native_checkout_recover_apple(uuid,text)', '
declare existing public.cafe_subscriptions%rowtype; result jsonb;
begin
  if not exists(select 1 from private.native_billing_configuration where environment=p_environment)
    or not exists(select 1 from public.profiles where id=p_user_id and role=''cafe_owner_manager'' and suspended_at is null) then return null; end if;
  -- Serialize the eligibility check with the existing website checkout lock.
  select * into existing from public.cafe_subscriptions where user_id=p_user_id for update;
  if not found then return null; end if;
  if existing.stripe_checkout_attempt_id is not null
    or (existing.stripe_checkout_claim_id is not null and existing.stripe_checkout_claim_expires_at>now())
    or (existing.stripe_subscription_id is not null and existing.status in (''active'',''trialing'',''past_due'',''unpaid'',''incomplete'',''paused''))
    or exists(select 1 from private.native_billing_subscriptions where user_id=p_user_id and environment=p_environment
      and superseded_by is null and revision>0 and (status in (''pending'',''payment_required'')
        or (status in (''active'',''grace'') and (auto_renews or current_period_end>now() or grace_period_end>now())))) then return null; end if;
  select jsonb_build_object(''attemptId'',a.id,''accountBinding'',b.store_binding) into result
    from private.native_checkout_attempts a join private.native_billing_accounts b on b.user_id=a.user_id
    where a.user_id=p_user_id and a.environment=p_environment and a.provider=''apple'' and a.state=''started'';
  return result;
end;
', true, ARRAY['search_path=pg_catalog, private']::text[], false, true),
    ('public.native_checkout_settle_verified(uuid,text)', '
begin
  if not exists(select 1 from private.native_billing_configuration where environment=p_environment) then return false; end if;
  perform 1 from public.cafe_subscriptions where user_id=p_user_id for update;
  if not found then return false; end if;
  update private.native_checkout_attempts a set state=''verified'',updated_at=now()
  where a.user_id=p_user_id and a.environment=p_environment and a.state in (''reserved'',''started'')
    and exists(select 1 from private.native_billing_subscriptions s where s.user_id=p_user_id and s.environment=p_environment
      and s.provider=a.provider and s.superseded_by is null and s.revision>0
      and (s.status in (''pending'',''payment_required'') or (s.status in (''active'',''grace'') and (s.auto_renews or s.current_period_end>now() or s.grace_period_end>now()))));
  return true;
end;
', true, ARRAY['search_path=pg_catalog, private']::text[], false, true),
    ('public.native_checkout_start(uuid,text,uuid)', '
declare affected integer;
begin
  if not exists(select 1 from private.native_billing_configuration where environment=p_environment)
    or not exists(select 1 from public.profiles where id=p_user_id and role=''cafe_owner_manager'' and suspended_at is null) then return false; end if;
  perform 1 from public.cafe_subscriptions where user_id=p_user_id for update;
  if not found then return false; end if;
  if exists(select 1 from public.cafe_subscriptions where user_id=p_user_id
      and (stripe_checkout_attempt_id is not null or (stripe_checkout_claim_id is not null and stripe_checkout_claim_expires_at>now())
        or (stripe_subscription_id is not null and status in (''active'',''trialing'',''past_due'',''unpaid'',''incomplete'',''paused''))))
    or exists(select 1 from private.native_billing_subscriptions where user_id=p_user_id and environment=p_environment
      and superseded_by is null and revision>0 and (status in (''pending'',''payment_required'')
        or (status in (''active'',''grace'') and (auto_renews or current_period_end>now() or grace_period_end>now())))) then return false; end if;
  update private.native_checkout_attempts set state=''started'',updated_at=now()
    where id=p_attempt_id and user_id=p_user_id and environment=p_environment and state=''reserved'' and reserved_until>now();
  get diagnostics affected=row_count;return affected=1;
end;
', true, ARRAY['search_path=pg_catalog, private']::text[], false, true),
    ('public.claim_stripe_checkout(uuid,uuid,uuid,text,text)', '
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
     or p_channel not in (''web'', ''app'')
     or p_ui_mode is null
     or p_ui_mode not in (''hosted'', ''embedded'') then
    raise exception ''Invalid Checkout claim'';
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
  if not recovered and p_channel = ''app'' and p_ui_mode <> ''hosted'' then
    raise exception ''Invalid Checkout claim'';
  end if;

  claimed_attempt_id := coalesce(existing.stripe_checkout_attempt_id, p_attempt_id);
  claimed_channel := case when recovered then coalesce(existing.stripe_checkout_channel, p_channel) else p_channel end;
  claimed_ui_mode := case when recovered then coalesce(existing.stripe_checkout_ui_mode, ''hosted'') else p_ui_mode end;

  update public.cafe_subscriptions
  set stripe_checkout_claim_id = p_claim_id,
      stripe_checkout_claim_expires_at = now() + interval ''5 minutes'',
      stripe_checkout_claim_kind = ''checkout'',
      stripe_checkout_attempt_id = claimed_attempt_id,
      stripe_checkout_channel = claimed_channel,
      stripe_checkout_ui_mode = claimed_ui_mode,
      updated_at = now()
  where user_id = p_user_id;

  return jsonb_build_object(
    ''attemptId'', claimed_attempt_id,
    ''channel'', claimed_channel,
    ''uiMode'', claimed_ui_mode,
    ''recovered'', recovered
  );
end;
', true, ARRAY['search_path=public, pg_temp']::text[], false, true)
  ) AS baseline(signature, source_body, definer, config, authenticated_execute, service_execute)
  LOOP
    SELECT p.oid, p.prosrc, p.prosecdef, p.proconfig, p.proacl, p.proowner, p.provolatile
      INTO actual FROM pg_proc p WHERE p.oid=to_regprocedure(expected.signature);
    IF NOT FOUND OR md5(actual.prosrc) <> md5(expected.source_body)
       OR pg_get_userbyid(actual.proowner) IS DISTINCT FROM 'postgres'
       OR actual.prosecdef IS DISTINCT FROM expected.definer
       OR actual.provolatile IS DISTINCT FROM (CASE WHEN expected.signature=ANY(ARRAY['private.cafe_has_paid_job_entitlement(uuid)','private.native_checkout_is_blocked(uuid)','public.cafe_has_hiring_access(uuid)','public.native_billing_access(uuid,text)','public.native_billing_owner(uuid)','public.native_billing_read(text,text,text)','public.native_billing_summary(uuid,text)','public.native_checkout_pending(uuid,text)','public.native_checkout_provider(uuid,text,uuid)']::text[]) THEN 's'::"char" ELSE 'v'::"char" END)
       OR actual.proconfig IS DISTINCT FROM expected.config
       OR has_function_privilege('anon',actual.oid,'EXECUTE')
       OR has_function_privilege('authenticated',actual.oid,'EXECUTE') IS DISTINCT FROM expected.authenticated_execute
       OR has_function_privilege('service_role',actual.oid,'EXECUTE') IS DISTINCT FROM expected.service_execute
       OR EXISTS(SELECT 1 FROM aclexplode(coalesce(actual.proacl,acldefault('f',actual.proowner))) a WHERE a.grantee=0) THEN
      RAISE EXCEPTION 'Native billing function/security drift: %',expected.signature;
    END IF;
  END LOOP;
  -- PostgREST dispatch uses argument names and omitted default parameters.
  -- Typed identity/body alone would miss a same-type renamed RPC parameter.
  FOR expected IN SELECT * FROM (VALUES
    ('private.cafe_has_paid_job_entitlement(uuid)',ARRAY['p_cafe_id']::text[],'p_cafe_id uuid','boolean',NULL::text,0),
    ('private.native_checkout_is_blocked(uuid)',ARRAY['p_user_id']::text[],'p_user_id uuid','boolean',NULL::text,0),
    ('public.cafe_has_hiring_access(uuid)',ARRAY['target_user_id']::text[],'target_user_id uuid','boolean',NULL::text,0),
    ('public.native_billing_access(uuid,text)',ARRAY['p_user_id','p_environment']::text[],'p_user_id uuid, p_environment text','boolean',NULL::text,0),
    ('public.native_billing_account(uuid)',ARRAY['p_user_id']::text[],'p_user_id uuid','uuid',NULL::text,0),
    ('public.native_billing_apply(uuid,uuid,text,text,text,text,text,text,timestamp with time zone,timestamp with time zone,boolean,bigint,text)',ARRAY['p_user_id','p_binding','p_provider','p_environment','p_subscription_id','p_product_id','p_transaction_id','p_status','p_period_end','p_grace_end','p_auto_renews','p_expected_revision','p_linked_subscription_id']::text[],'p_user_id uuid, p_binding uuid, p_provider text, p_environment text, p_subscription_id text, p_product_id text, p_transaction_id text, p_status text, p_period_end timestamp with time zone, p_grace_end timestamp with time zone, p_auto_renews boolean, p_expected_revision bigint, p_linked_subscription_id text','text','NULL::text',1),
    ('public.native_billing_claim_event(text,text,text,text,uuid)',ARRAY['p_provider','p_environment','p_event_id','p_payload_hash','p_claim_id']::text[],'p_provider text, p_environment text, p_event_id text, p_payload_hash text, p_claim_id uuid','text',NULL::text,0),
    ('public.native_billing_finish_event(text,text,text,uuid,boolean)',ARRAY['p_provider','p_environment','p_event_id','p_claim_id','p_success']::text[],'p_provider text, p_environment text, p_event_id text, p_claim_id uuid, p_success boolean','boolean',NULL::text,0),
    ('public.native_billing_owner(uuid)',ARRAY['p_binding']::text[],'p_binding uuid','uuid',NULL::text,0),
    ('public.native_billing_read(text,text,text)',ARRAY['p_provider','p_environment','p_subscription_id']::text[],'p_provider text, p_environment text, p_subscription_id text','jsonb',NULL::text,0),
    ('public.native_billing_summary(uuid,text)',ARRAY['p_user_id','p_environment']::text[],'p_user_id uuid, p_environment text','jsonb',NULL::text,0),
    ('public.native_checkout_cancel(uuid,text,uuid,boolean)',ARRAY['p_user_id','p_environment','p_attempt_id','p_before_launch']::text[],'p_user_id uuid, p_environment text, p_attempt_id uuid, p_before_launch boolean','boolean',NULL::text,0),
    ('public.native_checkout_claim(uuid,text,text,uuid)',ARRAY['p_user_id','p_provider','p_environment','p_attempt_id']::text[],'p_user_id uuid, p_provider text, p_environment text, p_attempt_id uuid','jsonb',NULL::text,0),
    ('public.native_checkout_pending(uuid,text)',ARRAY['p_user_id','p_environment']::text[],'p_user_id uuid, p_environment text','boolean',NULL::text,0),
    ('public.native_checkout_provider(uuid,text,uuid)',ARRAY['p_user_id','p_environment','p_attempt_id']::text[],'p_user_id uuid, p_environment text, p_attempt_id uuid','text',NULL::text,0),
    ('public.native_checkout_recover_apple(uuid,text)',ARRAY['p_user_id','p_environment']::text[],'p_user_id uuid, p_environment text','jsonb',NULL::text,0),
    ('public.native_checkout_settle_verified(uuid,text)',ARRAY['p_user_id','p_environment']::text[],'p_user_id uuid, p_environment text','boolean',NULL::text,0),
    ('public.native_checkout_start(uuid,text,uuid)',ARRAY['p_user_id','p_environment','p_attempt_id']::text[],'p_user_id uuid, p_environment text, p_attempt_id uuid','boolean',NULL::text,0),
    ('public.claim_stripe_checkout(uuid,uuid,uuid,text,text)',ARRAY['p_user_id','p_claim_id','p_attempt_id','p_channel','p_ui_mode']::text[],'p_user_id uuid, p_claim_id uuid, p_attempt_id uuid, p_channel text, p_ui_mode text','jsonb','''hosted''::text',1)
  ) AS wire(signature,argument_names,identity_arguments,result_type,default_expression,default_count)
  LOOP
    SELECT p.oid,p.proargnames,p.pronargdefaults,p.proargdefaults INTO actual
      FROM pg_proc p WHERE p.oid=to_regprocedure(expected.signature);
    IF NOT FOUND OR actual.proargnames IS DISTINCT FROM expected.argument_names
      OR pg_get_function_identity_arguments(actual.oid) IS DISTINCT FROM expected.identity_arguments
      OR pg_get_function_result(actual.oid) IS DISTINCT FROM expected.result_type
      OR actual.pronargdefaults IS DISTINCT FROM expected.default_count
      OR pg_get_expr(actual.proargdefaults,0) IS DISTINCT FROM expected.default_expression THEN
      RAISE EXCEPTION 'Native billing RPC wire metadata drift: %',expected.signature;
    END IF;
  END LOOP;
  FOREACH table_name IN ARRAY ARRAY['native_billing_accounts','native_billing_subscriptions','native_billing_events','native_billing_configuration','native_checkout_attempts']
  LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_class c WHERE c.oid=to_regclass('private.'||table_name) AND c.relrowsecurity AND NOT c.relforcerowsecurity)
       OR EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='private' AND tablename=table_name)
       OR has_table_privilege('anon','private.'||table_name,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
       OR has_table_privilege('authenticated','private.'||table_name,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
       OR has_table_privilege('service_role','private.'||table_name,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN') THEN
      RAISE EXCEPTION 'Native billing table/security drift: %',table_name;
    END IF;
  END LOOP;
  FOR expected IN SELECT * FROM (VALUES
    ('native_billing_accounts', 'native_billing_accounts_pkey', 'PRIMARY KEY (user_id)'),
    ('native_billing_accounts', 'native_billing_accounts_store_binding_key', 'UNIQUE (store_binding)'),
    ('native_billing_configuration', 'native_billing_configuration_environment_check', 'CHECK ((environment = ANY (ARRAY[''Production''::text, ''Sandbox''::text])))'),
    ('native_billing_configuration', 'native_billing_configuration_pkey', 'PRIMARY KEY (singleton)'),
    ('native_billing_configuration', 'native_billing_configuration_singleton_check', 'CHECK (singleton)'),
    ('native_billing_events', 'native_billing_events_environment_check', 'CHECK ((environment = ANY (ARRAY[''Sandbox''::text, ''Production''::text])))'),
    ('native_billing_events', 'native_billing_events_event_id_check', 'CHECK (((length(event_id) >= 1) AND (length(event_id) <= 255)))'),
    ('native_billing_events', 'native_billing_events_payload_hash_check', 'CHECK ((payload_hash ~ ''^[a-f0-9]{64}$''::text))'),
    ('native_billing_events', 'native_billing_events_pkey', 'PRIMARY KEY (provider, environment, event_id)'),
    ('native_billing_events', 'native_billing_events_provider_check', 'CHECK ((provider = ANY (ARRAY[''apple''::text, ''google''::text])))'),
    ('native_billing_subscriptions', 'native_billing_subscriptions_check', 'CHECK ((provider_subscription_key = encode(sha256(convert_to(provider_subscription_id, ''UTF8''::name)), ''hex''::text)))'),
    ('native_billing_subscriptions', 'native_billing_subscriptions_environment_check', 'CHECK ((environment = ANY (ARRAY[''Sandbox''::text, ''Production''::text])))'),
    ('native_billing_subscriptions', 'native_billing_subscriptions_pkey', 'PRIMARY KEY (provider, environment, provider_subscription_key)'),
    ('native_billing_subscriptions', 'native_billing_subscriptions_product_id_check', 'CHECK (((length(product_id) >= 1) AND (length(product_id) <= 255)))'),
    ('native_billing_subscriptions', 'native_billing_subscriptions_provider_check', 'CHECK ((provider = ANY (ARRAY[''apple''::text, ''google''::text])))'),
    ('native_billing_subscriptions', 'native_billing_subscriptions_provider_subscription_id_check', 'CHECK (((length(provider_subscription_id) >= 1) AND (length(provider_subscription_id) <= 8192)))'),
    ('native_billing_subscriptions', 'native_billing_subscriptions_status_check', 'CHECK ((status = ANY (ARRAY[''active''::text, ''grace''::text, ''pending''::text, ''payment_required''::text, ''expired''::text, ''revoked''::text])))'),
    ('native_billing_subscriptions', 'native_billing_subscriptions_transaction_id_check', 'CHECK (((length(transaction_id) >= 1) AND (length(transaction_id) <= 8192)))'),
    ('native_billing_subscriptions', 'native_billing_subscriptions_user_id_fkey', 'FOREIGN KEY (user_id) REFERENCES private.native_billing_accounts(user_id)'),
    ('native_checkout_attempts', 'native_checkout_attempts_environment_check', 'CHECK ((environment = ANY (ARRAY[''Production''::text, ''Sandbox''::text])))'),
    ('native_checkout_attempts', 'native_checkout_attempts_pkey', 'PRIMARY KEY (id)'),
    ('native_checkout_attempts', 'native_checkout_attempts_provider_check', 'CHECK ((provider = ANY (ARRAY[''apple''::text, ''google''::text])))'),
    ('native_checkout_attempts', 'native_checkout_attempts_state_check', 'CHECK ((state = ANY (ARRAY[''reserved''::text, ''started''::text, ''cancelled''::text, ''expired''::text, ''verified''::text])))'),
    ('native_checkout_attempts', 'native_checkout_attempts_user_id_fkey', 'FOREIGN KEY (user_id) REFERENCES private.native_billing_accounts(user_id)')
  ) AS constraints(table_name,constraint_name,definition)
  LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_constraint c WHERE c.conrelid=to_regclass('private.'||expected.table_name)
      AND c.conname=expected.constraint_name AND c.convalidated AND pg_get_constraintdef(c.oid)=expected.definition) THEN
      RAISE EXCEPTION 'Native billing constraint drift: %',expected.constraint_name;
    END IF;
  END LOOP;
  FOR expected IN SELECT * FROM (VALUES
    ('native_billing_accounts_pkey', 'CREATE UNIQUE INDEX native_billing_accounts_pkey ON private.native_billing_accounts USING btree (user_id)'),
    ('native_billing_accounts_store_binding_key', 'CREATE UNIQUE INDEX native_billing_accounts_store_binding_key ON private.native_billing_accounts USING btree (store_binding)'),
    ('native_billing_configuration_pkey', 'CREATE UNIQUE INDEX native_billing_configuration_pkey ON private.native_billing_configuration USING btree (singleton)'),
    ('native_billing_events_pkey', 'CREATE UNIQUE INDEX native_billing_events_pkey ON private.native_billing_events USING btree (provider, environment, event_id)'),
    ('native_billing_subscriptions_account_idx', 'CREATE INDEX native_billing_subscriptions_account_idx ON private.native_billing_subscriptions USING btree (user_id, environment)'),
    ('native_billing_subscriptions_pkey', 'CREATE UNIQUE INDEX native_billing_subscriptions_pkey ON private.native_billing_subscriptions USING btree (provider, environment, provider_subscription_key)'),
    ('native_checkout_attempts_pkey', 'CREATE UNIQUE INDEX native_checkout_attempts_pkey ON private.native_checkout_attempts USING btree (id)'),
    ('native_checkout_one_open_account', 'CREATE UNIQUE INDEX native_checkout_one_open_account ON private.native_checkout_attempts USING btree (user_id, environment) WHERE (state = ANY (ARRAY[''reserved''::text, ''started''::text]))')
  ) AS indexes(index_name,definition)
  LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_index i WHERE i.indexrelid=to_regclass('private.'||expected.index_name)
      AND i.indisvalid AND i.indisready AND pg_get_indexdef(i.indexrelid)=expected.definition) THEN
      RAISE EXCEPTION 'Native billing index drift: %',expected.index_name;
    END IF;
  END LOOP;
END;
$baseline$;

-- Private server-owned authorization, intentionally EMPTY.
CREATE TABLE private.apple_sandbox_test_accounts (
  user_id uuid PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE
    CHECK(user_id='afc55a3d-4a94-4893-bd78-ac6410ac6aed'::uuid),
  enabled boolean NOT NULL DEFAULT false,
  expires_at timestamptz,
  generation bigint NOT NULL DEFAULT 1 CHECK(generation>0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK(NOT enabled OR expires_at IS NOT NULL)
);
ALTER TABLE private.apple_sandbox_test_accounts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.apple_sandbox_test_accounts FROM public,anon,authenticated,service_role;

ALTER TABLE private.native_checkout_attempts
  ADD COLUMN guard_protocol text CHECK(guard_protocol IS NULL OR guard_protocol='apple-app-transaction-v1'),
  ADD COLUMN sandbox_tester_generation bigint CHECK(sandbox_tester_generation IS NULL OR sandbox_tester_generation>0),
  ADD CONSTRAINT native_checkout_sandbox_guard_pair CHECK(sandbox_tester_generation IS NULL OR guard_protocol='apple-app-transaction-v1');

-- NULL means unauthorized, not a fallback. Unmapped accounts retain the
-- configured environment, including the existing isolated Sandbox QA backend.
CREATE FUNCTION private.native_billing_environment(p_user_id uuid,p_provider text DEFAULT NULL)
RETURNS text LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,private AS $environment$
DECLARE configured text; tester private.apple_sandbox_test_accounts%rowtype;
BEGIN
  IF current_setting('transaction_isolation')<>'read committed' THEN RETURN NULL; END IF;
  IF p_user_id IS NULL OR (p_provider IS NOT NULL AND p_provider NOT IN ('apple','google')) THEN RETURN NULL; END IF;
  SELECT environment INTO configured FROM private.native_billing_configuration WHERE singleton=true;
  IF configured IS NULL OR configured NOT IN ('Production','Sandbox') THEN RETURN NULL; END IF;
  SELECT * INTO tester FROM private.apple_sandbox_test_accounts WHERE user_id=p_user_id;
  IF configured='Production' AND FOUND AND tester.enabled AND tester.expires_at>clock_timestamp() THEN
    IF p_provider='google' OR NOT EXISTS(
      SELECT 1 FROM public.profiles WHERE id=p_user_id AND role='cafe_owner_manager' AND suspended_at IS NULL
    ) THEN RETURN NULL; END IF;
    RETURN 'Sandbox';
  END IF;
  RETURN configured;
END;
$environment$;
REVOKE ALL ON FUNCTION private.native_billing_environment(uuid,text) FROM public,anon,authenticated,service_role;

-- Block only the configured domain for ordinary accounts. An explicitly
-- recorded tester retains its unresolved Apple Sandbox obligations after revoke.
CREATE FUNCTION private.native_billing_retained_environment(p_user_id uuid,p_provider text,p_environment text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,private AS $retained$
  SELECT EXISTS(SELECT 1 FROM private.native_billing_configuration WHERE singleton=true AND environment=p_environment)
    OR (p_user_id='afc55a3d-4a94-4893-bd78-ac6410ac6aed'::uuid AND p_provider='apple' AND p_environment='Sandbox'
      AND EXISTS(SELECT 1 FROM private.apple_sandbox_test_accounts WHERE user_id=p_user_id));
$retained$;
REVOKE ALL ON FUNCTION private.native_billing_retained_environment(uuid,text,text) FROM public,anon,authenticated,service_role;

CREATE FUNCTION public.native_billing_context(p_user_id uuid,p_provider text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,private AS $context$
DECLARE target_environment text; configured text;
BEGIN
  target_environment:=private.native_billing_environment(p_user_id,p_provider);
  IF target_environment IS NULL THEN RAISE EXCEPTION 'Native billing account context unavailable'; END IF;
  SELECT environment INTO configured FROM private.native_billing_configuration WHERE singleton=true;
  RETURN jsonb_build_object('environment',target_environment,
    'appleSandboxTester',configured='Production' AND target_environment='Sandbox');
END;
$context$;
REVOKE ALL ON FUNCTION public.native_billing_context(uuid,text) FROM public,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.native_billing_context(uuid,text) TO service_role;

CREATE FUNCTION public.native_billing_set_apple_sandbox_tester(p_user_id uuid,p_enabled boolean,p_expires_at timestamptz DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,private AS $set_tester$
DECLARE subscription public.cafe_subscriptions%rowtype;
BEGIN
  IF p_user_id IS DISTINCT FROM 'afc55a3d-4a94-4893-bd78-ac6410ac6aed'::uuid OR p_enabled IS NULL THEN
    RAISE EXCEPTION 'Sandbox tester account is not eligible';
  END IF;
  -- Serialize with website checkout, native launch/apply and mapping revoke.
  SELECT * INTO subscription FROM public.cafe_subscriptions WHERE user_id=p_user_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Sandbox tester account is unavailable'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('native-billing:'||p_user_id::text,0));
  IF p_enabled THEN
    IF NOT EXISTS(SELECT 1 FROM private.native_billing_configuration WHERE singleton=true AND environment='Production')
      OR NOT EXISTS(SELECT 1 FROM public.profiles WHERE id=p_user_id AND role='cafe_owner_manager' AND suspended_at IS NULL)
      OR subscription.owner_paused_at IS NOT NULL
      OR p_expires_at IS NULL OR p_expires_at<=clock_timestamp() OR p_expires_at>clock_timestamp()+interval '30 days'
      OR subscription.stripe_customer_id IS NOT NULL OR subscription.stripe_subscription_id IS NOT NULL
      OR subscription.stripe_checkout_attempt_id IS NOT NULL OR subscription.stripe_checkout_claim_id IS NOT NULL
      OR subscription.stripe_checkout_claim_expires_at IS NOT NULL
      OR subscription.status NOT IN ('trialing','canceled','expired')
      OR EXISTS(SELECT 1 FROM private.native_billing_subscriptions s WHERE s.user_id=p_user_id AND s.superseded_by IS NULL
        AND (s.status IN ('pending','payment_required')
          OR (s.status IN ('active','grace') AND (s.auto_renews OR s.current_period_end>clock_timestamp()
            OR s.grace_period_end>clock_timestamp() OR (s.current_period_end IS NULL AND s.grace_period_end IS NULL)))))
      OR EXISTS(SELECT 1 FROM private.native_checkout_attempts WHERE user_id=p_user_id AND state IN ('reserved','started')) THEN
      RAISE EXCEPTION 'Sandbox tester activation blocked by account, billing or expiry state';
    END IF;
  END IF;
  INSERT INTO private.apple_sandbox_test_accounts(user_id,enabled,expires_at)
    VALUES(p_user_id,p_enabled,CASE WHEN p_enabled THEN p_expires_at ELSE NULL END)
  ON CONFLICT(user_id) DO UPDATE SET enabled=excluded.enabled,expires_at=excluded.expires_at,
    generation=private.apple_sandbox_test_accounts.generation+1,updated_at=clock_timestamp();
  RETURN public.native_billing_context(p_user_id,NULL);
END;
$set_tester$;
REVOKE ALL ON FUNCTION public.native_billing_set_apple_sandbox_tester(uuid,boolean,timestamptz) FROM public,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.native_billing_set_apple_sandbox_tester(uuid,boolean,timestamptz) TO service_role;

-- Exact owned durable attempt; the client cannot choose an environment.
CREATE FUNCTION public.native_checkout_attempt_context(p_user_id uuid,p_attempt_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,private AS $attempt_context$
  SELECT jsonb_build_object('environment',environment,'provider',provider,'guardProtocol',guard_protocol)
  FROM private.native_checkout_attempts WHERE user_id=p_user_id AND id=p_attempt_id;
$attempt_context$;
REVOKE ALL ON FUNCTION public.native_checkout_attempt_context(uuid,uuid) FROM public,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.native_checkout_attempt_context(uuid,uuid) TO service_role;

DROP FUNCTION public.native_checkout_claim(uuid,text,text,uuid);
CREATE FUNCTION public.native_checkout_claim(p_user_id uuid,p_provider text,p_environment text,p_attempt_id uuid,p_guard_protocol text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,private AS $claim$
DECLARE existing public.cafe_subscriptions%rowtype; binding uuid; tester_generation bigint;
BEGIN
  IF p_attempt_id IS NULL OR p_provider IS NULL OR p_provider NOT IN ('apple','google')
    OR p_environment IS NULL OR p_environment NOT IN ('Production','Sandbox')
    OR (p_guard_protocol IS NOT NULL AND p_guard_protocol<>'apple-app-transaction-v1') THEN RAISE EXCEPTION 'Native checkout unavailable'; END IF;
  SELECT * INTO existing FROM public.cafe_subscriptions WHERE user_id=p_user_id FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;
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
REVOKE ALL ON FUNCTION public.native_checkout_claim(uuid,text,text,uuid,text) FROM public,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.native_checkout_claim(uuid,text,text,uuid,text) TO service_role;

DROP FUNCTION public.native_checkout_start(uuid,text,uuid);
CREATE FUNCTION public.native_checkout_start(p_user_id uuid,p_environment text,p_attempt_id uuid,p_guard_protocol text DEFAULT NULL)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,private AS $start$
DECLARE affected integer; attempt private.native_checkout_attempts%rowtype;
BEGIN
  PERFORM 1 FROM public.cafe_subscriptions WHERE user_id=p_user_id AND owner_paused_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
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
REVOKE ALL ON FUNCTION public.native_checkout_start(uuid,text,uuid,text) FROM public,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.native_checkout_start(uuid,text,uuid,text) TO service_role;

DROP FUNCTION public.native_checkout_recover_apple(uuid,text);
CREATE FUNCTION public.native_checkout_recover_apple(p_user_id uuid,p_environment text,p_guard_protocol text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,private AS $recover$
DECLARE existing public.cafe_subscriptions%rowtype; result jsonb;
BEGIN
  SELECT * INTO existing FROM public.cafe_subscriptions WHERE user_id=p_user_id FOR UPDATE;
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
REVOKE ALL ON FUNCTION public.native_checkout_recover_apple(uuid,text,text) FROM public,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.native_checkout_recover_apple(uuid,text,text) TO service_role;

CREATE OR REPLACE FUNCTION public.native_checkout_provider(p_user_id uuid,p_environment text,p_attempt_id uuid)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,private AS $provider$
  SELECT a.provider FROM private.native_checkout_attempts a
  WHERE a.id=p_attempt_id AND a.user_id=p_user_id AND a.environment=p_environment
    AND a.state='reserved' AND a.reserved_until>now()
    AND p_environment=private.native_billing_environment(p_user_id,a.provider)
    AND EXISTS(SELECT 1 FROM public.profiles WHERE id=p_user_id AND role='cafe_owner_manager' AND suspended_at IS NULL)
    AND EXISTS(SELECT 1 FROM public.cafe_subscriptions WHERE user_id=p_user_id AND owner_paused_at IS NULL)
    AND (p_environment<>'Sandbox' OR NOT EXISTS(SELECT 1 FROM private.native_billing_configuration WHERE environment='Production')
      OR (a.guard_protocol='apple-app-transaction-v1' AND EXISTS(
        SELECT 1 FROM private.apple_sandbox_test_accounts t WHERE t.user_id=p_user_id AND t.enabled AND t.expires_at>clock_timestamp()
          AND t.generation=a.sandbox_tester_generation)));
$provider$;

-- Cross-environment unresolved work remains a blocker after a tester mapping
-- expires/revokes. Never clear a started transaction or guess it was canceled.
CREATE OR REPLACE FUNCTION private.native_checkout_is_blocked(p_user_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,private AS $blocked$
  SELECT EXISTS(SELECT 1 FROM private.native_billing_subscriptions s WHERE s.user_id=p_user_id AND s.superseded_by IS NULL AND s.revision>0
    AND private.native_billing_retained_environment(p_user_id,s.provider,s.environment)
    AND (s.status IN ('pending','payment_required') OR (s.status IN ('active','grace')
      AND (s.auto_renews OR s.current_period_end>now() OR s.grace_period_end>now()))))
    OR EXISTS(SELECT 1 FROM private.native_checkout_attempts a WHERE a.user_id=p_user_id
      AND private.native_billing_retained_environment(p_user_id,a.provider,a.environment)
      AND (a.state='started' OR (a.state='reserved' AND a.reserved_until>now())));
$blocked$;

CREATE OR REPLACE FUNCTION public.native_checkout_pending(p_user_id uuid,p_environment text)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,private AS $pending$
BEGIN
  IF p_environment IS NULL OR p_environment IS DISTINCT FROM private.native_billing_environment(p_user_id,NULL) THEN RAISE EXCEPTION 'Native checkout environment mismatch'; END IF;
  -- A recorded prior environment must still block another purchase after revoke.
  RETURN EXISTS(SELECT 1 FROM private.native_checkout_attempts WHERE user_id=p_user_id
    AND private.native_billing_retained_environment(p_user_id,provider,environment)
    AND (state='started' OR (state='reserved' AND reserved_until>now())));
END;
$pending$;


CREATE OR REPLACE FUNCTION public.native_checkout_cancel(p_user_id uuid, p_environment text, p_attempt_id uuid, p_before_launch boolean)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'private'
AS $function$
declare affected integer;
begin
  if p_before_launch is null or p_environment is null or p_environment not in ('Production','Sandbox') then return false; end if;
  perform 1 from public.cafe_subscriptions where user_id=p_user_id for update;
  if not found then return false; end if;
  update private.native_checkout_attempts set state='cancelled',updated_at=now()
    where id=p_attempt_id and user_id=p_user_id and environment=p_environment
      and (state='reserved' or (not p_before_launch and state='started') or state='cancelled');
  get diagnostics affected=row_count;return affected=1;
end;
$function$;

CREATE OR REPLACE FUNCTION public.native_checkout_settle_verified(p_user_id uuid, p_environment text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'private'
AS $function$
begin
  if p_environment is null or p_environment not in ('Production','Sandbox') then return false; end if;
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
  SELECT EXISTS(SELECT 1 FROM public.profiles WHERE id=p_user_id AND role='cafe_owner_manager' AND suspended_at IS NULL)
    AND EXISTS(SELECT 1 FROM public.cafe_subscriptions WHERE user_id=p_user_id AND owner_paused_at IS NULL)
    AND EXISTS(SELECT 1 FROM private.native_billing_subscriptions s
      WHERE s.user_id=p_user_id AND s.environment=p_environment AND s.superseded_by IS NULL AND s.revision>0
        AND s.environment=private.native_billing_environment(p_user_id,s.provider)
        AND ((s.status='active' AND s.current_period_end>now()) OR (s.status='grace' AND s.grace_period_end>now())));
$access$;

CREATE OR REPLACE FUNCTION public.native_billing_summary(p_user_id uuid,p_environment text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,private AS $summary$
BEGIN
  IF p_environment IS NULL OR p_environment IS DISTINCT FROM private.native_billing_environment(p_user_id,NULL)
    OR NOT EXISTS(SELECT 1 FROM public.profiles WHERE id=p_user_id AND role='cafe_owner_manager' AND suspended_at IS NULL)
    THEN RAISE EXCEPTION 'Native billing account environment is not authorized'; END IF;
  RETURN jsonb_build_object('accountId',p_user_id,'environment',p_environment,
    'ownerPaused',coalesce((SELECT owner_paused_at IS NOT NULL FROM public.cafe_subscriptions WHERE user_id=p_user_id),true),
    'subscriptions',coalesce((
    SELECT jsonb_agg(jsonb_build_object('provider',provider,'status',status,
      'currentPeriodEnd',current_period_end,'gracePeriodEnd',grace_period_end,'autoRenews',auto_renews)
      ORDER BY verified_at DESC,provider,provider_subscription_key)
    FROM private.native_billing_subscriptions s WHERE s.user_id=p_user_id AND s.environment=p_environment
      AND s.environment=private.native_billing_environment(p_user_id,s.provider)
      AND s.superseded_by IS NULL AND s.revision>0
  ),'[]'::jsonb));
END;
$summary$;

-- The only new authenticated interface returns a self-only boolean, never
-- receipts, identifiers, bindings, environments, tester lists or private rows.
CREATE FUNCTION public.native_billing_self_access(p_user_id uuid)
RETURNS boolean LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,private AS $self$
  SELECT CASE WHEN p_user_id IS NULL OR p_user_id IS DISTINCT FROM (SELECT auth.uid()) THEN false
    ELSE coalesce(public.native_billing_access(p_user_id,private.native_billing_environment(p_user_id,NULL)),false) END;
$self$;
REVOKE ALL ON FUNCTION public.native_billing_self_access(uuid) FROM public,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.native_billing_self_access(uuid) TO authenticated,service_role;


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
  ) or public.native_billing_access(p_cafe_id, private.native_billing_environment(p_cafe_id,NULL));
$function$;

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
    or public.native_billing_self_access(target_user_id)
  );
$function$;

-- Replacement retains service-only EXECUTE and fixed search paths. Existing
-- read/owner/event RPCs remain unchanged for owned historical financial events.
REVOKE ALL ON FUNCTION public.native_checkout_provider(uuid,text,uuid),public.native_checkout_pending(uuid,text),
  public.native_checkout_cancel(uuid,text,uuid,boolean),public.native_checkout_settle_verified(uuid,text),
  public.native_billing_apply(uuid,uuid,text,text,text,text,text,text,timestamptz,timestamptz,boolean,bigint,text),
  public.native_billing_access(uuid,text),public.native_billing_summary(uuid,text)
  FROM public,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.native_checkout_provider(uuid,text,uuid),public.native_checkout_pending(uuid,text),
  public.native_checkout_cancel(uuid,text,uuid,boolean),public.native_checkout_settle_verified(uuid,text),
  public.native_billing_apply(uuid,uuid,text,text,text,text,text,text,timestamptz,timestamptz,boolean,bigint,text),
  public.native_billing_access(uuid,text),public.native_billing_summary(uuid,text) TO service_role;
REVOKE ALL ON FUNCTION private.native_checkout_is_blocked(uuid),private.cafe_has_paid_job_entitlement(uuid)
  FROM public,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.cafe_has_hiring_access(uuid) FROM public,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.cafe_has_hiring_access(uuid) TO authenticated,service_role;
-- The mapping must still be empty; this draft never authorizes a test account.
DO $empty$ BEGIN
  IF EXISTS(SELECT 1 FROM private.apple_sandbox_test_accounts) THEN RAISE EXCEPTION 'Tester mapping must remain empty'; END IF;
END; $empty$;
-- Delivered after COMMIT; rollout must verify refreshed named/default RPC
-- dispatch before deploying the backend or authorizing any tester mapping.
NOTIFY pgrst, 'reload schema';
COMMIT;

