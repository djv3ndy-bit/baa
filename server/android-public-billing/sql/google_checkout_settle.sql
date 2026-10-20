-- ADDITIVE REVIEW SOURCE. The original all-provider settlement function and
-- Apple checkout behavior are unchanged. Call only after durable Google apply.
begin;
do $guard$
begin
  if current_user<>'postgres' or current_setting('server_version_num')::int/10000<>17
    or to_regclass('public.cafe_subscriptions') is null
    or to_regclass('public.profiles') is null
    or to_regclass('private.native_checkout_attempts') is null
    or to_regclass('private.native_billing_subscriptions') is null
    or (select count(*) from private.native_billing_configuration)<>1
    or not exists(select 1 from private.native_billing_configuration where singleton=true and environment='Production') then
    raise exception 'Google settlement dependency mismatch';
  end if;
  if exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname='android_google_checkout_settle_verified') then
    raise exception 'Google settlement object already exists';
  end if;
end;
$guard$;

create function public.android_google_checkout_settle_verified(p_user_id uuid) returns boolean
language plpgsql security definer set search_path=pg_catalog,private as $function$
declare affected integer;
begin
  if p_user_id is null
    or not exists(select 1 from private.native_billing_configuration where singleton=true and environment='Production')
    or not exists(select 1 from public.profiles where id=p_user_id and role='cafe_owner_manager' and suspended_at is null) then return false; end if;
  perform 1 from public.cafe_subscriptions where user_id=p_user_id for update;
  if not found then return false; end if;
  -- A current durable provider record must already block a duplicate purchase.
  -- Expired/revoked restoration is not evidence that another store sheet ended.
  update private.native_checkout_attempts a set state='verified',updated_at=now()
  where a.user_id=p_user_id and a.provider='google' and a.environment='Production' and a.state in ('reserved','started')
    and exists(select 1 from private.native_billing_subscriptions s
      where s.user_id=p_user_id and s.provider='google' and s.environment='Production'
        and s.superseded_by is null and s.revision>0
        and (s.status in ('pending','payment_required')
          or (s.status in ('active','grace') and (s.auto_renews or s.current_period_end>now() or s.grace_period_end>now()))));
  get diagnostics affected=row_count;
  return affected>0;
end;
$function$;
revoke all on function public.android_google_checkout_settle_verified(uuid) from public,anon,authenticated;
grant execute on function public.android_google_checkout_settle_verified(uuid) to service_role;
commit;
