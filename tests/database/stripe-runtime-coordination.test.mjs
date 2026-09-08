import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, afterEach, before, beforeEach, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';

const CAFE = '00000000-0000-4000-8000-000000000002';
const OTHER_CAFE = '00000000-0000-4000-8000-000000000004';
const CLAIM_ONE = '10000000-0000-4000-8000-000000000001';
const CLAIM_TWO = '10000000-0000-4000-8000-000000000002';
const ATTEMPT = '20000000-0000-4000-8000-000000000001';
const CREATED_ONE = '2026-09-08T10:00:00.000Z';
const CREATED_TWO = '2026-09-08T10:01:00.000Z';
const EVENT_TIME = '2026-09-08T11:00:00.000Z';
const migration = readFileSync(new URL('../../supabase/migrations/20260908090000_harden_stripe_runtime_coordination.sql', import.meta.url), 'utf8');

let db;
const query = (sql, parameters = []) => db.query(sql, parameters);

async function sync({
  userId = CAFE,
  customerId = 'cus_cafe',
  subscriptionId = 'sub_one',
  subscriptionCreatedAt = CREATED_ONE,
  status = 'active',
  currentPeriodEnd = null,
  cancelAtPeriodEnd = false,
  eventCreatedAt = EVENT_TIME,
  authoritative = false,
  expectedEventCreatedAt = null,
  expectedRevision = null,
} = {}) {
  const result = await query(`
    select public.sync_stripe_subscription(
      $1::uuid, $2::text, $3::text, $4::timestamptz, $5::text,
      $6::timestamptz, $7::boolean, $8::timestamptz, $9::boolean,
      $10::timestamptz, $11::bigint
    ) as synced
  `, [
    userId, customerId, subscriptionId, subscriptionCreatedAt, status,
    currentPeriodEnd, cancelAtPeriodEnd, eventCreatedAt, authoritative,
    expectedEventCreatedAt, expectedRevision,
  ]);
  return result.rows[0].synced;
}

before(async () => {
  db = new PGlite();
  await db.exec(`
    create role anon;
    create role authenticated;
    create role service_role bypassrls;
    create table public.cafe_subscriptions (
      user_id uuid primary key,
      stripe_customer_id text,
      stripe_subscription_id text,
      status text,
      current_period_end timestamptz,
      cancel_at_period_end boolean not null default false,
      updated_at timestamptz not null default now()
    );
    create table public.stripe_webhook_events (
      event_id text primary key,
      event_type text not null,
      processed_at timestamptz not null default now()
    );
    create table public.subscription_payments (
      cafe_user_id uuid not null,
      provider text not null,
      provider_payment_id text primary key,
      amount_cents integer not null,
      currency text not null,
      status text not null,
      paid_at timestamptz
    );
    insert into public.cafe_subscriptions(user_id, status) values
      ('${CAFE}', 'free'), ('${OTHER_CAFE}', 'free');
  `);
  await db.exec(migration);
});

beforeEach(() => db.exec('begin'));
afterEach(() => db.exec('rollback'));
after(() => db.close());

test('the real migration loads with service-only function privileges', async () => {
  const columns = (await query(`
    select column_name from information_schema.columns
    where table_schema = 'public' and table_name = 'cafe_subscriptions'
      and column_name like 'stripe_%'
    order by column_name
  `)).rows.map(row => row.column_name);
  assert.ok(columns.includes('stripe_checkout_claim_id'));
  assert.ok(columns.includes('stripe_subscription_sync_revision'));

  const privileges = (await query(`
    select
      has_function_privilege('anon', 'public.sync_stripe_subscription(uuid,text,text,timestamptz,text,timestamptz,boolean,timestamptz,boolean,timestamptz,bigint)', 'execute') as anon,
      has_function_privilege('authenticated', 'public.sync_stripe_subscription(uuid,text,text,timestamptz,text,timestamptz,boolean,timestamptz,boolean,timestamptz,bigint)', 'execute') as authenticated,
      has_function_privilege('service_role', 'public.sync_stripe_subscription(uuid,text,text,timestamptz,text,timestamptz,boolean,timestamptz,boolean,timestamptz,bigint)', 'execute') as service
  `)).rows[0];
  assert.deepEqual(privileges, { anon: false, authenticated: false, service: true });
  const settlementPrivileges = (await query(`
    select
      has_function_privilege('anon', 'public.settle_stripe_checkout_attempt_for_deletion(uuid,uuid)', 'execute') as anon,
      has_function_privilege('authenticated', 'public.settle_stripe_checkout_attempt_for_deletion(uuid,uuid)', 'execute') as authenticated,
      has_function_privilege('service_role', 'public.settle_stripe_checkout_attempt_for_deletion(uuid,uuid)', 'execute') as service
  `)).rows[0];
  assert.deepEqual(settlementPrivileges, { anon: false, authenticated: false, service: true });
});

test('Checkout and deletion claims are fenced by their exact owners', async () => {
  const claimed = (await query(
    'select public.claim_stripe_checkout($1::uuid,$2::uuid,$3::uuid,$4::text) as result',
    [CAFE, CLAIM_ONE, ATTEMPT, 'web'],
  )).rows[0].result;
  assert.deepEqual(claimed, { attemptId: ATTEMPT, channel: 'web', recovered: false });
  assert.equal((await query(
    'select public.claim_stripe_checkout($1::uuid,$2::uuid,$3::uuid,$4::text) as result',
    [CAFE, CLAIM_TWO, '20000000-0000-4000-8000-000000000002', 'app'],
  )).rows[0].result, null);
  assert.equal((await query(
    'select public.release_stripe_checkout($1::uuid,$2::uuid,false) as released',
    [CAFE, CLAIM_TWO],
  )).rows[0].released, false);
  assert.equal((await query(
    'select public.release_stripe_checkout($1::uuid,$2::uuid,false) as released',
    [CAFE, CLAIM_ONE],
  )).rows[0].released, true);
  assert.equal((await query(
    'select public.claim_stripe_deletion($1::uuid,$2::uuid) as result',
    [CAFE, CLAIM_TWO],
  )).rows[0].result, 'claimed');
  assert.equal((await query(
    'select public.settle_stripe_checkout_attempt_for_deletion($1::uuid,$2::uuid) as settled',
    [CAFE, CLAIM_ONE],
  )).rows[0].settled, false);
  assert.equal((await query(
    'select public.settle_stripe_checkout_attempt_for_deletion($1::uuid,$2::uuid) as settled',
    [CAFE, CLAIM_TWO],
  )).rows[0].settled, true);
  const settled = (await query(`
    select stripe_checkout_attempt_id as attempt_id,
           stripe_checkout_channel as channel,
           stripe_checkout_claim_id as claim_id,
           stripe_checkout_claim_kind as claim_kind
    from public.cafe_subscriptions where user_id = $1
  `, [CAFE])).rows[0];
  assert.deepEqual(settled, { attempt_id: null, channel: null, claim_id: CLAIM_TWO, claim_kind: 'deletion' });

  await query(`
    update public.cafe_subscriptions
    set stripe_checkout_attempt_id = $2,
        stripe_checkout_channel = 'web',
        stripe_checkout_claim_expires_at = now() - interval '1 second'
    where user_id = $1
  `, [CAFE, ATTEMPT]);
  assert.equal((await query(
    'select public.settle_stripe_checkout_attempt_for_deletion($1::uuid,$2::uuid) as settled',
    [CAFE, CLAIM_TWO],
  )).rows[0].settled, false);
  const expired = (await query(`
    select stripe_checkout_attempt_id as attempt_id, stripe_checkout_channel as channel
    from public.cafe_subscriptions where user_id = $1
  `, [CAFE])).rows[0];
  assert.deepEqual(expired, { attempt_id: ATTEMPT, channel: 'web' });
});

test('subscription ordering, equal-second recovery, and authoritative no-op execute in PostgreSQL', async () => {
  assert.equal(await sync(), true);
  assert.equal(await sync({ status: 'past_due' }), true);
  assert.equal(await sync({ status: 'active' }), true);
  let state = (await query('select status,stripe_subscription_sync_revision as revision from cafe_subscriptions where user_id=$1', [CAFE])).rows[0];
  assert.deepEqual(state, { status: 'past_due', revision: 2 });

  assert.equal(await sync({
    status: 'active', authoritative: true,
    expectedEventCreatedAt: EVENT_TIME, expectedRevision: 2,
  }), true);
  state = (await query('select status,stripe_subscription_sync_revision as revision from cafe_subscriptions where user_id=$1', [CAFE])).rows[0];
  assert.deepEqual(state, { status: 'active', revision: 3 });

  assert.equal(await sync({
    status: 'active', authoritative: true,
    expectedEventCreatedAt: EVENT_TIME, expectedRevision: 3,
  }), true);
  assert.equal((await query('select stripe_subscription_sync_revision as revision from cafe_subscriptions where user_id=$1', [CAFE])).rows[0].revision, 3, 'Identical authoritative observations must not churn the revision.');

  assert.equal(await sync({
    subscriptionId: 'sub_two', subscriptionCreatedAt: CREATED_TWO,
    status: 'canceled',
  }), true);
  assert.equal((await query('select stripe_subscription_id from cafe_subscriptions where user_id=$1', [CAFE])).rows[0].stripe_subscription_id, 'sub_one', 'A terminal duplicate cannot mask the charging active subscription.');
  assert.equal(await sync({
    subscriptionId: 'sub_two', subscriptionCreatedAt: CREATED_TWO,
    status: 'active',
  }), true);
  assert.equal((await query('select stripe_subscription_id from cafe_subscriptions where user_id=$1', [CAFE])).rows[0].stripe_subscription_id, 'sub_two');

  await query(`
    update cafe_subscriptions
    set stripe_subscription_event_created_at = null
    where user_id = $1
  `, [CAFE]);
  const revision = (await query('select stripe_subscription_sync_revision as revision from cafe_subscriptions where user_id=$1', [CAFE])).rows[0].revision;
  assert.equal(await sync({
    subscriptionId: 'sub_two', subscriptionCreatedAt: CREATED_TWO,
    status: 'active', authoritative: true,
    expectedEventCreatedAt: null, expectedRevision: revision,
  }), true);
  const initialized = (await query('select stripe_subscription_event_created_at is not null as initialized,stripe_subscription_sync_revision as revision from cafe_subscriptions where user_id=$1', [CAFE])).rows[0];
  assert.equal(initialized.initialized, true);
  assert.equal(initialized.revision, revision + 1);
});

test('webhook claims and payment records reject stale or foreign writers', async () => {
  const claim = async (id, type, claimId) => (await query(
    'select public.claim_stripe_webhook_event($1::text,$2::text,$3::uuid) as result',
    [id, type, claimId],
  )).rows[0].result;
  assert.equal(await claim('evt_one', 'invoice.paid', CLAIM_ONE), 'claimed');
  assert.equal(await claim('evt_one', 'invoice.paid', CLAIM_TWO), 'busy');
  assert.equal((await query(
    'select public.complete_stripe_webhook_event($1::text,$2::uuid) as completed',
    ['evt_one', CLAIM_TWO],
  )).rows[0].completed, false);
  assert.equal((await query(
    'select public.complete_stripe_webhook_event($1::text,$2::uuid) as completed',
    ['evt_one', CLAIM_ONE],
  )).rows[0].completed, true);
  assert.equal(await claim('evt_one', 'invoice.paid', CLAIM_TWO), 'duplicate');

  const record = parameters => query(`
    select public.record_stripe_subscription_payment(
      $1::uuid,$2::text,$3::integer,$4::text,$5::text,$6::timestamptz,$7::timestamptz
    ) as recorded
  `, parameters);
  assert.equal((await record([CAFE, 'in_one', 999, 'usd', 'succeeded', EVENT_TIME, EVENT_TIME])).rows[0].recorded, true);
  assert.equal((await record([CAFE, 'in_one', 999, 'usd', 'failed', null, CREATED_TWO])).rows[0].recorded, false);
  assert.equal((await query('select status from subscription_payments where provider_payment_id=$1', ['in_one'])).rows[0].status, 'succeeded');
  await assert.rejects(
    record([OTHER_CAFE, 'in_one', 999, 'usd', 'refunded', EVENT_TIME, '2026-09-08T12:00:00.000Z']),
    /ownership conflict/,
  );
});
