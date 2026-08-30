-- Prevent clients from granting themselves a different role, verification,
-- or removing an account suspension. Service-side administration still works.
create or replace function public.protect_profile_authorization_fields()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if current_user in ('authenticated', 'anon') then
    if tg_op = 'INSERT' then
      new.verification_status := 'unverified';
      new.suspended_at := null;
      new.trust_updated_at := null;
    elsif new.id is distinct from old.id
       or new.role is distinct from old.role
       or new.verification_status is distinct from old.verification_status
       or new.suspended_at is distinct from old.suspended_at
       or new.trust_updated_at is distinct from old.trust_updated_at then
      raise exception 'Protected account fields cannot be changed';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists protect_profile_authorization_fields on public.profiles;
create trigger protect_profile_authorization_fields
before insert or update on public.profiles
for each row execute function public.protect_profile_authorization_fields();

revoke execute on function public.protect_profile_authorization_fields() from public, anon, authenticated;

-- These tables are intentionally server-only. Remove inherited client grants
-- so RLS is backed by table privileges as an additional layer.
revoke all on table public.app_errors from anon, authenticated;
revoke all on table public.support_admins from anon, authenticated;
revoke all on table public.support_ticket_updates from anon, authenticated;
revoke all on table public.support_tickets from anon, authenticated;
revoke all on table public.waitlist_signups from anon, authenticated;

grant insert on table public.app_errors to service_role;
grant select, insert, update on table public.support_tickets to service_role;
grant select, insert, update on table public.support_ticket_updates to service_role;
grant select on table public.support_admins to service_role;
grant select, insert on table public.waitlist_signups to service_role;
