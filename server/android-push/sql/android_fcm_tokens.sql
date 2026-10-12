-- REVIEW ARTIFACT ONLY. Not applied; not a general-purpose migration.
-- EXECUTOR PRECONDITION: independently verify the selected hosted project is
-- ojvjlvojvozvhktbclcg (the independent Android payment-review project) before
-- executing any SQL in this file. Never execute against the Apple review or
-- production project. PostgreSQL does not intrinsically attest a Supabase
-- project ref here: the Sandbox check below is defense in depth, not proof of
-- hosted-project identity. A caller-set GUC or JWT claim is not such proof.
-- Apply only after the native billing configuration exists and is Sandbox.
-- This artifact deliberately fails if the table/function already exists.
-- It does not modify the existing Expo token table or any default privileges.

begin;
set local lock_timeout = '3s';

do $$
begin
  if to_regclass('private.native_billing_configuration') is null then
    raise exception 'Android FCM requires an existing Sandbox billing configuration';
  end if;
  lock table private.native_billing_configuration in share mode;
  if (select count(*) = 1 and bool_and(singleton is true and environment = 'Sandbox')
      from private.native_billing_configuration) is distinct from true then
    raise exception 'Android FCM requires exactly one Sandbox billing configuration';
  end if;
end;
$$;

create table public.android_device_push_tokens (
  fcm_token text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  platform text not null default 'android' check (platform = 'android'),
  firebase_project_id text not null default 'baristamatch'
    check (firebase_project_id = 'baristamatch'),
  package_name text not null default 'com.baristajobmatch.app'
    check (package_name = 'com.baristajobmatch.app'),
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- FCM tokens are opaque. Bound bytes for storage/index safety; do not guess
  -- a vendor-specific token format or silently trim a different token.
  constraint android_device_push_tokens_token_check check (
    octet_length(fcm_token) between 1 and 2048
    -- POSIX space excludes nonbreaking spaces; include them and JS's BOM space.
    and fcm_token !~ U&'[[:space:][:cntrl:]\00A0\2007\202F\FEFF]'
  )
);

-- Index all ownership rows, including disabled tokens, for RLS and FK deletion.
create index android_device_push_tokens_user_id_idx
  on public.android_device_push_tokens(user_id);

create function private.android_device_push_tokens_touch()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    new.created_at := statement_timestamp();
  else
    new.created_at := old.created_at;
  end if;
  new.updated_at := statement_timestamp();
  return new;
end;
$$;
revoke all on function private.android_device_push_tokens_touch()
  from public, anon, authenticated, service_role;
create trigger android_device_push_tokens_touch
  before insert or update on public.android_device_push_tokens
  for each row execute function private.android_device_push_tokens_touch();

alter table public.android_device_push_tokens enable row level security;
create policy android_push_tokens_select_own
  on public.android_device_push_tokens for select to authenticated
  using ((select auth.uid()) = user_id);
create policy android_push_tokens_insert_own
  on public.android_device_push_tokens for insert to authenticated
  with check ((select auth.uid()) = user_id);
create policy android_push_tokens_update_own
  on public.android_device_push_tokens for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
create policy android_push_tokens_delete_own
  on public.android_device_push_tokens for delete to authenticated
  using ((select auth.uid()) = user_id);

-- Remove broad Supabase-style default grants on this new table only.
revoke all on table public.android_device_push_tokens
  from public, anon, authenticated, service_role;
grant select, insert, update, delete on table public.android_device_push_tokens
  to authenticated;
-- Trusted sender reads recipients and disables invalid tokens. It cannot
-- register/delete tokens or transfer their identity through these grants.
grant select on table public.android_device_push_tokens to service_role;
grant update(enabled, updated_at) on table public.android_device_push_tokens
  to service_role;

commit;
