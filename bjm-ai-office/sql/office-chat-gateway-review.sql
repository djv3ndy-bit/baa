-- UNAPPLIED REVIEW PACKAGE. Validate locally before separately approved setup.
-- No password, owner ID, OAuth client, callback or resource is embedded.
-- The gateway role stays NOLOGIN; configuration stays empty and disabled.
-- This package leaves the legacy owner-JWT package and customer grants intact.
-- Office tokens authorize only reports. Their hashes are not Supabase tokens.
begin;
do $$ begin
  if current_user <> session_user then raise exception 'Gateway installation requires the authenticated migration session role'; end if;
  if pg_catalog.current_setting('server_version_num')::integer < 160000 then raise exception 'Gateway installation requires PostgreSQL 16+'; end if;
end $$;
create role bjm_office_gateway_login nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
create role bjm_office_chat_issuer nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
create role bjm_office_chat_aggregate nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
-- Preserve each creator-side relationship, temporarily adding only SET for
-- ownership transfers. Restore the exact prior row before committing.
do $$
declare target text; installer text := current_user; prior jsonb; saved jsonb := '{}'::jsonb; changed boolean;
begin
  foreach target in array array['bjm_office_chat_issuer','bjm_office_chat_aggregate'] loop
    select pg_catalog.jsonb_build_object('set',m.set_option,'inherit',m.inherit_option,'admin',m.admin_option) into prior
      from pg_catalog.pg_auth_members m where m.roleid=target::regrole and m.member=installer::regrole and m.grantor=installer::regrole;
    changed := not pg_catalog.pg_has_role(installer,target,'SET');
    saved := saved || pg_catalog.jsonb_build_object(target,pg_catalog.jsonb_build_object('prior',prior,'changed',changed));
    if changed then
      if prior is null then execute pg_catalog.format('grant %I to %I with set true, inherit false, admin false granted by %I',target,installer,installer);
      else execute pg_catalog.format('grant %I to %I with set true granted by %I',target,installer,installer); end if;
    end if;
  end loop;
  perform pg_catalog.set_config('bjm_office_gateway.install_memberships',saved::text,true);
end $$;

create schema bjm_office_gateway;
revoke all on schema bjm_office_gateway from public,anon,authenticated,service_role;
grant usage on schema bjm_office_gateway to bjm_office_gateway_login,bjm_office_chat_issuer,bjm_office_chat_aggregate;
grant usage on schema public to bjm_office_chat_aggregate;
create table bjm_office_gateway.configuration (
  singleton boolean primary key default true check(singleton),
  owner_id uuid not null check(owner_id <> '00000000-0000-0000-0000-000000000000'),
  upstream_client_id uuid not null check(upstream_client_id <> '00000000-0000-0000-0000-000000000000'),
  chatgpt_client_id text not null check(length(chatgpt_client_id) between 1 and 200),
  redirect_uri text not null check(redirect_uri='https://chatgpt.com/connector_platform_oauth_redirect' or redirect_uri ~ '^https://chatgpt\.com/connector/oauth/[A-Za-z0-9_-]+$'),
  resource text not null check(resource ~ '^https://[^/?#]+/mcp$'),
  enabled boolean not null default false
);
create table bjm_office_gateway.flows (
  flow_hash text primary key check(flow_hash ~ '^[0-9a-f]{64}$'),
  encrypted_payload text not null check(octet_length(encrypted_payload) between 1 and 65536),
  expires_at timestamptz not null
);
create table bjm_office_gateway.codes (
  code_hash text primary key check(code_hash ~ '^[0-9a-f]{64}$'),
  owner_id uuid not null,client_id text not null,redirect_uri text not null,
  challenge text not null check(challenge ~ '^[A-Za-z0-9_-]{43}$'),resource text not null,
  consent_version text not null check(consent_version ~ '^[0-9a-f]{32}$'),expires_at timestamptz not null
);
create table bjm_office_gateway.grants (
  id uuid primary key default pg_catalog.gen_random_uuid(),owner_id uuid not null,client_id text not null,resource text not null,
  consent_version text not null check(consent_version ~ '^[0-9a-f]{32}$'),refresh_expires_at timestamptz not null,revoked_at timestamptz
);
create table bjm_office_gateway.tokens (
  token_hash text primary key check(token_hash ~ '^[0-9a-f]{64}$'),kind text not null check(kind in ('access','refresh')),
  grant_id uuid not null references bjm_office_gateway.grants(id) on delete cascade,
  expires_at timestamptz not null,used_at timestamptz,revoked_at timestamptz
);
create index on bjm_office_gateway.tokens(grant_id);
create index on bjm_office_gateway.flows(expires_at);
create index on bjm_office_gateway.codes(expires_at);
create index on bjm_office_gateway.grants(refresh_expires_at);
alter table bjm_office_gateway.configuration enable row level security;
alter table bjm_office_gateway.flows enable row level security;
alter table bjm_office_gateway.codes enable row level security;
alter table bjm_office_gateway.grants enable row level security;
alter table bjm_office_gateway.tokens enable row level security;
revoke all on all tables in schema bjm_office_gateway from public,anon,authenticated,service_role,bjm_office_gateway_login;
grant select on bjm_office_gateway.configuration to bjm_office_chat_issuer,bjm_office_chat_aggregate;
create policy gateway_configuration_read on bjm_office_gateway.configuration for select to bjm_office_chat_issuer,bjm_office_chat_aggregate using(true);
-- The existing migration administrator delegates only the configured active
-- owner's UUID + consent-generation digest, only while that owner's exact
-- upstream consent is active. No new role has direct Auth privileges. Epoch
-- formatting is timezone independent; this is a version, not a bearer secret.
create view bjm_office_gateway.active_owner with(security_barrier=true,security_invoker=false) as
select cfg.owner_id,pg_catalog.md5(c.id::text||':'||extract(epoch from c.granted_at)::text) as consent_version
from bjm_office_gateway.configuration cfg join auth.users u on u.id=cfg.owner_id
join auth.oauth_consents c on c.user_id=cfg.owner_id and c.client_id=cfg.upstream_client_id and c.revoked_at is null
where cfg.singleton and u.email_confirmed_at is not null and u.is_anonymous is false
  and u.deleted_at is null and (u.banned_until is null or u.banned_until <= pg_catalog.now());
revoke all on bjm_office_gateway.active_owner from public,anon,authenticated,service_role,bjm_office_gateway_login;
grant select on bjm_office_gateway.active_owner to bjm_office_chat_issuer,bjm_office_chat_aggregate;
do $$ declare prior_path text := pg_catalog.current_setting('search_path'); begin
  perform pg_catalog.set_config('search_path','',true);
  execute pg_catalog.format('comment on view bjm_office_gateway.active_owner is %L',
    'bjm-office-active-owner-v1:' || pg_catalog.md5(pg_catalog.pg_get_viewdef('bjm_office_gateway.active_owner'::regclass,false)));
  perform pg_catalog.set_config('search_path',prior_path,true);
end $$;
grant select on bjm_office_gateway.grants,bjm_office_gateway.tokens to bjm_office_chat_aggregate;
create policy gateway_grants_read on bjm_office_gateway.grants for select to bjm_office_chat_aggregate using(true);
create policy gateway_tokens_read on bjm_office_gateway.tokens for select to bjm_office_chat_aggregate using(true);
-- Pin private state structure before ownership transfer. Besides columns and
-- constraints, indexes/defaults/policies can invoke stored expressions. The
-- trusted baseline deliberately fails closed on later DDL/formatter drift.
do $$ declare rel record; fingerprint text; prior_path text:=pg_catalog.current_setting('search_path'); begin
  perform pg_catalog.set_config('search_path','',true);
  for rel in select c.oid from pg_catalog.pg_class c where c.relnamespace='bjm_office_gateway'::regnamespace and c.relkind='r' loop
    select pg_catalog.md5(pg_catalog.jsonb_build_object(
      'columns',(select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(a.attname,a.atttypid,a.atttypmod,a.attnotnull,a.attidentity,a.attgenerated,pg_catalog.pg_get_expr(d.adbin,d.adrelid)) order by a.attnum)
        from pg_catalog.pg_attribute a left join pg_catalog.pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum where a.attrelid=rel.oid and a.attnum>0 and not a.attisdropped),
      'constraints',(select pg_catalog.jsonb_agg(pg_catalog.pg_get_constraintdef(oid,false) order by conname) from pg_catalog.pg_constraint where conrelid=rel.oid),
      'indexes',(select pg_catalog.jsonb_agg(pg_catalog.pg_get_indexdef(indexrelid,0,false) order by indexrelid) from pg_catalog.pg_index where indrelid=rel.oid),
      'policies',(select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(polname,polcmd,polpermissive,polroles,pg_catalog.pg_get_expr(polqual,polrelid),pg_catalog.pg_get_expr(polwithcheck,polrelid)) order by polname) from pg_catalog.pg_policy where polrelid=rel.oid)
    )::text) into fingerprint;
    execute pg_catalog.format('comment on table %s is %L',rel.oid::regclass,'bjm-office-gateway-table-v1:'||fingerprint);
  end loop;
  perform pg_catalog.set_config('search_path',prior_path,true);
end $$;
-- Grant policies/reads while the applying role still owns these tables, then
-- transfer only Office-local state to the isolated NOLOGIN issuer.
grant create on schema bjm_office_gateway to bjm_office_chat_issuer;
alter table bjm_office_gateway.flows owner to bjm_office_chat_issuer;
alter table bjm_office_gateway.codes owner to bjm_office_chat_issuer;
alter table bjm_office_gateway.grants owner to bjm_office_chat_issuer;
alter table bjm_office_gateway.tokens owner to bjm_office_chat_issuer;
revoke create on schema bjm_office_gateway from bjm_office_chat_issuer;
grant select(role) on public.profiles to bjm_office_chat_aggregate;
grant select(active) on public.jobs to bjm_office_chat_aggregate;
grant select(id) on public.applications to bjm_office_chat_aggregate;
grant select(status,cancel_at_period_end,complimentary_access) on public.cafe_subscriptions to bjm_office_chat_aggregate;
grant select(status,created_at) on public.subscription_payments,public.support_tickets to bjm_office_chat_aggregate;

create function bjm_office_gateway.context_valid()
returns boolean language plpgsql stable security invoker set search_path='' as $$
declare h text := pg_catalog.current_setting('bjm_office_gateway.access_hash',true);
  client text := pg_catalog.current_setting('bjm_office_gateway.client_id',true);
  res text := pg_catalog.current_setting('bjm_office_gateway.resource',true);
begin
  return exists(select 1 from bjm_office_gateway.tokens t join bjm_office_gateway.grants g on g.id=t.grant_id
    join bjm_office_gateway.configuration cfg on cfg.singleton and cfg.enabled and cfg.owner_id=g.owner_id
      and cfg.chatgpt_client_id=g.client_id and cfg.resource=g.resource
    join bjm_office_gateway.active_owner o on o.owner_id=cfg.owner_id and o.consent_version=g.consent_version
    where t.token_hash=h and t.kind='access' and t.used_at is null and t.revoked_at is null and t.expires_at>pg_catalog.now()
      and g.revoked_at is null and g.refresh_expires_at>pg_catalog.now() and g.client_id=client and g.resource=res);
end $$;
revoke all on function bjm_office_gateway.context_valid() from public,anon,authenticated,service_role,bjm_office_gateway_login;
create policy gateway_aggregate_select on public.profiles for select to bjm_office_chat_aggregate using(bjm_office_gateway.context_valid());
create policy gateway_aggregate_select on public.jobs for select to bjm_office_chat_aggregate using(bjm_office_gateway.context_valid());
create policy gateway_aggregate_select on public.applications for select to bjm_office_chat_aggregate using(bjm_office_gateway.context_valid());
create policy gateway_aggregate_select on public.cafe_subscriptions for select to bjm_office_chat_aggregate using(bjm_office_gateway.context_valid());
create policy gateway_aggregate_select on public.subscription_payments for select to bjm_office_chat_aggregate using(bjm_office_gateway.context_valid());
create policy gateway_aggregate_select on public.support_tickets for select to bjm_office_chat_aggregate using(bjm_office_gateway.context_valid());

-- Runtime drift/privilege checks are defined below before either public-to-the-
-- gateway entrypoint is granted. A failed installation rolls everything back.
create function bjm_office_gateway.assert_isolated()
returns void language plpgsql stable security invoker set search_path='' as $$
#variable_conflict use_column
declare r record; c record; a record; f record; expected_owner oid; table_fingerprint text;
  login_oid oid := 'bjm_office_gateway_login'::regrole;
  issuer_oid oid := 'bjm_office_chat_issuer'::regrole;
  aggregate_oid oid := 'bjm_office_chat_aggregate'::regrole;
  auth_user_oid oid := (select pc.oid from pg_catalog.pg_class pc join pg_catalog.pg_namespace pn on pn.oid=pc.relnamespace where pn.nspname='auth' and pc.relname='users');
  auth_consent_oid oid := (select pc.oid from pg_catalog.pg_class pc join pg_catalog.pg_namespace pn on pn.oid=pc.relnamespace where pn.nspname='auth' and pc.relname='oauth_consents');
  view_row pg_catalog.pg_class%rowtype; baseline text;
  allowed_read boolean; allowed_write boolean;
begin
  if current_user not in ('bjm_office_chat_issuer','bjm_office_chat_aggregate') then raise exception 'Gateway audit execution role changed' using errcode='42501'; end if;
  for r in select * from pg_catalog.pg_roles where oid in(login_oid,issuer_oid,aggregate_oid) loop
    if r.rolsuper or r.rolinherit or r.rolcreaterole or r.rolcreatedb or r.rolbypassrls or r.rolreplication or
      (r.oid<>login_oid and r.rolcanlogin) or exists(select 1 from pg_catalog.pg_auth_members where member=r.oid) then
      raise exception 'Gateway role isolation changed' using errcode='42501'; end if;
    if pg_catalog.has_database_privilege(r.oid,pg_catalog.current_database(),'CREATE') or exists(
      select 1 from pg_catalog.pg_namespace n where n.nspname !~ '^pg_' and n.nspname<>'information_schema'
        and pg_catalog.has_schema_privilege(r.oid,n.oid,'CREATE')) then raise exception 'Gateway inherited database or schema CREATE' using errcode='42501'; end if;
    if pg_catalog.has_schema_privilege(r.oid,'auth','USAGE') then raise exception 'Gateway must not have direct Auth privileges' using errcode='42501'; end if;
    for c in select c.*,n.nspname from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace
      where n.nspname !~ '^pg_' and n.nspname<>'information_schema' and c.relkind in('r','p','v','m','f','S') loop
      if c.relkind='S' then
        if pg_catalog.has_sequence_privilege(r.oid,c.oid,'USAGE,SELECT,UPDATE') then raise exception 'Gateway inherited sequence privileges' using errcode='42501'; end if;
        continue;
      end if;
      -- Even unreachable Auth table grants are forbidden; ordinary metadata
      -- PUBLIC grants in other inaccessible schemas are left untouched.
      if c.nspname='auth' and (pg_catalog.has_table_privilege(r.oid,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') or
        pg_catalog.has_any_column_privilege(r.oid,c.oid,'SELECT,INSERT,UPDATE,REFERENCES')) then raise exception 'Gateway must not have direct Auth privileges' using errcode='42501'; end if;
      if not pg_catalog.has_schema_privilege(r.oid,c.relnamespace,'USAGE') then continue; end if;
      allowed_write := r.oid=issuer_oid and c.nspname='bjm_office_gateway' and c.relname in('flows','codes','grants','tokens') and c.relowner=issuer_oid;
      allowed_read := allowed_write or (r.oid in(issuer_oid,aggregate_oid) and c.nspname='bjm_office_gateway' and c.relname in('configuration','active_owner')) or
        (r.oid=aggregate_oid and c.nspname='bjm_office_gateway' and c.relname in('grants','tokens'));
      if not allowed_write and (pg_catalog.has_table_privilege(r.oid,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') or
        pg_catalog.has_any_column_privilege(r.oid,c.oid,'INSERT,UPDATE,REFERENCES')) then raise exception 'Gateway inherited write privileges' using errcode='42501'; end if;
      if not allowed_read and pg_catalog.has_table_privilege(r.oid,c.oid,'SELECT') then raise exception 'Gateway inherited raw table privileges' using errcode='42501'; end if;
      if not allowed_read then
        for a in select attname from pg_catalog.pg_attribute where attrelid=c.oid and attnum>0 and not attisdropped
          and pg_catalog.has_column_privilege(r.oid,c.oid,attnum,'SELECT') loop
          if not (r.oid=aggregate_oid and c.nspname='public' and (
            (c.relname='profiles' and a.attname='role') or (c.relname='jobs' and a.attname='active') or
            (c.relname='applications' and a.attname='id') or
            (c.relname='cafe_subscriptions' and a.attname in('status','cancel_at_period_end','complimentary_access')) or
            (c.relname in('subscription_payments','support_tickets') and a.attname in('status','created_at')))) then
            raise exception 'Gateway inherited raw column privileges' using errcode='42501'; end if;
        end loop;
      end if;
    end loop;
    for f in select p.*,n.nspname from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace
      where n.nspname !~ '^pg_' and n.nspname<>'information_schema'
      and pg_catalog.has_schema_privilege(r.oid,n.oid,'USAGE') and pg_catalog.has_function_privilege(r.oid,p.oid,'EXECUTE')
      and p.prorettype not in('pg_catalog.trigger'::regtype,'pg_catalog.event_trigger'::regtype) loop
      if f.nspname='bjm_office_gateway' and (
        (r.oid=login_oid and f.oid in('bjm_office_gateway.auth_dispatch(text,jsonb)'::regprocedure,'bjm_office_gateway.read_snapshot(text,text,text)'::regprocedure)) or
        (r.oid=issuer_oid and f.oid in('bjm_office_gateway.auth_dispatch(text,jsonb)'::regprocedure,'bjm_office_gateway.assert_isolated()'::regprocedure)) or
        (r.oid=aggregate_oid and f.oid in('bjm_office_gateway.read_snapshot(text,text,text)'::regprocedure,'bjm_office_gateway.context_valid()'::regprocedure,'bjm_office_gateway.assert_isolated()'::regprocedure))) then continue; end if;
      if coalesce(f.nspname='public' and f.proname='profile_meets_visibility_requirements' and
        pg_catalog.pg_get_function_identity_arguments(f.oid)='p public.profiles' and f.prorettype='pg_catalog.bool'::regtype and
        not f.prosecdef and f.provolatile='i' and f.prolang=(select oid from pg_catalog.pg_language where lanname='sql') and
        f.proconfig=array['search_path=""'] and pg_catalog.md5(f.prosrc)='b9f07ff05df2af5ff6c3552f382a7565',false) then continue; end if;
      raise exception 'Gateway can execute an unreviewed routine' using errcode='42501';
    end loop;
  end loop;
  if exists(select 1 from pg_catalog.pg_namespace n cross join lateral pg_catalog.aclexplode(coalesce(n.nspacl,pg_catalog.acldefault('n',n.nspowner))) a
    where n.nspname='bjm_office_gateway' and a.grantee<>n.nspowner and
      (a.grantee not in(login_oid,issuer_oid,aggregate_oid) or a.privilege_type<>'USAGE' or a.is_grantable)) then
    raise exception 'Gateway private schema grants changed' using errcode='42501'; end if;
  -- Entry points must retain the reviewed restricted owner, execution mode,
  -- language and empty search_path. The baseline detects ordinary DDL drift;
  -- a malicious database administrator can change the audit itself as well.
  for f in select * from pg_catalog.pg_proc where oid in('bjm_office_gateway.auth_dispatch(text,jsonb)'::regprocedure,
    'bjm_office_gateway.read_snapshot(text,text,text)'::regprocedure,'bjm_office_gateway.context_valid()'::regprocedure,
    'bjm_office_gateway.assert_isolated()'::regprocedure) loop
    expected_owner := case when f.oid in('bjm_office_gateway.read_snapshot(text,text,text)'::regprocedure,'bjm_office_gateway.context_valid()'::regprocedure) then aggregate_oid else issuer_oid end;
    baseline := pg_catalog.obj_description(f.oid,'pg_proc');
    if f.proowner<>expected_owner or f.proconfig is distinct from array['search_path=""'] or
      f.prolang<>(select oid from pg_catalog.pg_language where lanname='plpgsql') or
      f.prosecdef is distinct from (f.oid in('bjm_office_gateway.auth_dispatch(text,jsonb)'::regprocedure,'bjm_office_gateway.read_snapshot(text,text,text)'::regprocedure)) or
      baseline is null or baseline !~ '^bjm-office-gateway-routine-v1:[0-9a-f]{32}$' or
      baseline <> 'bjm-office-gateway-routine-v1:' || pg_catalog.md5(f.prosrc) then raise exception 'Gateway routine contract changed' using errcode='42501'; end if;
    if exists(select 1 from pg_catalog.aclexplode(coalesce(f.proacl,pg_catalog.acldefault('f',f.proowner))) a where a.grantee<>f.proowner and
      not(a.privilege_type='EXECUTE' and not a.is_grantable and (
        (f.oid in('bjm_office_gateway.auth_dispatch(text,jsonb)'::regprocedure,'bjm_office_gateway.read_snapshot(text,text,text)'::regprocedure) and a.grantee=login_oid) or
        (f.oid='bjm_office_gateway.assert_isolated()'::regprocedure and a.grantee=aggregate_oid)))) then
      raise exception 'Gateway routine grants changed' using errcode='42501'; end if;
  end loop;
  select * into view_row from pg_catalog.pg_class where oid='bjm_office_gateway.active_owner'::regclass;
  baseline := pg_catalog.obj_description(view_row.oid,'pg_class');
  if view_row.relkind<>'v' or view_row.relowner<>(select nspowner from pg_catalog.pg_namespace where nspname='bjm_office_gateway') or
    view_row.relowner<>(select relowner from pg_catalog.pg_class where oid='bjm_office_gateway.configuration'::regclass) or
    view_row.relowner in(login_oid,issuer_oid,aggregate_oid) or view_row.reloptions is null or pg_catalog.cardinality(view_row.reloptions)<>2 or
    not(view_row.reloptions @> array['security_barrier=true','security_invoker=false']) or
    baseline is null or baseline !~ '^bjm-office-active-owner-v1:[0-9a-f]{32}$' or
    baseline <> 'bjm-office-active-owner-v1:' || pg_catalog.md5(pg_catalog.pg_get_viewdef(view_row.oid,false)) then
    raise exception 'Gateway active-owner view contract changed' using errcode='42501'; end if;
  if (select pg_catalog.array_agg(attname::text order by attnum) from pg_catalog.pg_attribute where attrelid=view_row.oid and attnum>0 and not attisdropped) is distinct from array['owner_id','consent_version'] or
    (select pg_catalog.array_agg(atttypid order by attnum) from pg_catalog.pg_attribute where attrelid=view_row.oid and attnum>0 and not attisdropped) is distinct from array['pg_catalog.uuid'::regtype::oid,'pg_catalog.text'::regtype::oid] or
    exists(select 1 from pg_catalog.pg_attribute where attrelid=view_row.oid and attnum>0 and (attisdropped or atttypmod<>-1)) or
    (select count(*) from pg_catalog.pg_rewrite where ev_class=view_row.oid)<>1 or
    exists(select 1 from pg_catalog.pg_trigger where tgrelid=view_row.oid) then raise exception 'Gateway active-owner view projection changed' using errcode='42501'; end if;
  if auth_user_oid is null or auth_consent_oid is null or exists(select 1 from pg_catalog.pg_depend d join pg_catalog.pg_rewrite rw on rw.oid=d.objid
    where d.classid='pg_catalog.pg_rewrite'::regclass and rw.ev_class=view_row.oid and d.refclassid='pg_catalog.pg_class'::regclass
    and d.refobjid not in(view_row.oid,auth_user_oid,auth_consent_oid,'bjm_office_gateway.configuration'::regclass)) or
    (select count(distinct d.refobjid) from pg_catalog.pg_depend d join pg_catalog.pg_rewrite rw on rw.oid=d.objid
    where d.classid='pg_catalog.pg_rewrite'::regclass and rw.ev_class=view_row.oid and d.refclassid='pg_catalog.pg_class'::regclass
    and d.refobjid in(auth_user_oid,auth_consent_oid,'bjm_office_gateway.configuration'::regclass))<>3 then
    raise exception 'Gateway active-owner view dependencies changed' using errcode='42501'; end if;
  if exists(select 1 from(values(auth_user_oid,'id'),(auth_user_oid,'email_confirmed_at'),(auth_user_oid,'is_anonymous'),(auth_user_oid,'deleted_at'),(auth_user_oid,'banned_until'),
    (auth_consent_oid,'user_id'),(auth_consent_oid,'client_id'),(auth_consent_oid,'revoked_at'),(auth_consent_oid,'id'),(auth_consent_oid,'granted_at')) required(rel,col)
    where not pg_catalog.has_column_privilege(view_row.relowner,required.rel,required.col,'SELECT')) then raise exception 'Gateway active-owner view owner lacks Auth reads' using errcode='42501'; end if;
  -- No private relation or column grant may expose ciphertext, code/token
  -- hashes, or configured identities to reader/customer/PUBLIC/other roles.
  for c in select c.* from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace
    where n.nspname='bjm_office_gateway' and c.relkind in('r','v') loop
    if c.relname in('flows','codes','grants','tokens') and c.relowner<>issuer_oid then raise exception 'Gateway state ownership changed' using errcode='42501'; end if;
    if c.relname not in('flows','codes','grants','tokens','configuration','active_owner') then raise exception 'Gateway private relation contract changed' using errcode='42501'; end if;
    if c.relkind='r' then
      select pg_catalog.md5(pg_catalog.jsonb_build_object(
        'columns',(select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(at.attname,at.atttypid,at.atttypmod,at.attnotnull,at.attidentity,at.attgenerated,pg_catalog.pg_get_expr(d.adbin,d.adrelid)) order by at.attnum)
          from pg_catalog.pg_attribute at left join pg_catalog.pg_attrdef d on d.adrelid=at.attrelid and d.adnum=at.attnum where at.attrelid=c.oid and at.attnum>0 and not at.attisdropped),
        'constraints',(select pg_catalog.jsonb_agg(pg_catalog.pg_get_constraintdef(oid,false) order by conname) from pg_catalog.pg_constraint where conrelid=c.oid),
        'indexes',(select pg_catalog.jsonb_agg(pg_catalog.pg_get_indexdef(indexrelid,0,false) order by indexrelid) from pg_catalog.pg_index where indrelid=c.oid),
        'policies',(select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(polname,polcmd,polpermissive,polroles,pg_catalog.pg_get_expr(polqual,polrelid),pg_catalog.pg_get_expr(polwithcheck,polrelid)) order by polname) from pg_catalog.pg_policy where polrelid=c.oid)
      )::text) into table_fingerprint;
      baseline:=pg_catalog.obj_description(c.oid,'pg_class');
      if not c.relrowsecurity or baseline is null or baseline !~ '^bjm-office-gateway-table-v1:[0-9a-f]{32}$' or
        baseline<>'bjm-office-gateway-table-v1:'||table_fingerprint or
        exists(select 1 from pg_catalog.pg_trigger where tgrelid=c.oid and not tgisinternal) or
        exists(select 1 from pg_catalog.pg_rewrite where ev_class=c.oid) or
        exists(select 1 from pg_catalog.pg_constraint where contype='f' and confrelid=c.oid and not(
          conrelid='bjm_office_gateway.tokens'::regclass and confrelid='bjm_office_gateway.grants'::regclass)) then
        raise exception 'Gateway state table contract changed' using errcode='42501'; end if;
    end if;
    for a in select * from pg_catalog.aclexplode(coalesce(c.relacl,pg_catalog.acldefault('r',c.relowner)))
      union all select acl.* from pg_catalog.pg_attribute at cross join lateral pg_catalog.aclexplode(at.attacl) acl where at.attrelid=c.oid loop
      if a.grantee=c.relowner then continue; end if;
      if not (a.privilege_type='SELECT' and not a.is_grantable and (
        (c.relname in('configuration','active_owner') and a.grantee in(issuer_oid,aggregate_oid)) or
        (c.relname in('grants','tokens') and a.grantee=aggregate_oid))) then raise exception 'Gateway private relation grants changed' using errcode='42501'; end if;
    end loop;
  end loop;
  if exists(select 1 from pg_catalog.pg_class where oid=any(array['public.profiles'::regclass,'public.jobs'::regclass,'public.applications'::regclass,
    'public.cafe_subscriptions'::regclass,'public.subscription_payments'::regclass,'public.support_tickets'::regclass]) and (not relrowsecurity or relowner=aggregate_oid)) then
    raise exception 'Gateway sources must retain independent ownership and RLS' using errcode='42501'; end if;
  if exists(select 1 from pg_catalog.pg_policy where polrelid=any(array['public.profiles'::regclass,'public.jobs'::regclass,'public.applications'::regclass,
    'public.cafe_subscriptions'::regclass,'public.subscription_payments'::regclass,'public.support_tickets'::regclass]) and not polpermissive and polcmd in('r','*') and
    (0::oid=any(polroles) or aggregate_oid=any(polroles))) then raise exception 'Gateway restrictive RLS could silently truncate counts' using errcode='42501'; end if;
  if exists(select 1 from pg_catalog.pg_class c where c.oid=any(array['public.profiles'::regclass,'public.jobs'::regclass,'public.applications'::regclass,
    'public.cafe_subscriptions'::regclass,'public.subscription_payments'::regclass,'public.support_tickets'::regclass]) and not exists(
      select 1 from pg_catalog.pg_policy p where p.polrelid=c.oid and p.polname='gateway_aggregate_select' and p.polcmd='r' and p.polpermissive
        and p.polroles=array[aggregate_oid] and pg_catalog.pg_get_expr(p.polqual,p.polrelid)='bjm_office_gateway.context_valid()' and p.polwithcheck is null)) then
    raise exception 'Gateway aggregate RLS contract changed' using errcode='42501'; end if;
end $$;
revoke all on function bjm_office_gateway.assert_isolated() from public,anon,authenticated,service_role,bjm_office_gateway_login;
grant execute on function bjm_office_gateway.assert_isolated() to bjm_office_chat_aggregate;

create function bjm_office_gateway.auth_dispatch(op text,args jsonb)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare cfg bjm_office_gateway.configuration%rowtype; code bjm_office_gateway.codes%rowtype;
  tok bjm_office_gateway.tokens%rowtype; family bjm_office_gateway.grants%rowtype;
  payload text; keys text[]; required text[]; k text; now_at timestamptz:=pg_catalog.now(); access_exp timestamptz; current_consent text;
begin
  perform bjm_office_gateway.assert_isolated();
  if pg_catalog.jsonb_typeof(args) is distinct from 'object' then return null; end if;
  required := case op
    when 'create_flow' then array['flowHash','encryptedPayload'] when 'consume_flow' then array['flowHash']
    when 'create_code' then array['codeHash','clientId','redirectUri','challenge','resource','ownerId']
    when 'exchange_code' then array['codeHash','clientId','redirectUri','challenge','accessHash','refreshHash']
    when 'refresh' then array['refreshHash','clientId','resource','newAccessHash','newRefreshHash']
    when 'verify' then array['accessHash','clientId','resource'] when 'revoke' then array['tokenHash','clientId'] else null end;
  if required is null then return null; end if;
  select pg_catalog.array_agg(key order by key) into keys from pg_catalog.jsonb_object_keys(args) key;
  if keys is distinct from (select pg_catalog.array_agg(key order by key) from pg_catalog.unnest(required) key) then return null; end if;
  foreach k in array required loop
    if pg_catalog.jsonb_typeof(args->k) is distinct from 'string' then return null; end if;
    if k like '%Hash' and (args->>k) !~ '^[0-9a-f]{64}$' then return null; end if;
  end loop;
  if args ? 'challenge' and (args->>'challenge') !~ '^[A-Za-z0-9_-]{43}$' then return null; end if;
  select * into cfg from bjm_office_gateway.configuration where singleton;
  -- Delete only expired Office families, at most 100 families per call. Their
  -- token tombstones are retained for the entire absolute refresh lifetime,
  -- so old-token replay continues to revoke a live family after rotation.
  delete from bjm_office_gateway.grants where id in(select id from bjm_office_gateway.grants
    where refresh_expires_at<=now_at order by refresh_expires_at limit 100 for update skip locked);
  if op='consume_flow' then
    delete from bjm_office_gateway.flows where flow_hash=args->>'flowHash' returning encrypted_payload,expires_at into payload,access_exp;
    if payload is null or access_exp<=now_at then return null; end if;
    return pg_catalog.jsonb_build_object('encryptedPayload',payload);
  end if;
  if op='revoke' then
    -- Unknown or mismatched tokens are deliberately indistinguishable. Only
    -- the exact configured client and that token's own family can be revoked.
    if args->>'clientId'=cfg.chatgpt_client_id then
      select g.* into family from bjm_office_gateway.grants g join bjm_office_gateway.tokens t on t.grant_id=g.id
        where t.token_hash=args->>'tokenHash' and g.client_id=cfg.chatgpt_client_id and g.owner_id=cfg.owner_id and g.resource=cfg.resource for update of g;
      if family.id is not null then update bjm_office_gateway.grants set revoked_at=coalesce(revoked_at,now_at) where id=family.id; end if;
    end if;
    return '{"revoked":true}'::jsonb;
  end if;
  if cfg.enabled is distinct from true then return null; end if;
  if op='create_flow' then
    -- Bootstrap state is created BEFORE a first upstream consent exists. It
    -- grants no identity, code, token, or report capability by itself.
    if pg_catalog.octet_length(args->>'encryptedPayload') not between 1 and 65536 then return null; end if;
    perform pg_catalog.pg_advisory_xact_lock(146402817,1);
    delete from bjm_office_gateway.flows where flow_hash in(select flow_hash from bjm_office_gateway.flows where expires_at<=now_at order by expires_at limit 100);
    if (select count(*) from bjm_office_gateway.flows)>=100 then return null; end if;
    insert into bjm_office_gateway.flows values(args->>'flowHash',args->>'encryptedPayload',now_at+interval '10 minutes') on conflict do nothing;
    if not found then return null; end if;
    return '{"ok":true}'::jsonb;
  end if;
  select consent_version into current_consent from bjm_office_gateway.active_owner where owner_id=cfg.owner_id;
  if current_consent is null then return null; end if;
  if args->>'clientId' is distinct from cfg.chatgpt_client_id or (args ? 'resource' and args->>'resource' is distinct from cfg.resource) or
    (args ? 'redirectUri' and args->>'redirectUri' is distinct from cfg.redirect_uri) then return null; end if;
  if op='create_code' then
    if args->>'ownerId' is distinct from cfg.owner_id::text then return null; end if;
    perform pg_catalog.pg_advisory_xact_lock(146402817,2);
    delete from bjm_office_gateway.codes where code_hash in(select code_hash from bjm_office_gateway.codes where expires_at<=now_at order by expires_at limit 100);
    if (select count(*) from bjm_office_gateway.codes)>=100 then return null; end if;
    insert into bjm_office_gateway.codes values(args->>'codeHash',cfg.owner_id,cfg.chatgpt_client_id,cfg.redirect_uri,args->>'challenge',cfg.resource,current_consent,now_at+interval '60 seconds') on conflict do nothing;
    if not found then return null; end if;
    return '{"ok":true}'::jsonb;
  elsif op='exchange_code' then
    if args->>'accessHash'=args->>'refreshHash' or exists(select 1 from bjm_office_gateway.tokens where token_hash in(args->>'accessHash',args->>'refreshHash')) then return null; end if;
    select * into code from bjm_office_gateway.codes where code_hash=args->>'codeHash' for update;
    if code.code_hash is null or code.expires_at<=now_at or code.owner_id<>cfg.owner_id or code.client_id<>cfg.chatgpt_client_id or
      code.redirect_uri<>cfg.redirect_uri or code.resource<>cfg.resource or code.challenge<>args->>'challenge' or code.consent_version<>current_consent then return null; end if;
    delete from bjm_office_gateway.codes where code_hash=code.code_hash;
    insert into bjm_office_gateway.grants(owner_id,client_id,resource,consent_version,refresh_expires_at) values(cfg.owner_id,cfg.chatgpt_client_id,cfg.resource,current_consent,now_at+interval '30 days') returning * into family;
    access_exp:=now_at+interval '15 minutes';
    insert into bjm_office_gateway.tokens(token_hash,kind,grant_id,expires_at) values(args->>'accessHash','access',family.id,access_exp),(args->>'refreshHash','refresh',family.id,family.refresh_expires_at);
  elsif op='refresh' then
    select * into tok from bjm_office_gateway.tokens where token_hash=args->>'refreshHash' and kind='refresh';
    if tok.token_hash is null then return null; end if;
    -- Serialize on family first: different refresh generations cannot race.
    select * into family from bjm_office_gateway.grants where id=tok.grant_id for update;
    select * into tok from bjm_office_gateway.tokens where token_hash=args->>'refreshHash' and kind='refresh' for update;
    if family.revoked_at is not null or family.refresh_expires_at<=now_at or family.owner_id<>cfg.owner_id or family.client_id<>cfg.chatgpt_client_id or family.resource<>cfg.resource or family.consent_version<>current_consent or tok.expires_at<=now_at then return null; end if;
    if tok.used_at is not null then
      update bjm_office_gateway.grants set revoked_at=now_at where id=family.id;
      return null; -- COMMIT this rejected replay's revocation; never rollback null.
    end if;
    if args->>'newAccessHash'=args->>'newRefreshHash' or exists(select 1 from bjm_office_gateway.tokens where token_hash in(args->>'newAccessHash',args->>'newRefreshHash')) then return null; end if;
    update bjm_office_gateway.tokens set used_at=now_at where token_hash=tok.token_hash;
    update bjm_office_gateway.tokens set revoked_at=now_at where grant_id=family.id and kind='access' and revoked_at is null;
    access_exp:=least(now_at+interval '15 minutes',family.refresh_expires_at);
    insert into bjm_office_gateway.tokens(token_hash,kind,grant_id,expires_at) values(args->>'newAccessHash','access',family.id,access_exp),(args->>'newRefreshHash','refresh',family.id,family.refresh_expires_at);
  elsif op='verify' then
    select g.* into family from bjm_office_gateway.grants g join bjm_office_gateway.tokens t on t.grant_id=g.id
      where t.token_hash=args->>'accessHash' and t.kind='access' and t.revoked_at is null and t.used_at is null and t.expires_at>now_at
        and g.revoked_at is null and g.refresh_expires_at>now_at and g.owner_id=cfg.owner_id and g.client_id=cfg.chatgpt_client_id and g.resource=cfg.resource and g.consent_version=current_consent;
    if family.id is null then return null; end if;
    select expires_at into access_exp from bjm_office_gateway.tokens where token_hash=args->>'accessHash';
    return pg_catalog.jsonb_build_object('ownerId',cfg.owner_id,'clientId',cfg.chatgpt_client_id,'resource',cfg.resource,'accessExpiresAt',floor(extract(epoch from access_exp)));
  else return null;
  end if;
  return pg_catalog.jsonb_build_object('ownerId',cfg.owner_id,'accessExpiresAt',floor(extract(epoch from access_exp)),'refreshExpiresAt',floor(extract(epoch from family.refresh_expires_at)));
end $$;
revoke all on function bjm_office_gateway.auth_dispatch(text,jsonb) from public,anon,authenticated,service_role;

create function bjm_office_gateway.read_snapshot(access_hash text,client_id text,resource text)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare metrics jsonb := '{"profiles":null,"cafes":null,"baristas":null,"jobs":null,"applications":null,"subscriptions":null,"payments":null}'::jsonb;
  support jsonb := '{"total_recent":null,"open":null}'::jsonb;
  subscriptions jsonb := '{"total":null,"active":null,"past_due":null,"canceling":null}'::jsonb;
  payments jsonb := '{"recent":null,"failed":null,"refunded":null}'::jsonb;
  fragment jsonb; total bigint;
begin
  perform bjm_office_gateway.assert_isolated();
  if access_hash is null or access_hash !~ '^[0-9a-f]{64}$' or client_id is null or resource is null then raise exception 'Office access denied' using errcode='42501'; end if;
  perform pg_catalog.set_config('bjm_office_gateway.access_hash',access_hash,true);
  perform pg_catalog.set_config('bjm_office_gateway.client_id',client_id,true);
  perform pg_catalog.set_config('bjm_office_gateway.resource',resource,true);
  if not bjm_office_gateway.context_valid() then raise exception 'Office access denied' using errcode='42501'; end if;
  begin select pg_catalog.jsonb_build_object('profiles',count(*),'cafes',count(*) filter(where role='cafe_owner_manager'),'baristas',count(*) filter(where role='barista')) into fragment from public.profiles; metrics:=metrics||fragment;
  exception when undefined_table or undefined_column or insufficient_privilege then null; end;
  begin select count(*) into total from public.jobs; metrics:=metrics||pg_catalog.jsonb_build_object('jobs',total);
  exception when undefined_table or undefined_column or insufficient_privilege then null; end;
  begin select count(*) into total from public.applications; metrics:=metrics||pg_catalog.jsonb_build_object('applications',total);
  exception when undefined_table or undefined_column or insufficient_privilege then null; end;
  begin select pg_catalog.jsonb_build_object('total',count(*),'active',count(*) filter(where status='active'),'past_due',count(*) filter(where status in('past_due','unpaid','incomplete')),'canceling',count(*) filter(where cancel_at_period_end)) into subscriptions from public.cafe_subscriptions;
    metrics:=metrics||pg_catalog.jsonb_build_object('subscriptions',subscriptions->'total');
  exception when undefined_table or undefined_column or insufficient_privilege then null; end;
  begin select count(*) into total from public.subscription_payments; metrics:=metrics||pg_catalog.jsonb_build_object('payments',total);
    select pg_catalog.jsonb_build_object('recent',count(*),'failed',count(*) filter(where status='failed'),'refunded',count(*) filter(where status='refunded')) into payments from public.subscription_payments where created_at>=pg_catalog.now()-interval '30 days';
  exception when undefined_table or undefined_column or insufficient_privilege then null; end;
  begin select pg_catalog.jsonb_build_object('total_recent',count(*),'open',count(*) filter(where status not in('resolved','fixed','closed') or status is null)) into support from public.support_tickets where created_at>=pg_catalog.now()-interval '30 days';
  exception when undefined_table or undefined_column or insufficient_privilege then null; end;
  return pg_catalog.jsonb_build_object('schema_version',1,'generated_at',pg_catalog.now(),'metrics',metrics,'support',support,'billing',pg_catalog.jsonb_build_object('subscriptions',subscriptions,'payments',payments));
end $$;
revoke all on function bjm_office_gateway.read_snapshot(text,text,text) from public,anon,authenticated,service_role;
grant execute on function bjm_office_gateway.auth_dispatch(text,jsonb),bjm_office_gateway.read_snapshot(text,text,text) to bjm_office_gateway_login;
do $$ declare f record; begin
  for f in select oid from pg_catalog.pg_proc where pronamespace='bjm_office_gateway'::regnamespace loop
    execute pg_catalog.format('comment on function %s is %L',f.oid::regprocedure,
      'bjm-office-gateway-routine-v1:'||(select pg_catalog.md5(prosrc) from pg_catalog.pg_proc where oid=f.oid));
  end loop;
end $$;
grant create on schema bjm_office_gateway to bjm_office_chat_issuer,bjm_office_chat_aggregate;
alter function bjm_office_gateway.auth_dispatch(text,jsonb) owner to bjm_office_chat_issuer;
alter function bjm_office_gateway.assert_isolated() owner to bjm_office_chat_issuer;
alter function bjm_office_gateway.read_snapshot(text,text,text) owner to bjm_office_chat_aggregate;
alter function bjm_office_gateway.context_valid() owner to bjm_office_chat_aggregate;
revoke create on schema bjm_office_gateway from bjm_office_chat_issuer,bjm_office_chat_aggregate;
set local role bjm_office_chat_issuer;
select bjm_office_gateway.assert_isolated();
do $$ begin perform 1 from bjm_office_gateway.active_owner limit 1; end $$;
reset role;
do $$
declare saved jsonb:=pg_catalog.current_setting('bjm_office_gateway.install_memberships')::jsonb;
  target text; prior jsonb; restored jsonb; installer text:=current_user;
begin
  foreach target in array array['bjm_office_chat_issuer','bjm_office_chat_aggregate'] loop
    prior:=saved#>array[target,'prior'];
    if (saved#>>array[target,'changed'])::boolean then
      if prior='null'::jsonb then execute pg_catalog.format('revoke %I from %I granted by %I',target,installer,installer);
      else execute pg_catalog.format('grant %I to %I with set %s granted by %I',target,installer,case when (prior->>'set')::boolean then 'true' else 'false' end,installer); end if;
    end if;
    select pg_catalog.jsonb_build_object('set',m.set_option,'inherit',m.inherit_option,'admin',m.admin_option) into restored from pg_catalog.pg_auth_members m
      where m.roleid=target::regrole and m.member=installer::regrole and m.grantor=installer::regrole;
    if restored is distinct from nullif(prior,'null'::jsonb) then raise exception 'Gateway installer membership was not restored'; end if;
  end loop;
  if (select rolcanlogin from pg_catalog.pg_roles where rolname='bjm_office_gateway_login') then raise exception 'Gateway installer unexpectedly enabled LOGIN'; end if;
end $$;
-- No grant to authenticator, no public-schema API wrapper, no password and no
-- configuration INSERT. A separately reviewed activation sets exact mapping,
-- privately provisions the limited login, and tests real Supavisor identity.
commit;
