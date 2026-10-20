-- LOCAL MCP REVIEW PAYLOAD ONLY. No hosted application authorized.
-- One DO statement; no transaction control. All inner exceptions propagate.
-- The inner statement_timeout setting is NOT a proven outer DO deadline.
DO $baristamatch_mcp_atomic_c2101c$
BEGIN
  EXECUTE $baristamatch_reviewed_inner_c2101c$
-- LOCAL REVIEW CANDIDATE ONLY: no SQL in this file has been executed.
-- Intended externally verified project: lmwqrxoitraofaftpwhe (baristamatch).
-- PostgreSQL cannot attest a Supabase project ref. Operator must verify project
-- identity outside SQL immediately before any separately approved application.
-- No existing function/trigger/ACL/default, configuration row, or user row is
-- changed. Existing Apple, Stripe, Expo, and reviewer-access objects are untouched.
-- Not registered in migration history; see README.md before promotion/application.

set local lock_timeout = '3s';
set local statement_timeout = '20s';
set local search_path = pg_catalog;

do $preconditions$
begin
  if current_user <> 'postgres' then
    raise exception 'Review executor identity: this candidate requires postgres';
  end if;
  if current_setting('server_version_num')::integer / 10000 <> 17 then
    raise exception 'Review server major version: this candidate was assessed on PostgreSQL 17';
  end if;
  if (select count(*) from pg_roles where rolname in ('anon','authenticated','service_role')) <> 3
     or to_regnamespace('public') is null or to_regnamespace('private') is null
     or to_regnamespace('auth') is null then
    raise exception 'Required existing schemas/roles are missing';
  end if;
  if to_regclass('private.native_billing_configuration') is null
     or to_regclass('private.native_checkout_attempts') is null
     or to_regclass('public.profiles') is null
     or to_regclass('auth.users') is null then
    raise exception 'Required existing billing/Auth/profile tables are missing';
  end if;
  if exists (
    select 1 from (values
      ('private.native_billing_configuration','singleton','boolean'),
      ('private.native_billing_configuration','environment','text'),
      ('private.native_checkout_attempts','id','uuid'),
      ('private.native_checkout_attempts','user_id','uuid'),
      ('private.native_checkout_attempts','provider','text'),
      ('private.native_checkout_attempts','environment','text'),
      ('private.native_checkout_attempts','state','text'),
      ('private.native_checkout_attempts','reserved_until','timestamp with time zone'),
      ('public.profiles','id','uuid'),
      ('public.profiles','role','text'),
      ('public.profiles','suspended_at','timestamp with time zone'),
      ('auth.users','id','uuid')
    ) as required(relation_name,column_name,type_name)
    where not exists (
      select 1 from pg_attribute a
      where a.attrelid = to_regclass(required.relation_name)
        and a.attname = required.column_name and a.attnum > 0 and not a.attisdropped
        and format_type(a.atttypid,a.atttypmod) = required.type_name
    )
  ) then
    raise exception 'Existing dependency column contract differs: re-audit before application';
  end if;
  if exists (
    select 1 from (values
      ('auth.uid()'),
      ('public.native_checkout_claim(uuid,text,text,uuid)'),
      ('public.native_checkout_start(uuid,text,uuid)'),
      ('public.native_checkout_cancel(uuid,text,uuid,boolean)'),
      ('public.native_checkout_recover_apple(uuid,text)'),
      ('public.native_billing_summary(uuid,text)')
    ) as required(signature)
    where to_regprocedure(required.signature) is null
  ) then
    raise exception 'Existing dependency function signature differs: re-audit before application';
  end if;

  -- This lock prevents the singleton changing during the DDL transaction.
  -- Production is a second boundary, not proof of hosted-project identity.
  lock table private.native_billing_configuration in share mode;
  if (select count(*) = 1 and bool_and(singleton is true and environment = 'Production')
      from private.native_billing_configuration) is distinct from true then
    raise exception 'Exactly one existing true/Production singleton is required';
  end if;

  -- Fail on any prior/partial installation or naming collision. Do not silently
  -- accept an unknown definition, replace a function, or widen a previous ACL.
  if exists (
    select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relname in (
      'android_device_push_tokens','android_device_push_tokens_pkey',
      'android_device_push_tokens_user_id_idx')
  ) or exists (
    select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where (n.nspname='public' and p.proname='native_checkout_provider')
       or (n.nspname='private' and p.proname='android_device_push_tokens_touch')
  ) or exists (
    select 1 from pg_type t join pg_namespace n on n.oid=t.typnamespace
    where n.nspname='public' and t.typname='android_device_push_tokens'
  ) then
    raise exception 'A proposed object already exists: compare reviewed definitions; do not rerun';
  end if;
end;
$preconditions$;

-- Trusted lookup only; atomic claim/start/cancel functions remain unchanged.
-- Explicit Production check is redundant with the audited singleton today and
-- prevents this production-specific addition becoming a Sandbox lookup later.
create function public.native_checkout_provider(
  p_user_id uuid, p_environment text, p_attempt_id uuid
) returns text
language sql stable security definer set search_path = pg_catalog, private as $function$
  select a.provider
  from private.native_checkout_attempts a
  where p_environment = 'Production'
    and a.id = p_attempt_id and a.user_id = p_user_id
    and a.environment = p_environment and a.state = 'reserved'
    and a.reserved_until > now()
    and exists (
      select 1 from private.native_billing_configuration c
      where c.singleton is true and c.environment = p_environment
    )
    and exists (
      select 1 from public.profiles p
      where p.id = p_user_id and p.role = 'cafe_owner_manager'
        and p.suspended_at is null
    );
$function$;
revoke all on function public.native_checkout_provider(uuid,text,uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.native_checkout_provider(uuid,text,uuid) to service_role;

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
  constraint android_device_push_tokens_token_check check (
    octet_length(fcm_token) between 1 and 2048
    and fcm_token !~ U&'[[:space:][:cntrl:]\00A0\2007\202F\FEFF]'
  )
);
create index android_device_push_tokens_user_id_idx
  on public.android_device_push_tokens(user_id);

create function private.android_device_push_tokens_touch()
returns trigger language plpgsql security invoker set search_path = '' as $function$
begin
  if tg_op = 'INSERT' then
    new.created_at := statement_timestamp();
  else
    new.created_at := old.created_at;
  end if;
  new.updated_at := statement_timestamp();
  return new;
end;
$function$;
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
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy android_push_tokens_delete_own
  on public.android_device_push_tokens for delete to authenticated
  using ((select auth.uid()) = user_id);

-- Revoke inherited defaults on THIS NEW object only, then grant explicitly.
revoke all on table public.android_device_push_tokens
  from public, anon, authenticated, service_role;
grant select, insert, update, delete on table public.android_device_push_tokens
  to authenticated;
grant select on table public.android_device_push_tokens to service_role;
grant update(enabled, updated_at) on table public.android_device_push_tokens
  to service_role;

-- Reject unexpected default grants/memberships rather than silently preserving
-- access or modifying any shared role/default privilege configuration.
do $acl_postconditions$
declare
  token_table oid := 'public.android_device_push_tokens'::regclass;
  provider_function oid := 'public.native_checkout_provider(uuid,text,uuid)'::regprocedure;
  touch_function oid := 'private.android_device_push_tokens_touch()'::regprocedure;
begin
  if exists (
    select 1 from pg_class c, lateral aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
    where c.oid=token_table and a.grantee<>c.relowner and (
      a.is_grantable or not (
        (a.grantee='authenticated'::regrole and a.privilege_type in ('SELECT','INSERT','UPDATE','DELETE'))
        or (a.grantee='service_role'::regrole and a.privilege_type='SELECT')
      )
    )
  ) or exists (
    select 1 from pg_attribute c, lateral aclexplode(c.attacl) a
    where c.attrelid=token_table and a.grantee<>'postgres'::regrole and (
      a.is_grantable or a.grantee<>'service_role'::regrole
      or a.privilege_type<>'UPDATE' or c.attname not in ('enabled','updated_at')
    )
  ) or exists (
    select 1 from pg_proc p, lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
    where p.oid in (provider_function,touch_function) and a.grantee<>p.proowner and (
      a.is_grantable or p.oid<>provider_function
      or a.grantee<>'service_role'::regrole or a.privilege_type<>'EXECUTE'
    )
  ) then
    raise exception 'Unexpected ACL on proposed objects: transaction aborted';
  end if;
  if exists (
    select 1 from (values ('SELECT'),('INSERT'),('UPDATE'),('DELETE'),('TRUNCATE'),('REFERENCES'),('TRIGGER'),('MAINTAIN')) as privileges(name)
    where has_table_privilege('anon',token_table,privileges.name)
      or (has_table_privilege('service_role',token_table,privileges.name)
          is distinct from (privileges.name='SELECT'))
      or (has_table_privilege('authenticated',token_table,privileges.name)
          is distinct from (privileges.name in ('SELECT','INSERT','UPDATE','DELETE')))
  ) or exists (
    select 1 from pg_attribute a where a.attrelid=token_table and a.attnum>0 and not a.attisdropped
      and has_column_privilege('service_role',token_table,a.attname,'UPDATE')
          is distinct from (a.attname in ('enabled','updated_at'))
  ) or not has_function_privilege('service_role',provider_function,'EXECUTE')
    or has_function_privilege('anon',provider_function,'EXECUTE')
    or has_function_privilege('authenticated',provider_function,'EXECUTE')
    or has_function_privilege('anon',touch_function,'EXECUTE')
    or has_function_privilege('authenticated',touch_function,'EXECUTE')
    or has_function_privilege('service_role',touch_function,'EXECUTE') then
    raise exception 'Unexpected effective privilege on proposed objects: transaction aborted';
  end if;
end;
$acl_postconditions$;

$baristamatch_reviewed_inner_c2101c$;
END;
$baristamatch_mcp_atomic_c2101c$ LANGUAGE plpgsql;
