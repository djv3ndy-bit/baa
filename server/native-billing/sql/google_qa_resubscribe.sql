-- LOCAL REVIEW CANDIDATE ONLY. Never apply without separate exact-project approval.
-- Executor must independently verify ojvjlvojvozvhktbclcg. PostgreSQL cannot
-- attest a Supabase project ref; the existing QA configuration is defense in depth.
-- No existing function, ACL, table, policy or trigger is replaced.
begin;
set local lock_timeout='3s';
do $preflight$ begin
  if current_user <> 'postgres' or current_setting('server_version_num')::integer/10000 <> 17 then
    raise exception 'Expected isolated PostgreSQL17 owner executor';
  end if;
  if exists(select 1 from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace
    where p.proname='native_billing_apply_google_qa_resubscribe') then
    raise exception 'QA resubscribe function already exists; do not replace';
  end if;
  if pg_catalog.to_regprocedure('public.native_billing_read(text,text,text)') is null
    or pg_catalog.to_regprocedure('public.native_billing_apply(uuid,uuid,text,text,text,text,text,text,timestamp with time zone,timestamp with time zone,boolean,bigint,text)') is null then
    raise exception 'Existing native billing contract unavailable';
  end if;
  if (select count(*)=1 and bool_and(singleton and environment='Sandbox') from private.native_billing_configuration) is distinct from true
    or not exists(select 1 from private.android_reviewer_configuration where singleton
      and project_ref='ojvjlvojvozvhktbclcg' and api_base_url='https://android-testing.baristajobmatch.com/api'
      and package_name='com.baristajobmatch.app' and environment='Sandbox'
      and custom_environment_id='env_E4F5E2NjsH4RaKOs0Jxp4Zo3AxDQ') then
    raise exception 'Existing exact QA configuration required';
  end if;
end $preflight$;

create function public.native_billing_apply_google_qa_resubscribe(
  p_user_id uuid,p_binding uuid,p_subscription_id text,p_product_id text,p_base_plan_id text,
  p_transaction_id text,p_status text,p_period_end timestamptz,p_grace_end timestamptz,
  p_auto_renews boolean,p_expected_revision bigint,p_predecessor_id text,
  p_predecessor_revision bigint,p_predecessor_period_end timestamptz,
  p_predecessor_provider_expiry timestamptz,p_predecessor_provider_state text
) returns text language plpgsql security definer set search_path='' set lock_timeout='3s' as $function$
declare old private.native_billing_subscriptions%rowtype; new_key text;
begin
  if (select count(*)=1 and bool_and(singleton and environment='Sandbox') from private.native_billing_configuration) is distinct from true
    or not exists(select 1 from private.android_reviewer_configuration where singleton
      and project_ref='ojvjlvojvozvhktbclcg' and api_base_url='https://android-testing.baristajobmatch.com/api'
      and package_name='com.baristajobmatch.app' and environment='Sandbox'
      and custom_environment_id='env_E4F5E2NjsH4RaKOs0Jxp4Zo3AxDQ') then
    raise exception 'QA resubscribe scope unavailable';
  end if;
  if p_product_id is distinct from 'baristamatch_cafe_pro' or p_base_plan_id is distinct from 'monthly-us'
    or p_user_id is null or p_binding is null or p_expected_revision is null or p_expected_revision<0
    or p_subscription_id is null or length(p_subscription_id) not between 1 and 8192
    or p_predecessor_id is null or length(p_predecessor_id) not between 1 and 8192
    or p_subscription_id=p_predecessor_id or p_predecessor_revision is null or p_predecessor_revision<=0
    or p_predecessor_period_end is null or not pg_catalog.isfinite(p_predecessor_period_end)
    or p_predecessor_period_end<=timestamptz '1970-01-01' or p_predecessor_period_end>pg_catalog.clock_timestamp()
    or p_predecessor_provider_expiry is null or not pg_catalog.isfinite(p_predecessor_provider_expiry)
    or p_predecessor_provider_expiry<=timestamptz '1970-01-01' or p_predecessor_provider_expiry>pg_catalog.clock_timestamp()
    or p_predecessor_provider_state is distinct from 'SUBSCRIPTION_STATE_EXPIRED' then
    raise exception 'Invalid QA predecessor evidence';
  end if;
  -- Same lock and account binding as the existing generic apply. All eligibility
  -- and predecessor revision checks below remain in this transaction.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('native-billing:'||p_user_id::text,0));
  -- Auth first, then profile, following the normal Auth deletion/cascade order.
  -- Keep eligibility stable until this transaction completes, not through ACK.
  perform 1 from auth.users where id=p_user_id for share;
  if not found then raise exception 'QA resubscribe account unavailable'; end if;
  perform 1 from public.profiles where id=p_user_id and role='cafe_owner_manager' and suspended_at is null for share;
  if not found then raise exception 'QA resubscribe account unavailable'; end if;
  perform 1 from private.native_billing_accounts where user_id=p_user_id and store_binding=p_binding for share;
  if not found then raise exception 'QA resubscribe account unavailable'; end if;
  new_key:=pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_subscription_id,'UTF8')),'hex');
  select * into old from private.native_billing_subscriptions
    where provider='google' and environment='Sandbox'
      and provider_subscription_key=pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_predecessor_id,'UTF8')),'hex')
      and provider_subscription_id=p_predecessor_id for update;
  if not found or old.user_id<>p_user_id or old.product_id<>p_product_id or old.revision<=0
    or old.current_period_end is null or not pg_catalog.isfinite(old.current_period_end)
    or old.current_period_end<=timestamptz '1970-01-01' or old.current_period_end>pg_catalog.clock_timestamp()
    or old.verified_at is null or not pg_catalog.isfinite(old.verified_at)
    or old.status not in ('active','grace','payment_required','expired','revoked')
    or (old.status='revoked' and old.superseded_by is distinct from new_key)
    or (old.superseded_by is not null and old.superseded_by<>new_key) then
    raise exception 'QA predecessor ownership unavailable';
  end if;
  if old.revision<>p_predecessor_revision or old.current_period_end is distinct from p_predecessor_period_end then
    return 'retry';
  end if;
  return public.native_billing_apply(p_user_id,p_binding,'google','Sandbox',p_subscription_id,
    p_product_id,p_transaction_id,p_status,p_period_end,p_grace_end,p_auto_renews,p_expected_revision,p_predecessor_id);
end $function$;

revoke all on function public.native_billing_apply_google_qa_resubscribe(uuid,uuid,text,text,text,text,text,timestamptz,timestamptz,boolean,bigint,text,bigint,timestamptz,timestamptz,text) from public,anon,authenticated,service_role;
grant execute on function public.native_billing_apply_google_qa_resubscribe(uuid,uuid,text,text,text,text,text,timestamptz,timestamptz,boolean,bigint,text,bigint,timestamptz,timestamptz,text) to service_role;
do $postcheck$ begin
  if pg_catalog.has_function_privilege('anon','public.native_billing_apply_google_qa_resubscribe(uuid,uuid,text,text,text,text,text,timestamptz,timestamptz,boolean,bigint,text,bigint,timestamptz,timestamptz,text)','EXECUTE')
    or pg_catalog.has_function_privilege('authenticated','public.native_billing_apply_google_qa_resubscribe(uuid,uuid,text,text,text,text,text,timestamptz,timestamptz,boolean,bigint,text,bigint,timestamptz,timestamptz,text)','EXECUTE')
    or not pg_catalog.has_function_privilege('service_role','public.native_billing_apply_google_qa_resubscribe(uuid,uuid,text,text,text,text,text,timestamptz,timestamptz,boolean,bigint,text,bigint,timestamptz,timestamptz,text)','EXECUTE') then
    raise exception 'Unexpected QA resubscribe function privileges';
  end if;
end $postcheck$;
commit;
