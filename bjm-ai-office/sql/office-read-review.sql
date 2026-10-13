-- UNAPPLIED REVIEW PACKAGE. Run only in an isolated validation database first.
-- This is not a generated production migration and does not activate Auth hooks.
-- Provision through the project's normal migration workflow after review.
-- Keep Office auth disabled until real OAuth and direct Data API isolation pass.
-- No owner/client/origin values or production credentials are embedded here.
-- Existing customer grants are never silently revoked to make this package pass.

begin;
-- The verified hosted project uses PostgreSQL 17.6. SET/INHERIT membership
-- options below require PostgreSQL 16+; refuse an unreviewed older dialect.
do $$ begin
  if current_user <> session_user then
    raise exception 'Office review package requires the authenticated migration session role';
  end if;
  if pg_catalog.current_setting('server_version_num')::integer < 160000 then
    raise exception 'Office review package requires PostgreSQL 16 or newer';
  end if;
end $$;
create role bjm_office_reader nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
create role bjm_office_aggregate nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
-- Hosted postgres is CREATEROLE, not a superuser. Its automatic ADMIN-only
-- membership does not permit ALTER OWNER/SET ROLE. Save our exact grantor row,
-- add only the missing SET ability, then restore it before COMMIT. Never revoke
-- a pre-existing grant or depend on role-wide INHERIT during installation.
do $$
declare
  installer text := current_user;
  installer_oid oid := (select oid from pg_catalog.pg_roles where rolname=current_user);
  prior jsonb;
  changed boolean := not pg_catalog.pg_has_role(current_user,'bjm_office_aggregate','SET');
begin
  select pg_catalog.jsonb_build_object('set',m.set_option,'inherit',m.inherit_option,'admin',m.admin_option)
    into prior from pg_catalog.pg_auth_members m
    where m.roleid='bjm_office_aggregate'::regrole and m.member=installer_oid and m.grantor=installer_oid;
  perform pg_catalog.set_config('bjm_office.install_membership',
    pg_catalog.jsonb_build_object('installer',installer,'changed',changed,'prior',prior)::text,true);
  if changed then
    if prior is null then
      execute pg_catalog.format('grant bjm_office_aggregate to %I with set true, inherit false, admin false granted by %I',installer,installer);
    else
      execute pg_catalog.format('grant bjm_office_aggregate to %I with set true granted by %I',installer,installer);
    end if;
  end if;
end $$;
create schema bjm_office_private;
revoke all on schema bjm_office_private from public;
grant usage on schema public, bjm_office_private to bjm_office_reader;
grant usage on schema public, bjm_office_private to bjm_office_aggregate;

create table bjm_office_private.configuration (
  singleton boolean primary key default true check (singleton),
  owner_id uuid not null,
  client_id uuid not null,
  resource text not null check (resource ~ '^https://[^/?#]+/mcp$'),
  issuer text not null check (issuer ~ '^https://[^/?#]+/auth/v1$'),
  enabled boolean not null default false
);
revoke all on table bjm_office_private.configuration from public, anon, authenticated, bjm_office_reader;
grant select on table bjm_office_private.configuration to bjm_office_aggregate, supabase_auth_admin;
grant usage on schema bjm_office_private to supabase_auth_admin;
-- Intentionally NO INSERT: an empty/disabled configuration denies every request.
-- A separately reviewed configuration change supplies the verified owner,
-- predefined client, exact issuer/resource and enables the read boundary.

-- The applying role already has legitimate Auth SELECT/USAGE. Delegate only
-- this configured owner's live client sessions through a private, ordinary
-- security-barrier view; the aggregate role gets NO Auth schema/table grants.
create view bjm_office_private.live_owner_sessions
with (security_barrier=true, security_invoker=false) as
select s.id as session_id, s.user_id
from auth.sessions s
join auth.users u on u.id=s.user_id
join bjm_office_private.configuration cfg
  on cfg.singleton and cfg.enabled and cfg.owner_id=s.user_id and cfg.client_id=s.oauth_client_id
where (s.not_after is null or s.not_after > pg_catalog.now())
  and u.email_confirmed_at is not null and u.is_anonymous is false
  and u.deleted_at is null and (u.banned_until is null or u.banned_until <= pg_catalog.now());
revoke all on bjm_office_private.live_owner_sessions from public,anon,authenticated,service_role,bjm_office_reader;
grant select on bjm_office_private.live_owner_sessions to bjm_office_aggregate;
-- Pin the exact reviewed view created above, using this server's deparser with
-- an empty search_path. Only the trusted view owner can update the baseline.
-- A server upgrade that changes formatting intentionally requires re-review.
-- This detects drift; it does not defend against a malicious database admin.
do $$
declare prior_path text := pg_catalog.current_setting('search_path');
begin
  perform pg_catalog.set_config('search_path','',true);
  execute pg_catalog.format('comment on view bjm_office_private.live_owner_sessions is %L',
    'bjm-office-live-sessions-v1:' || pg_catalog.md5(pg_catalog.pg_get_viewdef('bjm_office_private.live_owner_sessions'::regclass,false)));
  perform pg_catalog.set_config('search_path',prior_path,true);
end $$;
grant select (role) on public.profiles to bjm_office_aggregate;
grant select (active) on public.jobs to bjm_office_aggregate;
grant select (id) on public.applications to bjm_office_aggregate;
grant select (status, cancel_at_period_end, complimentary_access) on public.cafe_subscriptions to bjm_office_aggregate;
grant select (status, created_at) on public.subscription_payments to bjm_office_aggregate;
grant select (status, created_at) on public.support_tickets to bjm_office_aggregate;
do $$ begin
  if exists (
    select 1 from (values
      ('public.profiles','role'),('public.jobs','active'),('public.applications','id'),
      ('public.cafe_subscriptions','status'),('public.cafe_subscriptions','cancel_at_period_end'),('public.cafe_subscriptions','complimentary_access'),
      ('public.subscription_payments','status'),('public.subscription_payments','created_at'),
      ('public.support_tickets','status'),('public.support_tickets','created_at')
    ) as required(relation_name,column_name)
    where not pg_catalog.has_column_privilege('bjm_office_aggregate',required.relation_name,required.column_name,'SELECT')
  ) then raise exception 'Office aggregate source-column SELECT delegation was not granted'; end if;
end $$;

create function bjm_office_private.context_valid()
returns boolean language plpgsql stable security invoker set search_path = '' as $$
declare
  claims jsonb;
  cfg bjm_office_private.configuration%rowtype;
  epoch_now bigint := extract(epoch from pg_catalog.now())::bigint;
begin
  claims := pg_catalog.current_setting('request.jwt.claims', true)::jsonb;
  select * into cfg from bjm_office_private.configuration where singleton and enabled;
  if cfg.owner_id is null or claims is null or
    claims->>'role' is distinct from 'bjm_office_reader' or
    claims->>'sub' is distinct from cfg.owner_id::text or
    claims->>'client_id' is distinct from cfg.client_id::text or
    claims->>'iss' is distinct from cfg.issuer or
    not coalesce((claims->'aud') = pg_catalog.to_jsonb(cfg.resource) or
         (pg_catalog.jsonb_typeof(claims->'aud') = 'array' and (claims->'aud') @> pg_catalog.jsonb_build_array(cfg.resource)), false) or
    not ('openid' = any (pg_catalog.regexp_split_to_array(coalesce(claims->>'scope',''), '\s+'))) or
    (claims->>'is_anonymous')::boolean is distinct from false or
    pg_catalog.jsonb_typeof(claims->'exp') is distinct from 'number' or
    pg_catalog.jsonb_typeof(claims->'iat') is distinct from 'number' or
    (claims ? 'nbf' and pg_catalog.jsonb_typeof(claims->'nbf') is distinct from 'number') or
    (claims->>'exp')::bigint <= epoch_now or
    (claims->>'iat')::bigint > epoch_now + 30 or
    (claims->>'exp')::bigint <= (claims->>'iat')::bigint or
    (claims->>'exp')::bigint - (claims->>'iat')::bigint > 3600 or
    (claims ? 'nbf' and (claims->>'nbf')::bigint > epoch_now + 30) or
    not (claims ?& array['exp','iat','session_id']) then return false; end if;
  return exists (
    select 1 from bjm_office_private.live_owner_sessions s
    where s.session_id = (claims->>'session_id')::uuid and s.user_id = cfg.owner_id
  );
exception when invalid_text_representation or numeric_value_out_of_range then return false;
end;
$$;
revoke all on function bjm_office_private.context_valid() from public, anon, authenticated, bjm_office_reader;

-- The function owner cannot bypass RLS or inherit customer grants. Its SELECT
-- policies apply only to these six sources and only to the exact verified context.
create policy office_aggregate_select on public.profiles for select to bjm_office_aggregate using (bjm_office_private.context_valid());
create policy office_aggregate_select on public.jobs for select to bjm_office_aggregate using (bjm_office_private.context_valid());
create policy office_aggregate_select on public.applications for select to bjm_office_aggregate using (bjm_office_private.context_valid());
create policy office_aggregate_select on public.cafe_subscriptions for select to bjm_office_aggregate using (bjm_office_private.context_valid());
create policy office_aggregate_select on public.subscription_payments for select to bjm_office_aggregate using (bjm_office_private.context_valid());
create policy office_aggregate_select on public.support_tickets for select to bjm_office_aggregate using (bjm_office_private.context_valid());

create function bjm_office_private.assert_isolated()
returns void language plpgsql stable security invoker set search_path = '' as $$
declare
  reader_oid oid := 'bjm_office_reader'::regrole;
  aggregate_oid oid := 'bjm_office_aggregate'::regrole;
  live_view pg_catalog.pg_class%rowtype;
  view_baseline text;
  auth_sessions_oid oid := (select c.oid from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace where n.nspname='auth' and c.relname='sessions');
  auth_users_oid oid := (select c.oid from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace where n.nspname='auth' and c.relname='users');
begin
  if current_user <> 'bjm_office_aggregate' or exists (
    select 1 from pg_catalog.pg_proc p where p.oid in (
      'bjm_office_private.read_snapshot()'::regprocedure,
      'bjm_office_private.context_valid()'::regprocedure,
      'bjm_office_private.assert_isolated()'::regprocedure)
      and (p.proowner <> 'bjm_office_aggregate'::regrole or
           p.proconfig is distinct from array['search_path=""'] or
           p.prosecdef is distinct from (p.oid='bjm_office_private.read_snapshot()'::regprocedure))
  ) then raise exception 'Office aggregate routine ownership or execution mode changed' using errcode='42501'; end if;
  if exists (select 1 from pg_catalog.pg_roles where rolname in ('bjm_office_reader','bjm_office_aggregate')
      and (rolsuper or rolcreaterole or rolcreatedb or rolcanlogin or rolreplication or rolbypassrls or rolinherit)) or
     exists (select 1 from pg_catalog.pg_auth_members where member in (reader_oid,'bjm_office_aggregate'::regrole)) then
    raise exception 'Office roles must be isolated NOLOGIN roles' using errcode = '42501';
  end if;
  if exists (
    select 1 from pg_catalog.pg_namespace n where n.nspname !~ '^pg_' and n.nspname <> 'information_schema'
      and (pg_catalog.has_schema_privilege(reader_oid,n.oid,'CREATE') or
           pg_catalog.has_schema_privilege('bjm_office_aggregate',n.oid,'CREATE'))
  ) then raise exception 'Office roles inherited schema CREATE privileges' using errcode='42501'; end if;
  -- Validate the delegated Auth view BEFORE context_valid reads it. Its owner
  -- must remain the trusted installer that owns this private schema/config.
  select * into live_view from pg_catalog.pg_class where oid='bjm_office_private.live_owner_sessions'::regclass;
  view_baseline := pg_catalog.obj_description(live_view.oid,'pg_class');
  if live_view.relkind <> 'v' or
     live_view.relowner <> (select nspowner from pg_catalog.pg_namespace where nspname='bjm_office_private') or
     live_view.relowner <> (select relowner from pg_catalog.pg_class where oid='bjm_office_private.configuration'::regclass) or
     live_view.relowner in (reader_oid,aggregate_oid) or
     live_view.reloptions is null or pg_catalog.cardinality(live_view.reloptions) <> 2 or
     not (live_view.reloptions @> array['security_barrier=true','security_invoker=false']) or
     view_baseline is null or view_baseline !~ '^bjm-office-live-sessions-v1:[0-9a-f]{32}$' or
     view_baseline <> 'bjm-office-live-sessions-v1:' || pg_catalog.md5(pg_catalog.pg_get_viewdef(live_view.oid,false)) then
    raise exception 'Office live-session view contract changed' using errcode='42501';
  end if;
  if (select pg_catalog.array_agg(attname::text order by attnum) from pg_catalog.pg_attribute
        where attrelid=live_view.oid and attnum>0 and not attisdropped) is distinct from array['session_id','user_id'] or
     exists (select 1 from pg_catalog.pg_attribute where attrelid=live_view.oid and attnum>0
        and (attisdropped or atttypid <> 'pg_catalog.uuid'::regtype or atttypmod <> -1)) or
     (select count(*) from pg_catalog.pg_rewrite where ev_class=live_view.oid) <> 1 or
     not exists (select 1 from pg_catalog.pg_rewrite where ev_class=live_view.oid and rulename='_RETURN' and ev_type='1' and is_instead) or
     exists (select 1 from pg_catalog.pg_trigger where tgrelid=live_view.oid) then
    raise exception 'Office live-session view projection or rules changed' using errcode='42501';
  end if;
  if auth_sessions_oid is null or auth_users_oid is null or exists (
    select 1 from pg_catalog.pg_depend d join pg_catalog.pg_rewrite r on r.oid=d.objid
    where d.classid='pg_catalog.pg_rewrite'::regclass and r.ev_class=live_view.oid
      and d.refclassid='pg_catalog.pg_class'::regclass
      and d.refobjid not in (live_view.oid,auth_sessions_oid,auth_users_oid,'bjm_office_private.configuration'::regclass)
  ) or (select count(distinct d.refobjid) from pg_catalog.pg_depend d join pg_catalog.pg_rewrite r on r.oid=d.objid
    where d.classid='pg_catalog.pg_rewrite'::regclass and r.ev_class=live_view.oid
      and d.refclassid='pg_catalog.pg_class'::regclass
      and d.refobjid in (auth_sessions_oid,auth_users_oid,'bjm_office_private.configuration'::regclass)) <> 3 then
    raise exception 'Office live-session view dependencies changed' using errcode='42501';
  end if;
  if not pg_catalog.has_table_privilege(aggregate_oid,live_view.oid,'SELECT') or
     exists (select 1 from pg_catalog.aclexplode(coalesce(live_view.relacl,pg_catalog.acldefault('r',live_view.relowner))) a
       where a.grantee <> live_view.relowner and (a.grantee <> aggregate_oid or a.privilege_type <> 'SELECT' or a.is_grantable)) or
     exists (select 1 from pg_catalog.pg_attribute c cross join lateral pg_catalog.aclexplode(c.attacl) a
       where c.attrelid=live_view.oid and a.grantee <> live_view.relowner
         and (a.grantee <> aggregate_oid or a.privilege_type <> 'SELECT' or a.is_grantable)) then
    raise exception 'Office live-session view grants changed' using errcode='42501';
  end if;
  if pg_catalog.has_schema_privilege(aggregate_oid,'auth','USAGE') or exists (
    select 1 from pg_catalog.pg_class c where c.oid in (auth_sessions_oid,auth_users_oid)
      and (pg_catalog.has_table_privilege(aggregate_oid,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') or
           pg_catalog.has_any_column_privilege(aggregate_oid,c.oid,'SELECT,INSERT,UPDATE,REFERENCES'))
  ) then raise exception 'Office aggregate must not have direct Auth privileges' using errcode='42501'; end if;
  if exists (select 1 from (values
      (auth_sessions_oid,'id'),(auth_sessions_oid,'user_id'),(auth_sessions_oid,'oauth_client_id'),(auth_sessions_oid,'not_after'),
      (auth_users_oid,'id'),(auth_users_oid,'email_confirmed_at'),(auth_users_oid,'is_anonymous'),(auth_users_oid,'deleted_at'),(auth_users_oid,'banned_until')
    ) as required(relation_oid,column_name)
    where not pg_catalog.has_column_privilege(live_view.relowner,required.relation_oid,required.column_name,'SELECT')) then
    raise exception 'Office live-session view owner Auth read privileges changed' using errcode='42501';
  end if;
  -- REVOKE FROM reader cannot override inherited PUBLIC permissions. Audit the
  -- effective privileges on every user schema, including Storage and GraphQL.
  if exists (
    select 1 from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace
    where n.nspname !~ '^pg_' and n.nspname <> 'information_schema'
      and case when c.relkind in ('r','p','v','m','f') then
        (pg_catalog.has_table_privilege(reader_oid,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') or
         pg_catalog.has_any_column_privilege(reader_oid,c.oid,'SELECT,INSERT,UPDATE,REFERENCES')) else false end
  ) or exists (
    select 1 from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace
    where n.nspname !~ '^pg_' and case when c.relkind='S'
      then pg_catalog.has_sequence_privilege(reader_oid,c.oid,'USAGE,SELECT,UPDATE') else false end
  ) then raise exception 'Office reader inherited table or sequence privileges' using errcode='42501'; end if;
  if exists (
    select 1 from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace
    where n.nspname !~ '^pg_' and n.nspname <> 'information_schema'
      and pg_catalog.has_schema_privilege(reader_oid,n.oid,'USAGE')
      and pg_catalog.has_function_privilege(reader_oid,p.oid,'EXECUTE')
      and p.prorettype not in ('pg_catalog.trigger'::regtype,'pg_catalog.event_trigger'::regtype)
      and p.oid not in ('public.office_read_snapshot()'::regprocedure,'bjm_office_private.read_snapshot()'::regprocedure)
      and not coalesce((
        n.nspname='public' and p.proname='profile_meets_visibility_requirements'
        and pg_catalog.pg_get_function_identity_arguments(p.oid)='p public.profiles'
        and p.prorettype='pg_catalog.bool'::regtype and not p.prosecdef and p.provolatile='i'
        and p.prolang=(select oid from pg_catalog.pg_language where lanname='sql')
        and p.proconfig=array['search_path=""']
        and pg_catalog.md5(p.prosrc)='b9f07ff05df2af5ff6c3552f382a7565'
      ),false)
  ) then raise exception 'Office reader can execute an unreviewed routine through PUBLIC grants' using errcode='42501'; end if;
  if exists (
    select 1 from pg_catalog.pg_class c where c.oid = any(array[
      'public.profiles'::regclass,'public.jobs'::regclass,'public.applications'::regclass,
      'public.cafe_subscriptions'::regclass,'public.subscription_payments'::regclass,'public.support_tickets'::regclass])
      and (not c.relrowsecurity or c.relowner = 'bjm_office_aggregate'::regrole)
  ) then raise exception 'Aggregate sources must retain independent ownership and RLS' using errcode='42501'; end if;
  if exists (
    select 1 from pg_catalog.pg_policy p where p.polrelid = any(array[
      'public.profiles'::regclass,'public.jobs'::regclass,'public.applications'::regclass,
      'public.cafe_subscriptions'::regclass,'public.subscription_payments'::regclass,'public.support_tickets'::regclass])
      and not p.polpermissive and p.polcmd in ('r','*')
      and (0::oid = any(p.polroles) or 'bjm_office_aggregate'::regrole = any(p.polroles))
  ) then raise exception 'Unreviewed restrictive RLS could silently truncate aggregates' using errcode='42501'; end if;
end;
$$;
revoke all on function bjm_office_private.assert_isolated() from public, anon, authenticated, bjm_office_reader;

create function bjm_office_private.read_snapshot()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  metrics jsonb := '{"profiles":null,"cafes":null,"baristas":null,"jobs":null,"applications":null,"subscriptions":null,"payments":null}'::jsonb;
  support jsonb := '{"total_recent":null,"open":null}'::jsonb;
  subscriptions jsonb := '{"total":null,"active":null,"past_due":null,"canceling":null}'::jsonb;
  payments jsonb := '{"recent":null,"failed":null,"refunded":null}'::jsonb;
  fragment jsonb;
  total bigint;
begin
  perform bjm_office_private.assert_isolated();
  if not bjm_office_private.context_valid() then raise exception 'Office access denied' using errcode='42501'; end if;
  begin
    select pg_catalog.jsonb_build_object('profiles',count(*),'cafes',count(*) filter(where role='cafe_owner_manager'),
      'baristas',count(*) filter(where role='barista')) into fragment from public.profiles;
    metrics := metrics || fragment;
  exception when undefined_table or undefined_column or insufficient_privilege then null; end;
  begin
    select count(*) into total from public.jobs;
    metrics := metrics || pg_catalog.jsonb_build_object('jobs',total);
  exception when undefined_table or undefined_column or insufficient_privilege then null; end;
  begin
    select count(*) into total from public.applications;
    metrics := metrics || pg_catalog.jsonb_build_object('applications',total);
  exception when undefined_table or undefined_column or insufficient_privilege then null; end;
  begin
    select pg_catalog.jsonb_build_object('total',count(*),'active',count(*) filter(where status='active'),
      'past_due',count(*) filter(where status in ('past_due','unpaid','incomplete')),
      'canceling',count(*) filter(where cancel_at_period_end)) into subscriptions from public.cafe_subscriptions;
    metrics := metrics || pg_catalog.jsonb_build_object('subscriptions',subscriptions->'total');
  exception when undefined_table or undefined_column or insufficient_privilege then null; end;
  begin
    select count(*) into total from public.subscription_payments;
    metrics := metrics || pg_catalog.jsonb_build_object('payments',total);
    select pg_catalog.jsonb_build_object('recent',count(*),'failed',count(*) filter(where status='failed'),
      'refunded',count(*) filter(where status='refunded')) into payments
      from public.subscription_payments where created_at >= pg_catalog.now() - interval '30 days';
  exception when undefined_table or undefined_column or insufficient_privilege then null; end;
  begin
    select pg_catalog.jsonb_build_object('total_recent',count(*),
      'open',count(*) filter(where status not in ('resolved','fixed','closed') or status is null)) into support
      from public.support_tickets where created_at >= pg_catalog.now() - interval '30 days';
  exception when undefined_table or undefined_column or insufficient_privilege then null; end;
  return pg_catalog.jsonb_build_object('schema_version',1,'generated_at',pg_catalog.now(),'metrics',metrics,'support',support,
    'billing',pg_catalog.jsonb_build_object('subscriptions',subscriptions,'payments',payments));
end;
$$;
revoke all on function bjm_office_private.read_snapshot() from public, anon, authenticated;

create function public.office_read_snapshot()
returns jsonb language sql stable security invoker set search_path = '' as $$
  select bjm_office_private.read_snapshot();
$$;
revoke all on function public.office_read_snapshot() from public, anon, authenticated;
grant execute on function public.office_read_snapshot(), bjm_office_private.read_snapshot() to bjm_office_reader;

-- The private definer has only approved SELECT columns and no BYPASSRLS.
-- Grant CREATE only while transferring function ownership, then remove it.
grant create on schema bjm_office_private to bjm_office_aggregate;
alter function bjm_office_private.context_valid() owner to bjm_office_aggregate;
alter function bjm_office_private.assert_isolated() owner to bjm_office_aggregate;
alter function bjm_office_private.read_snapshot() owner to bjm_office_aggregate;
revoke create on schema bjm_office_private from bjm_office_aggregate;

-- Prepare, but DO NOT configure globally or replace any existing token hook.
-- Integrate this exact-client branch into the existing hook after reviewing it.
create function bjm_office_private.office_access_token_hook(event jsonb)
returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare claims jsonb := event->'claims'; cfg bjm_office_private.configuration%rowtype;
begin
  select * into cfg from bjm_office_private.configuration where singleton;
  if cfg.client_id is not null and claims->>'client_id' = cfg.client_id::text then
    -- Every token for this client gets the restricted role, including nonowners.
    -- Owner/session checks remain independent in Office and the aggregate RPC.
    claims := pg_catalog.jsonb_set(claims,'{role}','"bjm_office_reader"'::jsonb);
    claims := pg_catalog.jsonb_set(claims,'{aud}',pg_catalog.to_jsonb(cfg.resource));
    return pg_catalog.jsonb_set(event,'{claims}',claims);
  end if;
  return event; -- Preserve all customer sessions and other OAuth clients exactly.
end;
$$;
revoke all on function bjm_office_private.office_access_token_hook(jsonb) from public, anon, authenticated, bjm_office_reader;
grant execute on function bjm_office_private.office_access_token_hook(jsonb) to supabase_auth_admin;

-- Fail the whole transaction if inherited PUBLIC access would defeat isolation.
-- The sole legacy allowlist is the exact audited immutable invoker profile
-- predicate fingerprint above. It reads caller-supplied fields, not tables.
-- Any different body, language, volatility, signature, security mode, or
-- search_path is rejected. No shared customer grants are changed. Every aggregate
-- call repeats the check and refuses unsafe drift. Maintain this grant invariant
-- in all future migrations: a new PUBLIC definer grant could independently expose
-- another Data API endpoint before this aggregate check is reached.
set local role bjm_office_aggregate;
select bjm_office_private.assert_isolated();
-- Prove the ordinary view can resolve its owner-authorized Auth lookup even
-- while configuration is empty, without giving the aggregate Auth privileges.
do $$ begin perform 1 from bjm_office_private.live_owner_sessions limit 1; end $$;
reset role;
do $$
declare
  saved jsonb := pg_catalog.current_setting('bjm_office.install_membership')::jsonb;
  installer text := current_user;
  installer_oid oid := (select oid from pg_catalog.pg_roles where rolname=current_user);
  restored jsonb;
begin
  if saved->>'installer' is distinct from installer then
    raise exception 'Office installer role changed unexpectedly';
  end if;
  if (saved->>'changed')::boolean then
    if saved->'prior' = 'null'::jsonb then
      execute pg_catalog.format('revoke bjm_office_aggregate from %I granted by %I',installer,installer);
    else
      execute pg_catalog.format('grant bjm_office_aggregate to %I with set %s granted by %I',
        installer,case when (saved#>>'{prior,set}')::boolean then 'true' else 'false' end,installer);
    end if;
  end if;
  select pg_catalog.jsonb_build_object('set',m.set_option,'inherit',m.inherit_option,'admin',m.admin_option)
    into restored from pg_catalog.pg_auth_members m
    where m.roleid='bjm_office_aggregate'::regrole and m.member=installer_oid and m.grantor=installer_oid;
  if pg_catalog.to_jsonb(restored) is distinct from nullif(saved->'prior','null'::jsonb) then
    raise exception 'Office installer membership was not restored';
  end if;
end $$;
grant bjm_office_reader to authenticator;
commit;
