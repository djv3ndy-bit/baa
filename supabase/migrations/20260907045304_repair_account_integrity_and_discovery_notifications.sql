-- Account audit repairs. No member visibility preferences or billing state change.
create or replace function public.profile_meets_visibility_requirements(p public.profiles)
returns boolean language sql immutable set search_path = '' as $$
  select case when p.role = 'barista' then
    nullif(btrim(coalesce(p.display_name,'')),'') is not null and
    nullif(btrim(coalesce(p.avatar_url,'')),'') is not null and
    nullif(btrim(coalesce(p.location,'')),'') is not null and
    nullif(btrim(coalesce(p.bio,'')),'') is not null and
    exists(select 1 from unnest(p.skills) skill where nullif(btrim(skill),'') is not null) and
    nullif(btrim(coalesce(p.availability,'')),'') is not null and
    nullif(btrim(coalesce(p.experience,'')),'') is not null and
    nullif(btrim(coalesce(p.pay_expectation,'')),'') is not null
  when p.role = 'cafe_owner_manager' then
    nullif(btrim(coalesce(p.cafe_name,'')),'') is not null and
    nullif(btrim(coalesce(p.avatar_url,'')),'') is not null and
    nullif(btrim(coalesce(p.location,'')),'') is not null and
    nullif(btrim(coalesce(p.bio,'')),'') is not null and
    nullif(btrim(coalesce(p.cafe_address,'')),'') is not null and
    nullif(btrim(coalesce(p.open_hours,'')),'') is not null and
    nullif(btrim(coalesce(p.shop_type,'')),'') is not null and
    exists(select 1 from unnest(p.barista_preferences) preference where nullif(btrim(preference),'') is not null)
  else false end;
$$;

-- OAuth identities do not yet have a selected account role. Let authentication
-- finish so the application can obtain an explicit role and create their profile.
create or replace function private.handle_new_email_profile()
returns trigger language plpgsql security definer set search_path = '' as $$
declare requested_role text := new.raw_user_meta_data ->> 'role';
begin
  if requested_role is null or requested_role not in ('barista','cafe_owner_manager') then
    return new;
  end if;
  insert into public.profiles(id,role,display_name,cafe_name,location)
  values(new.id,requested_role,
    case when requested_role='barista' then nullif(left(trim(new.raw_user_meta_data->>'display_name'),200),'') else null end,
    case when requested_role='cafe_owner_manager' then nullif(left(trim(new.raw_user_meta_data->>'cafe_name'),200),'') else null end,
    nullif(left(trim(new.raw_user_meta_data->>'location'),200),''))
  on conflict(id) do nothing;
  return new;
end;
$$;
revoke all on function private.handle_new_email_profile() from public, anon, authenticated;

alter policy "Complete baristas can apply to jobs" on public.applications
with check (
  status = 'interested' and barista_id = (select auth.uid())
  and exists(select 1 from public.profiles p where p.id=(select auth.uid())
    and p.role='barista' and p.is_discoverable=true and p.suspended_at is null)
  and exists(select 1 from public.jobs j join public.profiles cp on cp.id=j.owner_id
    where j.id=applications.job_id and j.active=true and cp.is_discoverable=true and cp.suspended_at is null)
);

-- RLS still decides which account can see/change a row. This invoker trigger
-- protects immutable relationships and transitions even on direct Data API calls.
create or replace function public.protect_application_state()
returns trigger language plpgsql set search_path = '' as $$
begin
  if current_user not in ('authenticated','anon') then return new; end if;
  if tg_op='INSERT' then
    if new.status is distinct from 'interested' then
      raise exception 'New applications must start as interested' using errcode='42501';
    end if;
    return new;
  end if;
  if new.id is distinct from old.id or new.job_id is distinct from old.job_id
     or new.barista_id is distinct from old.barista_id or new.created_at is distinct from old.created_at then
    raise exception 'Application identity cannot be changed' using errcode='42501';
  end if;
  if new.note is distinct from old.note and old.barista_id is distinct from (select auth.uid()) then
    raise exception 'Only the applicant can edit their note' using errcode='42501';
  end if;
  if new.status is not distinct from old.status then return new; end if;
  if old.barista_id=(select auth.uid()) and old.status in ('interested','matched') and new.status='withdrawn' then
    return new;
  end if;
  if old.status='interested' and new.status in ('matched','declined') and exists(
    select 1 from public.jobs j where j.id=old.job_id and j.owner_id=(select auth.uid())
  ) then return new; end if;
  raise exception 'This application status change is not allowed' using errcode='42501';
end;
$$;
revoke all on function public.protect_application_state() from public, anon, authenticated;
drop trigger if exists protect_application_state on public.applications;
create trigger protect_application_state before insert or update on public.applications
for each row execute function public.protect_application_state();

-- Validate new/revised addresses while allowing ordinary updates (such as
-- pausing a job) on legacy rows whose structured address was never collected.
create or replace function public.validate_job_location()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op='UPDATE' and new.location is not distinct from old.location
    and new.address_line1 is not distinct from old.address_line1
    and new.address_line2 is not distinct from old.address_line2
    and new.city is not distinct from old.city and new.state is not distinct from old.state
    and new.postal_code is not distinct from old.postal_code then return new; end if;
  new.state := upper(btrim(coalesce(new.state,'')));
  new.city := btrim(coalesce(new.city,''));
  new.postal_code := btrim(coalesce(new.postal_code,''));
  new.address_line1 := btrim(coalesce(new.address_line1,''));
  if new.state <> 'FL' or new.city='' or new.address_line1=''
    or new.postal_code !~ '^[0-9]{5}(-[0-9]{4})?$' then
    raise exception 'Enter a street address, Florida city, FL state, and valid ZIP code' using errcode='23514';
  end if;
  new.location := new.city || ', ' || new.state || ', ' || new.postal_code;
  return new;
end;
$$;
revoke all on function public.validate_job_location() from public, anon, authenticated;
drop trigger if exists validate_job_location on public.jobs;
create trigger validate_job_location before insert or update on public.jobs
for each row execute function public.validate_job_location();

-- Give mutual-discovery conversations the same durable unread lifecycle as
-- application conversations. Existing application notifications are unchanged.
alter table public.notifications
  add column if not exists discovery_match_id uuid references public.discovery_matches(id) on delete cascade;
create index if not exists notifications_discovery_match_recipient_unread_idx
  on public.notifications(discovery_match_id,recipient_id) where read_at is null;

create or replace function private.create_discovery_message_notification()
returns trigger language plpgsql security definer set search_path = '' as $$
declare recipient uuid;
begin
  select case when new.sender_id=dm.barista_id then dm.cafe_id else dm.barista_id end
    into recipient from public.discovery_matches dm
    where dm.id=new.match_id and new.sender_id in (dm.barista_id,dm.cafe_id);
  if recipient is not null then
    insert into public.notifications(recipient_id,actor_id,type,title,body,discovery_match_id)
    values(recipient,new.sender_id,'message','New message from your match','Open your matched conversation.',new.match_id);
  end if;
  return new;
end;
$$;
revoke all on function private.create_discovery_message_notification() from public, anon, authenticated;
drop trigger if exists trg_discovery_message_notification on public.discovery_messages;
create trigger trg_discovery_message_notification after insert on public.discovery_messages
for each row execute function private.create_discovery_message_notification();

create or replace function public.mark_discovery_conversation_read(p_match_id uuid)
returns integer language plpgsql security invoker set search_path = '' as $$
declare affected integer;
begin
  if (select auth.uid()) is null or not exists(
    select 1 from public.discovery_matches dm where dm.id=p_match_id
      and (select auth.uid()) in (dm.barista_id,dm.cafe_id)
  ) then raise exception 'Conversation unavailable' using errcode='42501'; end if;
  update public.notifications set read_at=now()
    where recipient_id=(select auth.uid()) and discovery_match_id=p_match_id and read_at is null;
  get diagnostics affected = row_count;
  return affected;
end;
$$;
revoke all on function public.mark_discovery_conversation_read(uuid) from public, anon;
grant execute on function public.mark_discovery_conversation_read(uuid) to authenticated;
