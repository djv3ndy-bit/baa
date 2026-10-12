-- SYNTHETIC DISPOSABLE TEST FIXTURE ONLY. Never apply to a hosted database.
-- Minimal dependency contracts, NOT a reconstructed production schema.
-- Names/argument types are from the saved catalog audit; return types and helper
-- columns agree with the reviewed source files named in README.md.
-- Existing checkout functions are sentinel stubs, not tests of their internals.
create role anon;
create role authenticated;
create role service_role bypassrls;
create schema auth;
create schema private;
create schema test_harness;
create table auth.users(id uuid primary key);
create table public.profiles(id uuid primary key,role text,suspended_at timestamptz);
create table private.native_billing_configuration(
 singleton boolean primary key check(singleton),
 environment text not null check(environment in ('Production','Sandbox'))
);
insert into private.native_billing_configuration values(true,'Production');
create table private.native_checkout_attempts(
 id uuid primary key,user_id uuid not null,provider text not null,
 environment text not null,state text not null,reserved_until timestamptz not null,
 created_at timestamptz not null default now(),updated_at timestamptz not null default now()
);
alter table private.native_checkout_attempts enable row level security;
alter table private.native_billing_configuration enable row level security;
create function auth.uid() returns uuid language sql stable as $f$
 select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid;
$f$;
grant usage on schema public,auth,test_harness to anon,authenticated,service_role;
grant execute on function auth.uid() to anon,authenticated,service_role;
create function public.native_checkout_claim(uuid,text,text,uuid) returns jsonb
 language sql as $f$ select '{"fixture":"claim"}'::jsonb; $f$;
create function public.native_checkout_start(uuid,text,uuid) returns boolean
 language sql as $f$ select false; $f$;
create function public.native_checkout_cancel(uuid,text,uuid,boolean) returns boolean
 language sql as $f$ select false; $f$;
create function public.native_checkout_recover_apple(uuid,text) returns jsonb
 language sql as $f$ select '{"fixture":"recover"}'::jsonb; $f$;
create function public.native_billing_summary(uuid,text) returns jsonb
 language sql as $f$ select '{"fixture":"summary"}'::jsonb; $f$;
revoke all on function public.native_checkout_claim(uuid,text,text,uuid),
 public.native_checkout_start(uuid,text,uuid),public.native_checkout_cancel(uuid,text,uuid,boolean),
 public.native_checkout_recover_apple(uuid,text),public.native_billing_summary(uuid,text)
 from public,anon,authenticated,service_role;
grant execute on function public.native_checkout_claim(uuid,text,text,uuid),
 public.native_checkout_start(uuid,text,uuid),public.native_checkout_cancel(uuid,text,uuid,boolean),
 public.native_checkout_recover_apple(uuid,text),public.native_billing_summary(uuid,text) to service_role;
create function test_harness.assert(ok boolean) returns void language plpgsql as $f$
 begin if ok is distinct from true then raise exception 'LOCAL_FIXTURE_ASSERTION_FAILED'; end if; end;
$f$;
grant execute on function test_harness.assert(boolean) to anon,authenticated,service_role;
insert into auth.users(id) values
 ('10000000-0000-4000-8000-000000000001'),('10000000-0000-4000-8000-000000000002'),
 ('10000000-0000-4000-8000-000000000003'),('10000000-0000-4000-8000-000000000004'),
 ('10000000-0000-4000-8000-000000000005');
insert into public.profiles(id,role,suspended_at) values
 ('10000000-0000-4000-8000-000000000001','cafe_owner_manager',null),
 ('10000000-0000-4000-8000-000000000002','cafe_owner_manager',null),
 ('10000000-0000-4000-8000-000000000003','barista',null),
 ('10000000-0000-4000-8000-000000000004','cafe_owner_manager',now());
insert into private.native_checkout_attempts(id,user_id,provider,environment,state,reserved_until) values
 ('20000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','google','Production','reserved',now()+interval '1 hour'),
 ('20000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000001','apple','Production','reserved',now()+interval '1 hour'),
 ('20000000-0000-4000-8000-000000000003','10000000-0000-4000-8000-000000000001','google','Production','reserved',now()-interval '1 minute'),
 ('20000000-0000-4000-8000-000000000004','10000000-0000-4000-8000-000000000001','google','Production','started',now()+interval '1 hour'),
 ('20000000-0000-4000-8000-000000000005','10000000-0000-4000-8000-000000000001','google','Production','cancelled',now()+interval '1 hour'),
 ('20000000-0000-4000-8000-000000000006','10000000-0000-4000-8000-000000000002','google','Production','reserved',now()+interval '1 hour'),
 ('20000000-0000-4000-8000-000000000007','10000000-0000-4000-8000-000000000003','google','Production','reserved',now()+interval '1 hour'),
 ('20000000-0000-4000-8000-000000000008','10000000-0000-4000-8000-000000000001','google','Sandbox','reserved',now()+interval '1 hour'),
 ('20000000-0000-4000-8000-000000000009','10000000-0000-4000-8000-000000000004','google','Production','reserved',now()+interval '1 hour'),
 ('20000000-0000-4000-8000-000000000010','10000000-0000-4000-8000-000000000005','google','Production','reserved',now()+interval '1 hour');
-- Broad known platform-style defaults are intentionally simulated so the draft
-- must remove them on new objects without changing these shared defaults.
alter default privileges for role postgres in schema public
 grant all on tables to anon,authenticated,service_role;
alter default privileges for role postgres in schema public
 grant execute on functions to anon,authenticated,service_role;
alter default privileges for role postgres in schema private
 grant execute on functions to anon,authenticated,service_role;
