-- ADDITIVE REVIEW SOURCE. Not applied by saving this file. Existing native and
-- website functions, tables, policies and default privileges remain unchanged.
begin;
do $guard$
begin
  if current_user<>'postgres' or current_setting('server_version_num')::int/10000<>17
    or to_regclass('public.cafe_subscriptions') is null
    or to_regclass('public.profiles') is null
    or to_regclass('private.native_checkout_attempts') is null
    or to_regprocedure('public.native_checkout_cancel(uuid,text,uuid,boolean)') is null
    or (select count(*) from private.native_billing_configuration)<>1
    or not exists(select 1 from private.native_billing_configuration where singleton=true and environment='Production') then
    raise exception 'Google cancellation dependency mismatch';
  end if;
  if exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname='android_google_checkout_cancel') then
    raise exception 'Google cancellation object already exists';
  end if;
end;
$guard$;

create function public.android_google_checkout_cancel(p_user_id uuid,p_attempt_id uuid,p_before_launch boolean) returns boolean
language plpgsql security definer set search_path=pg_catalog,private as $function$
declare owned private.native_checkout_attempts%rowtype;
begin
  if p_user_id is null or p_attempt_id is null or p_before_launch is null
    or not exists(select 1 from private.native_billing_configuration where singleton=true and environment='Production')
    or not exists(select 1 from public.profiles where id=p_user_id and role='cafe_owner_manager' and suspended_at is null) then return false; end if;
  -- Same lock order as existing claim/start/cancel and Stripe claims.
  perform 1 from public.cafe_subscriptions where user_id=p_user_id for update;
  if not found then return false; end if;
  select * into owned from private.native_checkout_attempts
    where id=p_attempt_id and user_id=p_user_id and provider='google' and environment='Production' for update;
  if not found or owned.state not in ('reserved','started','cancelled')
    or (p_before_launch and owned.state='started') then return false; end if;
  -- Provider/owner/state cannot change between this check and original cancel.
  return public.native_checkout_cancel(p_user_id,'Production',p_attempt_id,p_before_launch);
end;
$function$;
revoke all on function public.android_google_checkout_cancel(uuid,uuid,boolean) from public,anon,authenticated;
grant execute on function public.android_google_checkout_cancel(uuid,uuid,boolean) to service_role;
commit;
