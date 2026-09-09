import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, afterEach, before, beforeEach, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';

const CAFE = '00000000-0000-4000-8000-000000000002';
const OTHER_CAFE = '00000000-0000-4000-8000-000000000004';
const LEGACY_CAFE = '00000000-0000-4000-8000-000000000006';
const CLAIM_ONE = '10000000-0000-4000-8000-000000000001';
const CLAIM_TWO = '10000000-0000-4000-8000-000000000002';
const ATTEMPT = '20000000-0000-4000-8000-000000000001';
const CREATED_ONE = '2026-09-08T10:00:00.000Z';
const CREATED_TWO = '2026-09-08T10:01:00.000Z';
const EVENT_TIME = '2026-09-08T11:00:00.000Z';
const migration = readFileSync(new URL('../../supabase/migrations/20260908090000_harden_stripe_runtime_coordination.sql', import.meta.url), 'utf8');
const uiModeMigration = readFileSync(new URL('../../supabase/migrations/20260909044749_bind_checkout_attempt_ui_mode.sql', import.meta.url), 'utf8');

let db;
const query = (sql, parameters = []) => db.query(sql, parameters);

async function claimCheckout({ userId = CAFE, claimId = CLAIM_ONE, attemptId = ATTEMPT, channel = 'web', uiMode } = {}) {
  const sql = uiMode === undefined
    ? 'select public.claim_stripe_checkout(p_user_id => $1::uuid,p_claim_id => $2::uuid,p_attempt_id => $3::uuid,p_channel => $4::text) as result'
    : 'select public.claim_stripe_checkout(p_user_id => $1::uuid,p_claim_id => $2::uuid,p_attempt_id => $3::uuid,p_channel => $4::text,p_ui_mode => $5::text) as result';
  const parameters = [userId, claimId, attemptId, channel];
  if (uiMode !== undefined) parameters.push(uiMode);
  return (await query(sql, parameters)).rows[0].result;
}

async function checkoutState(userId = CAFE) {
  return (await query(`
    select stripe_checkout_attempt_id as attempt_id,
           stripe_checkout_channel as channel,
           stripe_checkout_ui_mode as ui_mode,
           stripe_checkout_claim_id as claim_id,
           stripe_checkout_claim_kind as claim_kind
    from public.cafe_subscriptions where user_id = $1
  `, [userId])).rows[0];
}

async function releaseCheckout({ userId = CAFE, claimId = CLAIM_ONE, clearAttempt = false } = {}) {
  return (await query(
    'select public.release_stripe_checkout($1::uuid,$2::uuid,$3::boolean) as result',
    [userId, claimId, clearAttempt],
  )).rows[0].result;
}

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
  await query(`
    insert into public.cafe_subscriptions (
      user_id, status, stripe_checkout_attempt_id, stripe_checkout_channel,
      stripe_checkout_claim_id, stripe_checkout_claim_kind, stripe_checkout_claim_expires_at
    ) values ($1, 'free', $2, 'app', $3, 'checkout', now() + interval '5 minutes')
  `, [LEGACY_CAFE, ATTEMPT, CLAIM_ONE]);
  await db.exec(uiModeMigration);
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
  assert.ok(columns.includes('stripe_checkout_ui_mode'));
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
  for (const signature of [
    'public.claim_stripe_checkout(uuid,uuid,uuid,text,text)',
    'public.release_stripe_checkout(uuid,uuid,boolean)',
  ]) {
    const privileges = (await query(`
      select has_function_privilege('anon', $1, 'execute') as anon,
             has_function_privilege('authenticated', $1, 'execute') as authenticated,
             has_function_privilege('service_role', $1, 'execute') as service
    `, [signature])).rows[0];
    assert.deepEqual(privileges, { anon: false, authenticated: false, service: true });
  }
  const signatures = (await query(`
    select pronargs, pronargdefaults from pg_proc
    where pronamespace = 'public'::regnamespace and proname = 'claim_stripe_checkout'
  `)).rows;
  assert.deepEqual(signatures, [{ pronargs: 5, pronargdefaults: 1 }], 'PostgREST sees only one claim signature with an optional UI mode.');
});

test('the UI migration binds legacy attempts to hosted without replacing their lease or payload', async () => {
  assert.deepEqual(await checkoutState(LEGACY_CAFE), {
    attempt_id: ATTEMPT, channel: 'app', ui_mode: 'hosted', claim_id: CLAIM_ONE, claim_kind: 'checkout',
  });
  assert.equal((await checkoutState()).ui_mode, null, 'Accounts without a retained attempt keep no UI mode.');
  assert.equal(await claimCheckout({ userId: LEGACY_CAFE, claimId: CLAIM_TWO, uiMode: 'embedded' }), null, 'Migration preserves an active legacy lease.');
  await query(`update cafe_subscriptions set stripe_checkout_claim_expires_at = now() - interval '1 second' where user_id = $1`, [LEGACY_CAFE]);
  assert.deepEqual(await claimCheckout({ userId: LEGACY_CAFE, claimId: CLAIM_TWO, uiMode: 'embedded' }), {
    attemptId: ATTEMPT, channel: 'app', uiMode: 'hosted', recovered: true,
  });
});

test('new Checkout attempts honor embedded web requests and keep legacy and app requests hosted', async () => {
  assert.deepEqual(await claimCheckout(), { attemptId: ATTEMPT, channel: 'web', uiMode: 'hosted', recovered: false });
  assert.equal(await releaseCheckout({ clearAttempt: true }), true);
  assert.deepEqual(await claimCheckout({ channel: 'app' }), { attemptId: ATTEMPT, channel: 'app', uiMode: 'hosted', recovered: false });
  assert.equal(await releaseCheckout({ clearAttempt: true }), true);
  assert.deepEqual(await claimCheckout({ uiMode: 'embedded' }), { attemptId: ATTEMPT, channel: 'web', uiMode: 'embedded', recovered: false });
  assert.deepEqual(await checkoutState(), {
    attempt_id: ATTEMPT, channel: 'web', ui_mode: 'embedded', claim_id: CLAIM_ONE, claim_kind: 'checkout',
  });
  await db.exec(uiModeMigration);
  assert.equal((await checkoutState()).ui_mode, 'embedded', 'A repeated migration cannot rewrite an embedded attempt as hosted.');
});

test('recovered Checkout attempts retain their original UI mode and channel through opposite requests', async () => {
  await claimCheckout({ uiMode: 'embedded' });
  assert.equal(await releaseCheckout(), true);
  assert.deepEqual(await checkoutState(), {
    attempt_id: ATTEMPT, channel: 'web', ui_mode: 'embedded', claim_id: null, claim_kind: null,
  });
  assert.deepEqual(await claimCheckout({ claimId: CLAIM_TWO, attemptId: '20000000-0000-4000-8000-000000000002', channel: 'app' }), {
    attemptId: ATTEMPT, channel: 'web', uiMode: 'embedded', recovered: true,
  });
  assert.equal(await releaseCheckout({ clearAttempt: true }), false, 'A stale Checkout worker cannot clear the recovered payload.');
  assert.equal((await checkoutState()).ui_mode, 'embedded');
  assert.equal(await releaseCheckout({ claimId: CLAIM_TWO, clearAttempt: true }), true);
  assert.deepEqual(await checkoutState(), { attempt_id: null, channel: null, ui_mode: null, claim_id: null, claim_kind: null });

  await claimCheckout({ channel: 'app' });
  await query(`update cafe_subscriptions set stripe_checkout_claim_expires_at = now() - interval '1 second' where user_id = $1`, [CAFE]);
  assert.deepEqual(await claimCheckout({ claimId: CLAIM_TWO, uiMode: 'embedded' }), {
    attemptId: ATTEMPT, channel: 'app', uiMode: 'hosted', recovered: true,
  });
});

test('invalid UI modes and fresh embedded app requests cannot create a durable attempt', async () => {
  for (const options of [{ uiMode: 'invalid' }, { uiMode: null }, { channel: 'app', uiMode: 'embedded' }]) {
    await db.exec('savepoint invalid_claim');
    await assert.rejects(claimCheckout(options), /Invalid Checkout claim/);
    await db.exec('rollback to savepoint invalid_claim');
    assert.deepEqual(await checkoutState(), { attempt_id: null, channel: null, ui_mode: null, claim_id: null, claim_kind: null });
  }
  await db.exec('savepoint invalid_mode');
  await assert.rejects(query(`update cafe_subscriptions set stripe_checkout_ui_mode = 'other' where user_id = $1`, [CAFE]), /stripe_checkout_ui_mode_check/);
  await db.exec('rollback to savepoint invalid_mode');
});

test('deletion settlement preserves an embedded attempt until the current unexpired deletion owner settles it', async () => {
  await claimCheckout({ uiMode: 'embedded' });
  const settle = async claimId => (await query(
    'select public.settle_stripe_checkout_attempt_for_deletion($1::uuid,$2::uuid) as result', [CAFE, claimId],
  )).rows[0].result;
  assert.equal(await settle(CLAIM_ONE), false, 'A Checkout claim cannot masquerade as account deletion.');
  await releaseCheckout();
  assert.equal((await query('select public.claim_stripe_deletion($1::uuid,$2::uuid) as result', [CAFE, CLAIM_TWO])).rows[0].result, 'claimed');
  assert.equal(await settle(CLAIM_ONE), false);
  assert.equal(await releaseCheckout({ clearAttempt: true }), false);
  assert.equal((await checkoutState()).ui_mode, 'embedded');
  await query(`update cafe_subscriptions set stripe_checkout_claim_expires_at = now() - interval '1 second' where user_id = $1`, [CAFE]);
  assert.equal(await settle(CLAIM_TWO), false);
  assert.equal((await checkoutState()).ui_mode, 'embedded');
  await query(`update cafe_subscriptions set stripe_checkout_claim_expires_at = now() + interval '1 minute' where user_id = $1`, [CAFE]);
  assert.equal(await settle(CLAIM_TWO), true);
  assert.deepEqual(await checkoutState(), { attempt_id: null, channel: null, ui_mode: null, claim_id: CLAIM_TWO, claim_kind: 'deletion' });
});

test('Checkout and deletion claims are fenced by their exact owners', async () => {
  const claimed = (await query(
    'select public.claim_stripe_checkout($1::uuid,$2::uuid,$3::uuid,$4::text) as result',
    [CAFE, CLAIM_ONE, ATTEMPT, 'web'],
  )).rows[0].result;
  assert.deepEqual(claimed, { attemptId: ATTEMPT, channel: 'web', uiMode: 'hosted', recovered: false });
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
