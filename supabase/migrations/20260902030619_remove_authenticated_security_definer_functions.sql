create or replace function public.cafe_has_hiring_access(target_user_id uuid)
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select target_user_id = (select auth.uid()) and (
    coalesce((select p.role from public.profiles p where p.id = target_user_id), '') <> 'cafe_owner_manager'
    or exists (
      select 1
      from public.cafe_subscriptions s
      where s.user_id = target_user_id
        and (
          s.complimentary_access = true
          or s.status = 'active'
          or (s.status = 'trialing' and s.trial_ends_at > now())
        )
    )
  );
$$;

revoke execute on function public.cafe_has_hiring_access(uuid) from public, anon;
grant execute on function public.cafe_has_hiring_access(uuid) to authenticated, service_role;

drop policy if exists "Cafe owners can create own complimentary access" on public.cafe_subscriptions;
create policy "Cafe owners can create own complimentary access"
on public.cafe_subscriptions for insert
to authenticated
with check (
  user_id = (select auth.uid())
  and complimentary_access = true
  and exists (
    select 1 from public.profiles p
    where p.id = (select auth.uid()) and p.role = 'cafe_owner_manager'
  )
);

drop policy if exists "Cafe owners can maintain own complimentary access" on public.cafe_subscriptions;
create policy "Cafe owners can maintain own complimentary access"
on public.cafe_subscriptions for update
to authenticated
using (
  user_id = (select auth.uid())
  and exists (
    select 1 from public.profiles p
    where p.id = (select auth.uid()) and p.role = 'cafe_owner_manager'
  )
)
with check (
  user_id = (select auth.uid())
  and complimentary_access = true
  and exists (
    select 1 from public.profiles p
    where p.id = (select auth.uid()) and p.role = 'cafe_owner_manager'
  )
);

revoke insert, update on table public.cafe_subscriptions from authenticated;
grant insert (user_id, complimentary_access) on table public.cafe_subscriptions to authenticated;
grant update (complimentary_access, updated_at) on table public.cafe_subscriptions to authenticated;

create or replace function public.ensure_cafe_subscription()
returns public.cafe_subscriptions
language plpgsql
security invoker
set search_path = ''
as $$
declare
  caller_id uuid := (select auth.uid());
  result public.cafe_subscriptions;
begin
  if caller_id is null or not exists (
    select 1 from public.profiles p
    where p.id = caller_id and p.role = 'cafe_owner_manager'
  ) then
    raise exception 'Cafe account required';
  end if;

  insert into public.cafe_subscriptions (user_id, complimentary_access)
  values (caller_id, true)
  on conflict (user_id) do update
  set complimentary_access = true,
      updated_at = now();

  select * into result
  from public.cafe_subscriptions s
  where s.user_id = caller_id;

  return result;
end;
$$;

revoke execute on function public.ensure_cafe_subscription() from public, anon;
grant execute on function public.ensure_cafe_subscription() to authenticated;

drop policy if exists "Matched recipients can mark messages read" on public.messages;
create policy "Matched recipients can mark messages read"
on public.messages for update
to authenticated
using (
  sender_id <> (select auth.uid())
  and exists (
    select 1
    from public.applications a
    join public.jobs j on j.id = a.job_id
    where a.id = messages.application_id
      and a.status = 'matched'
      and (a.barista_id = (select auth.uid()) or j.owner_id = (select auth.uid()))
  )
)
with check (
  sender_id <> (select auth.uid())
  and exists (
    select 1
    from public.applications a
    join public.jobs j on j.id = a.job_id
    where a.id = messages.application_id
      and a.status = 'matched'
      and (a.barista_id = (select auth.uid()) or j.owner_id = (select auth.uid()))
  )
);

grant update (read_at) on table public.messages to authenticated;
revoke update on table public.notifications from authenticated;
grant update (read_at) on table public.notifications to authenticated;

create or replace function public.mark_conversation_read(p_application_id uuid)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  caller_id uuid := (select auth.uid());
begin
  if caller_id is null then raise exception 'not authenticated'; end if;
  if not exists (
    select 1
    from public.applications a
    join public.jobs j on j.id = a.job_id
    where a.id = p_application_id
      and a.status = 'matched'
      and (a.barista_id = caller_id or j.owner_id = caller_id)
  ) then
    raise exception 'not allowed';
  end if;

  update public.messages
  set read_at = coalesce(read_at, now())
  where application_id = p_application_id
    and sender_id <> caller_id
    and read_at is null;

  update public.notifications
  set read_at = coalesce(read_at, now())
  where recipient_id = caller_id
    and application_id = p_application_id
    and type = 'message'
    and read_at is null;
end;
$$;

revoke execute on function public.mark_conversation_read(uuid) from public, anon;
grant execute on function public.mark_conversation_read(uuid) to authenticated;
