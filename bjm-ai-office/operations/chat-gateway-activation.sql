-- REVIEW TEMPLATE ONLY. No hosted changes are authorized by this file.
-- Render each phase privately from the approved manifest, using proper SQL
-- literal escaping. Never save/print the rendered statement or its verifier.
-- Each phase deliberately aborts unless its review guard is removed by the
-- approved execution driver. Placeholder UUIDs/verifiers are also invalid.
-- Execute ONE phase at a time within the approved rollout scope, completing
-- its sequential prerequisites. An approval covering the rollout also covers
-- its stated setup, verification, conditional activation and failure cleanup.
-- Prerequisite: separately reviewed office-chat-gateway-review.sql installed
-- atomically with NOLOGIN, empty config, no PUBLIC privilege-audit failures.
-- Also verify the reviewed source/deployment and both OAuth metadata documents.

-- PHASE A: exact disabled mapping + privately provisioned limited credential.
-- The NEW upstream public Auth client must already have been created through
-- normal supported Auth administration, with its sole callback pointing to
-- this Office origin's /oauth/owner/callback. It is NOT the legacy Office client.
begin;
do $$ begin raise exception 'REVIEW_ONLY_PHASE_A: render privately after approval'; end $$;
do $$
declare
  verified_owner uuid := '__VERIFIED_OWNER_UUID__';
  new_identity_client uuid := '__VERIFIED_NEW_UPSTREAM_CLIENT_UUID__';
  chat_client text := '__VERIFIED_PREREGISTERED_CHAT_CLIENT_ID__';
  chat_callback text := '__EXACT_CHATGPT_CALLBACK__';
  office_resource text := '__EXACT_APPROVED_OFFICE_HTTPS_ORIGIN__/mcp';
  scram_verifier text := '__PRIVATE_SCRAM_SHA_256_VERIFIER__';
  cfg bjm_office_gateway.configuration%rowtype;
begin
  if current_user<>session_user then raise exception 'Unexpected applying role switch'; end if;
  if office_resource !~ '^https://[^/?#]+/mcp$' or chat_client='' then raise exception 'Unrendered/invalid approved mapping'; end if;
  if exists(select 1 from pg_catalog.pg_roles where rolname in('bjm_office_gateway_login','bjm_office_chat_issuer','bjm_office_chat_aggregate')
    and (rolcanlogin or rolinherit or rolsuper or rolcreaterole or rolcreatedb or rolreplication or rolbypassrls)) or
    (select count(*) from pg_catalog.pg_roles where rolname in('bjm_office_gateway_login','bjm_office_chat_issuer','bjm_office_chat_aggregate'))<>3 or
    exists(select 1 from pg_catalog.pg_auth_members where member in('bjm_office_gateway_login'::regrole,'bjm_office_chat_issuer'::regrole,'bjm_office_chat_aggregate'::regrole)) then
    raise exception 'Expected isolated NOLOGIN gateway installation'; end if;
  if exists(select 1 from bjm_office_private.configuration where enabled or client_id=new_identity_client) then
    raise exception 'Legacy mapping must stay disabled and use its separate client'; end if;
  if not exists(select 1 from auth.users where id=verified_owner and email_confirmed_at is not null and is_anonymous is false
    and deleted_at is null and (banned_until is null or banned_until<=pg_catalog.now())) then raise exception 'Approved owner is not active'; end if;
  if (select count(*) from auth.oauth_clients where id=new_identity_client and deleted_at is null and client_type::text='public'
    and registration_type::text='manual' and token_endpoint_auth_method='none' and coalesce(client_secret_hash,'')=''
    and client_name='BaristaMatch AI Office Identity'
    and redirect_uris=pg_catalog.left(office_resource,pg_catalog.length(office_resource)-4)||'/oauth/owner/callback'
    and 'authorization_code'=any(pg_catalog.regexp_split_to_array(grant_types,'\s*,\s*')))<>1 then
    raise exception 'Expected exact new public identity client/callback'; end if;
  -- Use a strong randomly generated password in the private app secret only.
  -- SQL receives its precomputed SCRAM verifier, never that plaintext password.
  -- The verifier is still sensitive. Do not put either value in source, tool
  -- output, terminal history, deployment logs, or user-facing artifacts.
  if scram_verifier !~ '^SCRAM-SHA-256\$[0-9]+:[A-Za-z0-9+/]+=*\$[A-Za-z0-9+/]+=*:[A-Za-z0-9+/]+=*$' or
    pg_catalog.split_part(pg_catalog.split_part(scram_verifier,'$',2),':',1)::integer<4096 or
    pg_catalog.octet_length(pg_catalog.decode(pg_catalog.split_part(pg_catalog.split_part(scram_verifier,'$',2),':',2),'base64'))<16 or
    pg_catalog.octet_length(pg_catalog.decode(pg_catalog.split_part(pg_catalog.split_part(scram_verifier,'$',3),':',1),'base64'))<>32 or
    pg_catalog.octet_length(pg_catalog.decode(pg_catalog.split_part(pg_catalog.split_part(scram_verifier,'$',3),':',2),'base64'))<>32 then
    raise exception 'Expected privately generated SCRAM-SHA-256 verifier'; end if;
  lock table bjm_office_gateway.configuration in exclusive mode;
  select * into cfg from bjm_office_gateway.configuration where singleton;
  if cfg.owner_id is not null and (cfg.owner_id is distinct from verified_owner or cfg.upstream_client_id is distinct from new_identity_client or
    cfg.chatgpt_client_id is distinct from chat_client or cfg.redirect_uri is distinct from chat_callback or
    cfg.resource is distinct from office_resource or cfg.enabled is distinct from false) then raise exception 'Existing gateway mapping conflicts'; end if;
  if cfg.owner_id is null then insert into bjm_office_gateway.configuration values(true,verified_owner,new_identity_client,chat_client,chat_callback,office_resource,false); end if;
  execute pg_catalog.format('alter role bjm_office_gateway_login password %L',scram_verifier);
  alter role bjm_office_gateway_login connection limit 3;
  alter role bjm_office_gateway_login set statement_timeout='5s';
  alter role bjm_office_gateway_login set lock_timeout='1s';
  alter role bjm_office_gateway_login set idle_in_transaction_session_timeout='15s';
  alter role bjm_office_gateway_login login;
end $$;
commit;
select (select count(*)=1 and bool_and(not enabled) from bjm_office_gateway.configuration) as gateway_mapping_disabled,
  (select rolcanlogin and rolconnlimit=3 and not rolinherit and not rolsuper and not rolcreaterole and not rolcreatedb and not rolbypassrls and not rolreplication
    from pg_catalog.pg_roles where rolname='bjm_office_gateway_login') as limited_login_enabled,
  not exists(select 1 from bjm_office_private.configuration where enabled) as legacy_mapping_still_disabled;

-- BEFORE PHASE B: privately connect with ONLY the new custom role via the
-- dashboard-verified shared transaction pooler (port6543). The username is
-- bjm_office_gateway_login.<project-ref>, not postgres/service_role. Do not
-- invent the pooler hostname. Use max1, preparefalse and verified TLS.
-- Prove actual current_user/session_user are the custom role and new-session
-- timeout defaults match5s/1s/15s. SET ROLE is not a login/defaults proof.
-- While configdisabled, auth_dispatch('verify', unknown valid-format hash)
-- must return null AFTER the runtime audit; read_snapshot must deny42501.
-- Raw six-source/Auth/Storage/private-table reads, writes, role switching and
-- legacy RPC execution must deny42501. Never read private object contents.
-- Timeouts/connection limits are cost controls; privileges enforce isolation.
-- Missing initial upstream consent is expected: only encrypted flow creation
-- becomes possible when phaseB enables setup; codes/reports still need consent.

-- PHASE B: explicitly approved, bounded live-verification window only.
-- Re-render exact SAME manifest; never silently replace mapping/client/origin.
-- Confirm new restricted credential and correct disabled deployment first.
begin;
do $$ begin raise exception 'REVIEW_ONLY_PHASE_B: render after approved rollout prerequisites'; end $$;
do $$
declare
  verified_owner uuid := '__VERIFIED_OWNER_UUID__';
  new_identity_client uuid := '__VERIFIED_NEW_UPSTREAM_CLIENT_UUID__';
  chat_client text := '__VERIFIED_PREREGISTERED_CHAT_CLIENT_ID__';
  chat_callback text := '__EXACT_CHATGPT_CALLBACK__';
  office_resource text := '__EXACT_APPROVED_OFFICE_HTTPS_ORIGIN__/mcp';
  changed integer;
begin
  lock table bjm_office_gateway.configuration in exclusive mode;
  if exists(select 1 from bjm_office_private.configuration where enabled or client_id=new_identity_client) or
    not exists(select 1 from pg_catalog.pg_roles where rolname='bjm_office_gateway_login' and rolcanlogin and rolconnlimit=3 and
      not rolinherit and not rolsuper and not rolcreaterole and not rolcreatedb and not rolbypassrls and not rolreplication) then raise exception 'Gateway activation prerequisite changed'; end if;
  if not exists(select 1 from auth.users where id=verified_owner and email_confirmed_at is not null and is_anonymous is false
    and deleted_at is null and (banned_until is null or banned_until<=pg_catalog.now())) then raise exception 'Approved owner is not active'; end if;
  if not exists(select 1 from auth.oauth_clients where id=new_identity_client and deleted_at is null and client_type::text='public'
    and registration_type::text='manual' and token_endpoint_auth_method='none' and coalesce(client_secret_hash,'')=''
    and client_name='BaristaMatch AI Office Identity'
    and redirect_uris=pg_catalog.left(office_resource,pg_catalog.length(office_resource)-4)||'/oauth/owner/callback') then raise exception 'Identity client changed'; end if;
  update bjm_office_gateway.configuration set enabled=true where singleton and not enabled and owner_id=verified_owner and upstream_client_id=new_identity_client
    and chatgpt_client_id=chat_client and redirect_uri=chat_callback and resource=office_resource;
  get diagnostics changed=row_count;
  if changed<>1 then raise exception 'Exact disabled gateway mapping not found'; end if;
end $$;
commit;
select (select count(*)=1 and bool_and(enabled) from bjm_office_gateway.configuration) as exact_gateway_mapping_enabled;

-- Live proof must cover normal owner consent -> upstream localLogout204 ->
-- Office opaque code/token -> five reports -> refresh rotation -> revoke.
-- Test nonowner/client/resource/PKCE/session negatives and preserve website
-- customer login. Supabase /user must reject the opaque Office bearer using a
-- harmless GET; no destructive owner-account probes are needed.
-- End the window through normal scoped Office revoke, then apply reviewed
-- rollback unless the approved rollout includes production enablement and its
-- prerequisites have passed. Do not request approval again for covered steps.
-- Keep the old client-specific hook and disabled mapping intact. Retire old
-- dedicated grants/sessions only within the approved exact-client scope.

-- Primary references checked2026-10-14:
-- https://supabase.com/docs/guides/database/connecting-to-postgres
-- https://www.postgresql.org/docs/17/sql-createrole.html
-- https://www.postgresql.org/docs/17/sql-alterrole.html
-- https://github.com/supabase/auth/blob/master/internal/models/oauth_client.go
