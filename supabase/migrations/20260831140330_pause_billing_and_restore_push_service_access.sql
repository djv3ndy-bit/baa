-- Billing stays disabled until a later migration explicitly enables it.
-- Existing and future cafe accounts keep full hiring access in the meantime.
update public.cafe_subscriptions
set complimentary_access = true,
    updated_at = now()
where complimentary_access is distinct from true;

create or replace function public.ensure_cafe_subscription()
returns public.cafe_subscriptions
language plpgsql
security definer
set search_path = public
as $$
declare
  result public.cafe_subscriptions;
begin
  if not exists (
    select 1
    from public.profiles
    where id = auth.uid() and role = 'cafe_owner_manager'
  ) then
    raise exception 'Cafe account required';
  end if;

  insert into public.cafe_subscriptions (user_id, complimentary_access)
  values (auth.uid(), true)
  on conflict (user_id) do update
  set complimentary_access = true,
      updated_at = now();

  select * into result
  from public.cafe_subscriptions
  where user_id = auth.uid();

  return result;
end;
$$;

revoke execute on function public.ensure_cafe_subscription() from public, anon;
grant execute on function public.ensure_cafe_subscription() to authenticated;

-- Server-side notification delivery uses PostgREST and therefore needs
-- explicit table grants even though it also uses the service role.
grant select on table public.profiles to service_role;
grant select, update on table public.device_push_tokens to service_role;
grant select, insert on table public.push_event_log to service_role;
