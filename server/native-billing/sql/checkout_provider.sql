-- Additive, read-only provider lookup. Apply after native checkout coordination
-- before deploying provider-aware checkout startup. No live schema is changed
-- by saving this source. The existing atomic start/cancel functions are retained.
create function public.native_checkout_provider(p_user_id uuid,p_environment text,p_attempt_id uuid) returns text
language sql stable security definer set search_path=pg_catalog,private as $$
  select a.provider from private.native_checkout_attempts a
  where a.id=p_attempt_id and a.user_id=p_user_id and a.environment=p_environment
    and a.state='reserved' and a.reserved_until>now()
    and exists(select 1 from private.native_billing_configuration where environment=p_environment)
    and exists(select 1 from public.profiles where id=p_user_id and role='cafe_owner_manager' and suspended_at is null);
$$;
revoke all on function public.native_checkout_provider(uuid,text,uuid) from public,anon,authenticated;
grant execute on function public.native_checkout_provider(uuid,text,uuid) to service_role;
