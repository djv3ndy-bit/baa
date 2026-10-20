-- REVIEW TEMPLATE ONLY. Use for automatic failure/window cleanup covered by
-- the approved rollout, or an authorized later rollback. Covered cleanup does
-- not need a new confirmation. Remove the guard through the execution driver.
-- This targets only this Office gateway's singleton config and custom role.
-- Revoke disposable Office test grants through its normal OAuth endpoint first
-- when possible. Revocation/refresh-reuse must commit, even when returning null.
begin;
do $$ begin raise exception 'REVIEW_ONLY_ROLLBACK: render after approval'; end $$;
-- First remove report/issuance access, including from already-pooled sessions.
update bjm_office_gateway.configuration set enabled=false where singleton;
-- NOLOGIN/PASSWORDNULL prevent fresh backend/password authentication. They do
-- not terminate existing sessions or guarantee instant pooler-cache eviction.
-- Every request's config/audit check supplies the immediate report cutoff.
alter role bjm_office_gateway_login nologin password null;
commit;
select not exists(select 1 from bjm_office_gateway.configuration where enabled) as gateway_mapping_disabled,
  not exists(select 1 from pg_catalog.pg_roles where rolname='bjm_office_gateway_login' and rolcanlogin) as gateway_login_disabled,
  not exists(select 1 from bjm_office_private.configuration where enabled) as legacy_mapping_still_disabled;

-- With an existing limited-role pool connection, verify must return null and
-- read_snapshot must deny42501. Cleanup-only consume_flow/revoke may finish;
-- issuance/refresh/reports must remain denied. No pg_terminate_backend or
-- other customer's sessions, grants, source rows or Storage objects are touched.
-- Disable app auth, remove the new private credential from the target scope,
-- close owned app pools, redeploy the reviewed disabled source, and remove any
-- exact approved temporary domain exception through the normal platform UI.
-- Retain private Office state, roles, audited functions and the separate legacy
-- restricted hook/mapping. Nothing here enables or removes the website panel.
-- Stored Office grants are not deleted by rollback; deliberate future re-enable
-- can restore still-valid grants unless separately revoked. Do not describe
-- this reversible disabled gate as permanent per-grant revocation.
