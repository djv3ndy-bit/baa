-- Email signups do not have a client session until confirmation, so a client
-- insert cannot create their profile. Create only profiles whose signup
-- metadata contains an explicitly supported role. OAuth users without a role
-- continue to choose one inside the app after signing in.
create or replace function private.handle_new_email_profile()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  requested_role text := new.raw_user_meta_data ->> 'role';
begin
  if requested_role not in ('barista', 'cafe_owner_manager') then
    return new;
  end if;

  insert into public.profiles (id, role, display_name, cafe_name, location)
  values (
    new.id,
    requested_role,
    case when requested_role = 'barista'
      then nullif(left(trim(new.raw_user_meta_data ->> 'display_name'), 200), '')
      else null end,
    case when requested_role = 'cafe_owner_manager'
      then nullif(left(trim(new.raw_user_meta_data ->> 'cafe_name'), 200), '')
      else null end,
    nullif(left(trim(new.raw_user_meta_data ->> 'location'), 200), '')
  )
  on conflict (id) do nothing;

  return new;
end;
$$;

revoke all on function private.handle_new_email_profile() from public;

drop trigger if exists on_auth_user_created_create_profile on auth.users;
create trigger on_auth_user_created_create_profile
after insert on auth.users
for each row execute function private.handle_new_email_profile();

-- Repair confirmed or pending email accounts created before the hook existed.
insert into public.profiles (id, role, display_name, cafe_name, location)
select
  user_account.id,
  user_account.raw_user_meta_data ->> 'role',
  case when user_account.raw_user_meta_data ->> 'role' = 'barista'
    then nullif(left(trim(user_account.raw_user_meta_data ->> 'display_name'), 200), '')
    else null end,
  case when user_account.raw_user_meta_data ->> 'role' = 'cafe_owner_manager'
    then nullif(left(trim(user_account.raw_user_meta_data ->> 'cafe_name'), 200), '')
    else null end,
  nullif(left(trim(user_account.raw_user_meta_data ->> 'location'), 200), '')
from auth.users user_account
left join public.profiles profile on profile.id = user_account.id
where profile.id is null
  and user_account.raw_user_meta_data ->> 'role' in ('barista', 'cafe_owner_manager')
on conflict (id) do nothing;
