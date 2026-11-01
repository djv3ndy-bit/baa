import {readFileSync} from 'node:fs';

const source = path => readFileSync(new URL('../../'+path, import.meta.url),'utf8');
export const reviewer = 'afc55a3d-4a94-4893-bd78-ac6410ac6aed';
export const ordinary = '00000000-0000-4000-8000-000000000004';
export const barista = '00000000-0000-4000-8000-000000000001';
export const stripeCafe = '00000000-0000-4000-8000-000000000003';
export const guardProtocol = 'apple-app-transaction-v1';
export const attemptId = '50000000-0000-4000-8000-000000000001';
export const draftSql = () => source('server/native-billing/sql/apple_sandbox_test_accounts.sql');

// The caller supplies a disposable local PGlite/PostgreSQL adapter. This module
// has no network client, URL, credential, database selection or hosted fallback.
export async function createAppleSandboxFixture(db,{applyDraft=true}={}) {
  await db.exec(source('tests/database/job-posting-entitlement-fixture.sql'));
  await db.exec(source('supabase/migrations/20260908100000_enforce_cafe_job_posting_entitlements.sql'));
  await db.exec(source('supabase/migrations/20260908110000_consolidate_job_participant_visibility.sql'));
  await db.exec(`create table public.discovery_matches(id uuid primary key,barista_id uuid not null references public.profiles(id),cafe_id uuid not null references public.profiles(id));
    create table public.discovery_messages(id uuid primary key default gen_random_uuid(),match_id uuid not null references public.discovery_matches(id),sender_id uuid not null references public.profiles(id),body text not null);
    alter table public.discovery_matches enable row level security;
    alter table public.discovery_messages enable row level security;
    grant select on public.discovery_matches to authenticated;
    grant select,insert on public.discovery_messages to authenticated;`);
  const safety=source('supabase/migrations/20260831090000_add_member_safety_controls.sql');
  // Exercise the saved discovery participant/message policies verbatim. This
  // small synthetic schema intentionally omits notification side effects.
  await db.exec(safety.slice(safety.indexOf('drop policy if exists "Participants can view discovery matches"'),safety.indexOf('drop policy if exists "matched users can read messages"')));
  await db.exec(`alter table public.cafe_subscriptions
    add column stripe_checkout_attempt_id uuid,
    add column stripe_checkout_claim_id uuid,
    add column stripe_checkout_claim_expires_at timestamptz,
    add column stripe_checkout_claim_kind text,
    add column stripe_checkout_channel text,
    add column stripe_checkout_ui_mode text;
    alter table public.cafe_subscriptions drop constraint cafe_subscriptions_status_check;
    alter table public.cafe_subscriptions add constraint cafe_subscriptions_status_check
      check(status in ('trialing','active','past_due','canceled','expired','unpaid','incomplete','paused'));
    insert into public.profiles(id,role) values('${reviewer}','cafe_owner_manager');
    insert into public.cafe_subscriptions(user_id,status,trial_ends_at,complimentary_access)
      values('${reviewer}','expired','2000-01-01',false);`);
  await db.exec(source('review/native-billing-ledger.sql'));
  const coordination=source('review/native-checkout-coordination.sql');
  // The source table/function setup is followed by the exact read-only live
  // function snapshot, including Stripe coordination; there are no stubs.
  await db.exec(coordination);
  await db.exec(source('tests/database/apple-sandbox-stripe-live.fixture.sql'));
  await db.exec(`revoke all on function public.claim_stripe_checkout(uuid,uuid,uuid,text,text) from public,anon,authenticated;
    grant execute on function public.claim_stripe_checkout(uuid,uuid,uuid,text,text) to service_role;`);
  await db.exec(source('tests/database/apple-sandbox-live-functions.fixture.sql'));
  await db.exec(`revoke all on private.native_billing_accounts,private.native_billing_subscriptions,
    private.native_billing_events,private.native_billing_configuration,private.native_checkout_attempts
    from public,anon,authenticated,service_role;`);
  // Only synthetic fixture profiles/IDs exist in this in-memory/local database.
  if(applyDraft) await db.exec(draftSql());
}

export async function resetAppleSandboxFixture(db) {
  await db.exec(`reset role;
    select set_config('request.jwt.claim.sub','',false);
    truncate public.discovery_messages,public.discovery_matches;
    truncate private.native_checkout_attempts,private.native_billing_subscriptions,
      private.native_billing_events,private.native_billing_accounts,private.apple_sandbox_test_accounts;
    update private.native_billing_configuration set environment='Production';
    insert into public.profiles(id,role) values('${reviewer}','cafe_owner_manager'),('${ordinary}','cafe_owner_manager') on conflict(id) do nothing;
    insert into public.cafe_subscriptions(user_id,status,trial_ends_at,complimentary_access)
      values('${reviewer}','expired','2000-01-01',false),('${ordinary}','expired','2000-01-01',false) on conflict(user_id) do nothing;
    update public.profiles set role='cafe_owner_manager',suspended_at=null where id in ('${reviewer}','${ordinary}');
    update public.cafe_subscriptions set status='expired',trial_ends_at='2000-01-01',
      stripe_customer_id=null,stripe_subscription_id=null,stripe_checkout_attempt_id=null,
      stripe_checkout_claim_id=null,stripe_checkout_claim_expires_at=null,
      stripe_checkout_claim_kind=null,stripe_checkout_channel=null,stripe_checkout_ui_mode=null,
      owner_paused_at=null,complimentary_access=false where user_id in ('${reviewer}','${ordinary}');
    delete from public.jobs where owner_id in ('${reviewer}','${ordinary}');
    delete from private.cafe_job_entitlements where cafe_id in ('${reviewer}','${ordinary}');`);
}

