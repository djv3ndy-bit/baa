import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { randomUUID, randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import Stripe from 'stripe';

// Explicit, private test fixtures only. This runner never loads deployment env
// files, creates real charges, or sends email. Production is not an option.
const directory = process.argv[2];
const phase = process.argv[3];
if (!directory || !['checkout', 'clock-start', 'clock-renew', 'clock-cancel', 'refund', 'failed-payment', 'declined-payment', 'checkout-review', 'inspect'].includes(phase)) throw Error('Private test directory and supported phase required');
if ((statSync(directory).mode & 0o077) !== 0) throw Error('Owner-only test directory required');
function privateJSON(name) {
  const path = `${directory}/${name}`;
  if (statSync(path).mode & 0o077) throw Error('Owner-only test file required');
  return JSON.parse(readFileSync(path, 'utf8'));
}
const db = privateJSON('test-server.json');
const payments = privateJSON('stripe-test.json');
const fixtures = privateJSON('accounts.json');
const ref = 'iqtpsxxlpncaeabbcxht';
const origin = `https://${ref}.supabase.co`;
assert.equal(db.BJM_TEST_PROJECT_REF, ref); assert.equal(db.SUPABASE_URL, origin);
assert.equal(payments.BJM_TEST_PROJECT_REF, ref); assert.equal(fixtures.projectRef, ref);
assert.equal(payments.STRIPE_EXPECTED_ACCOUNT_ID, 'acct_1UANO72euSkBN6zq');
assert.equal(payments.STRIPE_PRICE_ID, 'price_1UEqOV2euSkBN6zqUJJE5G81');
if (!/^sb_secret_/.test(db.SUPABASE_SECRET_KEY || '') || !/^rk_test_[A-Za-z0-9]+$/.test(payments.STRIPE_RESTRICTED_KEY || '')
  || !/^pk_test_[A-Za-z0-9]+$/.test(payments.STRIPE_PUBLISHABLE_KEY || '')) throw Error('Valid test credentials required');
for (const key of Object.keys(process.env)) {
  if (/^(SUPABASE_|STRIPE_|APPLE_IAP_|GOOGLE_PLAY_|RESEND_|NATIVE_|BILLING_|PUBLIC_SITE_URL$)/.test(key)) delete process.env[key];
}
Object.assign(process.env, db, {
  VERCEL_ENV: 'preview', NATIVE_BILLING_ENVIRONMENT: 'Sandbox', NATIVE_PURCHASES_ENABLED: 'false',
  BILLING_ENABLED: 'true', STRIPE_LIVEMODE: 'false', PUBLIC_SITE_URL: 'http://127.0.0.1:3999',
  STRIPE_RESTRICTED_KEY: payments.STRIPE_RESTRICTED_KEY, STRIPE_PUBLISHABLE_KEY: payments.STRIPE_PUBLISHABLE_KEY,
  STRIPE_ACCOUNT_ID: payments.STRIPE_EXPECTED_ACCOUNT_ID, STRIPE_MONTHLY_PRICE_ID: payments.STRIPE_PRICE_ID,
});
const originalFetch = globalThis.fetch;
const requestObservations = [];
globalThis.fetch = async (input, options = {}) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (url.origin !== origin) throw Error('Only the isolated database is available to app fetch calls');
  const response = await originalFetch(input, { ...options, redirect: 'error' });
  requestObservations.push({path:url.pathname,status:response.status});
  if (!response.ok) {
    const record = { phase, databaseRequest: url.pathname, status: response.status };
    try { const body = await response.clone().json(); if (/^[A-Z0-9_]{3,16}$/.test(body.code || '')) record.databaseCode = body.code; } catch {}
    console.log(JSON.stringify(record));
  }
  return response;
};
const statePath = `${directory}/stripe-lifecycle-state.json`;
const state = existsSync(statePath) ? privateJSON('stripe-lifecycle-state.json') : {
  runId: randomUUID(), projectRef: ref, createdAt: new Date().toISOString(),
  webhookSecret: `whsec_${randomBytes(32).toString('hex')}`, checks: [], objects: {},
};
assert.equal(state.projectRef, ref);
function save() { writeFileSync(statePath, JSON.stringify(state, null, 2), { mode: 0o600 }); }
save();
process.env.STRIPE_WEBHOOK_SECRET = state.webhookSecret;
const { stripeClient, stripeErrorDiagnostics, adminRows, subscriptionFor } = await import('../../api/_billing.js');
const { default: billing } = await import('../../api/billing.js');
const { default: accountBilling } = await import('../../api/account-billing.js');
const { websiteBillingAllowsNative } = await import('../../server/native-billing/checkoutService.mjs');
const tokens = new Map();
function fixture(label) {
  const account = fixtures.accounts.find(row => row.label === label);
  assert.ok(account && account.email.endsWith('@example.invalid'));
  return account;
}
async function token(label) {
  if (!tokens.has(label)) {
    const user = fixture(label);
    const result = await fetch(`${origin}/auth/v1/token?grant_type=password`, {
      method: 'POST', headers: { apikey: db.SUPABASE_PUBLISHABLE_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: user.email, password: user.password }),
    });
    const session = await result.json(); assert.equal(result.status, 200); assert.equal(session.user.id, user.id);
    tokens.set(label, session.access_token);
    if (user.role === 'cafe_owner_manager') {
      const initialized = await fetch(`${origin}/rest/v1/rpc/ensure_cafe_subscription`, {
        method: 'POST', headers: { apikey: db.SUPABASE_PUBLISHABLE_KEY,
          authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json' }, body: '{}',
      });
      assert.equal(initialized.status, 200);
    }
  }
  return tokens.get(label);
}
async function call(label, action, body, handler = billing) {
  const result = { status: 0, body: null };
  const raw = body === undefined ? '' : JSON.stringify(body);
  const req = { method: body === undefined ? 'GET' : 'POST', query: { action },
    url: `/api/billing?action=${action}`, body,
    headers: { authorization: `Bearer ${await token(label)}`, 'content-type': 'application/json' },
    async *[Symbol.asyncIterator]() { yield Buffer.from(raw); },
  };
  const res = { setHeader() {}, status(code) { result.status = code; return this; },
    json(value) { result.body = value; return this; }, send(value) { result.body = value; return this; } };
  await handler(req, res); return result;
}
function check(name, condition, details = {}) {
  const record = { phase, name, status: condition ? 'Passed' : 'Failed', ...details, at: new Date().toISOString() };
  state.checks.push(record); save(); console.log(JSON.stringify(record));
  assert.ok(condition, name);
}
async function rpc(name, body) { return adminRows(`rpc/${name}`, { method: 'POST', body: JSON.stringify(body) }); }
async function deliver(event) {
  assert.equal(event.livemode, false);
  const raw = JSON.stringify(event);
  const signature = Stripe.webhooks.generateTestHeaderString({ payload: raw, secret: state.webhookSecret });
  const result = { status: 0, body: null };
  await billing({ method: 'POST', query: { action: 'webhook' }, headers: { 'stripe-signature': signature },
    async *[Symbol.asyncIterator]() { yield Buffer.from(raw); } }, {
    setHeader() {}, status(code) { result.status = code; return this; },
    json(value) { result.body = value; return this; }, send(value) { result.body = value; return this; },
  });
  return result;
}
async function subscriptionEvents(stripe, subscriptionId) {
  const events = await stripe.events.list({ types: ['customer.subscription.created','customer.subscription.updated','customer.subscription.deleted'], limit: 100 });
  return events.data.filter(event => event.data.object.id === subscriptionId).sort((a,b) => a.created-b.created || a.id.localeCompare(b.id));
}
async function reconcileEvents(stripe, subscriptionId) {
  const events = await subscriptionEvents(stripe, subscriptionId);
  assert.ok(events.length);
  for (const event of events) {
    const response = await deliver(event);
    check(`Provider event ${event.type} handled`, response.status === 200, { eventId: event.id, delivery: 'Actual Stripe event; locally signed HTTP-handler invocation' });
  }
  const replay = await deliver(events.at(-1));
  check('Repeated provider event is acknowledged without duplicate processing', replay.status === 200 && replay.body.duplicate === true);
}
async function advanceClock(stripe, target) {
  const id = state.objects.clock.id;
  let clock = await stripe.testHelpers.testClocks.retrieve(id);
  assert.equal(clock.livemode, false);
  if (clock.status === 'ready' && clock.frozen_time < target) {
    clock = await stripe.testHelpers.testClocks.advance(id, { frozen_time: target }, { idempotencyKey: `${state.runId}-advance-${target}` });
  }
  for (let attempt = 0; attempt < 25 && clock.status === 'advancing'; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    clock = await stripe.testHelpers.testClocks.retrieve(id);
  }
  assert.equal(clock.status, 'ready'); assert.ok(clock.frozen_time >= target);
}
async function invoiceEvents(stripe, subscriptionId) {
  const events = await stripe.events.list({ types: ['invoice.paid','invoice.payment_failed'], limit: 100 });
  const owned = events.data.filter(event => {
    const invoice = event.data.object;
    return (invoice.subscription || invoice.parent?.subscription_details?.subscription) === subscriptionId;
  });
  for (const event of owned.sort((a,b) => a.created-b.created)) {
    const result = await deliver(event);
    check(`Actual ${event.type} recorded`, result.status === 200, { eventId: event.id, delivery: 'Locally signed handler invocation' });
  }
  return owned;
}

try {
  const stripe = await stripeClient();
  check('Restricted test credential validates approved monthly plan', true);
  if (phase === 'checkout') {
    const createSession = stripe.checkout.sessions.create.bind(stripe.checkout.sessions);
    stripe.checkout.sessions.create = async (...args) => {
      try { return await createSession(...args); }
      catch (error) {
        // Retain only sanitized provider configuration guidance, never request
        // bodies, response headers, client secrets, keys, or payment details.
        const message = String(error?.message || '').replace(/\b(?:[psr]k_(?:test|live)_|whsec_|sb_secret_)[A-Za-z0-9_-]+/g, '[credential]')
          .replace(/https?:\/\/\S+/g, '[provider documentation]').replace(/\b(?:cus|sub|cs|pi|pm|acct)_[A-Za-z0-9_]+/g, '[object]')
          .replace(/[^\s@]+@[^\s@]+/g, '[email]').slice(0, 800);
        state.checkoutConfigurationError = { ...stripeErrorDiagnostics(error), message }; save();
        console.log(JSON.stringify({ checkoutConfigurationError: state.checkoutConfigurationError }));
        throw error;
      }
    };
    const cafe = fixture('cafe');
    const current = await subscriptionFor(cafe.id);
    assert.ok(!current?.stripe_subscription_id, 'Existing subscription must not be replaced');
    const status = await call('cafe', 'status', undefined, accountBilling);
    check('Unsubscribed café starts Free', status.status === 200 && status.body.plan === 'free');
    const roleDenied = await call('barista', 'checkout', { uiMode: 'embedded' });
    check('Barista cannot start café checkout', [401,403].includes(roleDenied.status));
    const attempts = await Promise.all([call('cafe', 'checkout', { uiMode: 'embedded' }), call('cafe', 'checkout', { uiMode: 'embedded' })]);
    state.checkoutResponses = attempts; save();
    check('Repeated concurrent checkout requests complete or report an existing request', attempts.every(r => [200,409].includes(r.status)) && attempts.some(r => r.status === 200), { responseStatuses: attempts.map(r => r.status) });
    const billingRow = await subscriptionFor(cafe.id);
    const sessions = await stripe.checkout.sessions.list({ customer: billingRow.stripe_customer_id, status: 'open', limit: 10 });
    const owned = sessions.data.filter(s => s.metadata?.cafe_user_id === cafe.id);
    check('Exactly one open checkout exists for the café', owned.length === 1);
    const session = await stripe.checkout.sessions.retrieve(owned[0].id, { expand: ['line_items'] });
    check('Checkout uses the account-bound $9.99 monthly sandbox price', session.livemode === false && session.client_reference_id === cafe.id && session.line_items.data[0].price.id === payments.STRIPE_PRICE_ID && session.line_items.data[0].quantity === 1);
    state.objects.checkout = { id: session.id, customerId: billingRow.stripe_customer_id, cafeId: cafe.id }; save();
    const repeated = await call('cafe', 'checkout', { uiMode: 'embedded' });
    check('A later tap reuses the same checkout', repeated.status === 200 && repeated.body.sessionId === session.id && repeated.body.reused === true);
    const pending = await call('cafe', 'confirm', { sessionId: session.id });
    check('Open checkout cannot activate paid access', pending.status === 202 && pending.body.confirmed === false);
    const wrongAccount = await call('other-cafe', 'confirm', { sessionId: session.id });
    check('Another café cannot claim the checkout', [404,409].includes(wrongAccount.status));
    const after = await call('cafe', 'status', undefined, accountBilling);
    check('Account remains Free before payment verification', after.status === 200 && after.body.plan === 'free');
  }
  if (phase === 'clock-start') {
    const cafe = fixture('other-cafe');
    await token('other-cafe');
    if (!state.objects.clock) {
      const clock = await stripe.testHelpers.testClocks.create({ frozen_time: Math.floor(Date.now()/1000), name: `BaristaMatch lifecycle ${state.runId}` }, { idempotencyKey: `${state.runId}-clock` });
      assert.equal(clock.livemode, false); state.objects.clock = { id: clock.id, initialTime: clock.frozen_time }; save();
    }
    if (!state.objects.clockCustomer) {
      const row = await subscriptionFor(cafe.id); assert.ok(row && !row.stripe_customer_id && !row.stripe_subscription_id);
      const customer = await stripe.customers.create({ name: 'BaristaMatch synthetic lifecycle café', test_clock: state.objects.clock.id,
        payment_method: 'pm_card_visa', invoice_settings: { default_payment_method: 'pm_card_visa' },
        metadata: { cafe_user_id: cafe.id, bjm_test_run: state.runId } }, { idempotencyKey: `${state.runId}-clock-customer` });
      assert.equal(customer.livemode, false); state.objects.clockCustomer = { id: customer.id, cafeId: cafe.id }; save();
    }
    const customerId = state.objects.clockCustomer.id;
    const row = await subscriptionFor(cafe.id);
    if (!row.stripe_customer_id) {
      const claimId = randomUUID();
      const claimed = await rpc('claim_stripe_checkout', { p_user_id:cafe.id, p_claim_id:claimId, p_attempt_id:randomUUID(), p_channel:'web', p_ui_mode:'hosted' });
      assert.ok(claimed);
      const attached = await rpc('attach_stripe_checkout_customer', { p_user_id:cafe.id, p_claim_id:claimId, p_customer_id:customerId });
      assert.ok(['attached','owned'].includes(attached));
      await rpc('release_stripe_checkout', { p_user_id:cafe.id, p_claim_id:claimId, p_clear_attempt:true });
    } else assert.equal(row.stripe_customer_id, customerId);
    if (!state.objects.clockSubscription) {
      const subscription = await stripe.subscriptions.create({ customer: customerId, items:[{price:payments.STRIPE_PRICE_ID}], metadata:{cafe_user_id:cafe.id,bjm_test_run:state.runId}, payment_behavior:'error_if_incomplete' }, { idempotencyKey:`${state.runId}-subscription` });
      assert.equal(subscription.livemode,false); state.objects.clockSubscription = { id:subscription.id, periodEnd:subscription.items.data[0].current_period_end }; save();
    }
    const subscription = await stripe.subscriptions.retrieve(state.objects.clockSubscription.id);
    check('Stripe sandbox purchase succeeds with the documented test payment method', subscription.status === 'active' && subscription.livemode === false);
    await reconcileEvents(stripe, subscription.id);
    const combined = await call('other-cafe','status',undefined,accountBilling);
    check('Verified website subscription grants shared Pro status', combined.status===200 && combined.body.plan==='pro');
    const duplicate = await call('other-cafe','checkout',{uiMode:'embedded'});
    check('Existing website subscription blocks a second checkout', duplicate.status===409);
    const canBuyNative = await websiteBillingAllowsNative({userId:cafe.id,subscription:await subscriptionFor(cafe.id),stripe,liveMode:false});
    check('Existing website subscription blocks a duplicate native subscription', canBuyNative === false);
  }
  if (phase === 'clock-renew') {
    const subscriptionId = state.objects.clockSubscription.id;
    const end = state.objects.clockSubscription.periodEnd;
    await advanceClock(stripe, end);
    await advanceClock(stripe, end + 7200);
    const subscription = await stripe.subscriptions.retrieve(subscriptionId);
    const invoices = await stripe.invoices.list({ customer: state.objects.clockCustomer.id, subscription: subscriptionId, limit: 10 });
    const paid = invoices.data.filter(invoice => invoice.status === 'paid' && invoice.amount_paid === 999 && invoice.livemode === false);
    check('Sandbox renewal produces a second paid $9.99 invoice', paid.length >= 2, { invoices: invoices.data.map(i => ({ id:i.id,status:i.status,amountPaid:i.amount_paid })) });
    check('Subscription remains active with a later renewal date', subscription.status === 'active' && subscription.items.data[0].current_period_end > end);
    await reconcileEvents(stripe, subscriptionId);
    const events = await invoiceEvents(stripe, subscriptionId);
    check('Actual invoice payment events are available', events.length >= 2);
    const combined = await call('other-cafe','status',undefined,accountBilling);
    check('Renewal keeps shared Pro access and updates the billing date', combined.status === 200 && combined.body.plan === 'pro' && Date.parse(combined.body.currentPeriodEnd) > end * 1000);
    state.objects.clockSubscription.renewedPeriodEnd = subscription.items.data[0].current_period_end; save();
  }
  if (phase === 'clock-cancel') {
    const id = state.objects.clockSubscription.id;
    let subscription = await stripe.subscriptions.retrieve(id);
    if (!state.objects.clockSubscription.cancelPeriodEnd) {
      assert.equal(subscription.status,'active');
      subscription = await stripe.subscriptions.update(id, {cancel_at_period_end:true}, {idempotencyKey:`${state.runId}-cancel-at-end`});
      state.objects.clockSubscription.cancelPeriodEnd = subscription.items.data[0].current_period_end; save();
    }
    await reconcileEvents(stripe,id);
    const before = await call('other-cafe','status',undefined,accountBilling);
    check('Cancellation preserves paid access through the purchased period', before.status===200 && before.body.plan==='pro' && before.body.cancelAtPeriodEnd===true);
    await advanceClock(stripe,state.objects.clockSubscription.cancelPeriodEnd+1);
    subscription = await stripe.subscriptions.retrieve(id);
    check('Stripe cancels at the scheduled period end', subscription.status==='canceled');
    await reconcileEvents(stripe,id);
    const after = await call('other-cafe','status',undefined,accountBilling);
    check('Expired canceled subscription returns shared access to Free', after.status===200 && after.body.plan==='free');
    const sourceEvents = await subscriptionEvents(stripe,id);
    const original = sourceEvents.find(event => event.type==='customer.subscription.created');
    assert.ok(original); await deliver(original);
    const replayed = await call('other-cafe','status',undefined,accountBilling);
    check('Replaying an old purchase event cannot reactivate canceled access', replayed.status===200 && replayed.body.plan==='free');
  }
  if (phase === 'refund') {
    const customerId = state.objects.clockCustomer.id;
    if (!state.objects.refund) {
      const charges = await stripe.charges.list({customer:customerId,limit:10});
      const charge = charges.data.find(row => row.paid && !row.refunded && row.amount===999 && row.livemode===false && row.customer===customerId);
      assert.ok(charge);
      const linked = await stripe.invoicePayments.list({payment:{type:'payment_intent',payment_intent:charge.payment_intent},status:'paid',limit:2});
      assert.equal(linked.data.length,1);
      const invoice = await stripe.invoices.retrieve(linked.data[0].invoice);
      assert.equal(invoice.parent?.subscription_details?.subscription || invoice.subscription,state.objects.clockSubscription.id);
      const refund = await stripe.refunds.create({charge:charge.id,amount:999,metadata:{bjm_test_run:state.runId}}, {idempotencyKey:`${state.runId}-refund`});
      state.objects.refund = {id:refund.id,chargeId:charge.id,status:refund.status}; save();
    }
    const refund = await stripe.refunds.retrieve(state.objects.refund.id);
    check('A sandbox refund succeeds for the verified synthetic subscription charge', refund.status==='succeeded' && refund.amount===999 && refund.charge===state.objects.refund.chargeId);
    const events = await stripe.events.list({type:'charge.refunded',limit:100});
    const event = events.data.find(row => row.data.object.id===state.objects.refund.chargeId);
    assert.ok(event);
    const first = await deliver(event), repeat = await deliver(event);
    check('Refund event and replay are accepted exactly once', first.status===200 && repeat.status===200 && repeat.body.duplicate===true);
    const records = await adminRows(`subscription_payments?provider_payment_id=eq.${encodeURIComponent(`refund:${state.objects.refund.chargeId}`)}&select=amount_cents,status&limit=2`);
    check('Exactly one matching refund record persists', records.length===1 && records[0].amount_cents===999 && records[0].status==='refunded');
    const status = await call('other-cafe','status',undefined,accountBilling);
    check('Refund processing does not reactivate the canceled subscription', status.status===200 && status.body.plan==='free');
  }
  if (['failed-payment','declined-payment'].includes(phase)) {
    const stateKey = phase === 'declined-payment' ? 'declinedSubscription' : 'failedSubscription';
    const customerId = state.objects.clockCustomer.id;
    const cafeId = state.objects.clockCustomer.cafeId;
    if (!state.objects.failedPaymentMethod) {
      const method = await stripe.paymentMethods.attach('pm_card_chargeCustomerFail',{customer:customerId},{idempotencyKey:`${state.runId}-decline-method`});
      assert.equal(method.livemode,false); state.objects.failedPaymentMethod={id:method.id};save();
    }
    if (!state.objects[stateKey]) {
      const subscription = await stripe.subscriptions.create({customer:customerId,items:[{price:payments.STRIPE_PRICE_ID}],
        default_payment_method:state.objects.failedPaymentMethod.id,payment_behavior:phase === 'declined-payment'?'allow_incomplete':'default_incomplete',
        metadata:{cafe_user_id:cafeId,bjm_test_run:state.runId}}, {idempotencyKey:`${state.runId}-${stateKey}`});
      state.objects[stateKey]={id:subscription.id,created:subscription.created};save();
    }
    let subscription = await stripe.subscriptions.retrieve(state.objects[stateKey].id);
    check(phase === 'declined-payment' ? 'Declined test payment leaves the subscription incomplete' : 'Unconfirmed first invoice leaves the subscription incomplete', subscription.status==='incomplete' && subscription.livemode===false);
    await reconcileEvents(stripe,subscription.id);
    const paymentEvents = await invoiceEvents(stripe,subscription.id);
    if (phase === 'declined-payment') check('Stripe reports an actual invoice.payment_failed event',paymentEvents.some(event => event.type==='invoice.payment_failed'));
    const status = await call('other-cafe','status',undefined,accountBilling);
    check('Failed payment grants no Pro access and retains billing management', status.status===200 && status.body.plan==='free' && status.body.canManageBilling===true);
    const duplicate = await call('other-cafe','checkout',{uiMode:'embedded'});
    check('Unsettled failed payment prevents a second checkout', duplicate.status===409);
    const canBuyNative = await websiteBillingAllowsNative({userId:cafeId,subscription:await subscriptionFor(cafeId),stripe,liveMode:false});
    check('Unsettled failed payment prevents a duplicate native purchase', canBuyNative===false);
    await advanceClock(stripe,state.objects[stateKey].created+86400);
    subscription = await stripe.subscriptions.retrieve(subscription.id);
    check('Unpaid subscription eventually expires in Stripe', subscription.status==='incomplete_expired');
    await reconcileEvents(stripe,subscription.id);
    const expired = await call('other-cafe','status',undefined,accountBilling);
    check('Expired failed payment remains Free', expired.status===200 && expired.body.plan==='free');
  }
  if (phase === 'checkout-review') {
    // Inspect the existing checkout only. Completion is a separate browser handoff.
    const session = await stripe.checkout.sessions.retrieve(state.objects.checkout.id);
    assert.equal(session.livemode, false);
    assert.equal(session.client_reference_id, fixture('cafe').id);
    console.log(JSON.stringify({phase, checkoutStatus:session.status, paymentStatus:session.payment_status}));
    state.browserCheckout = {status:session.status, paymentStatus:session.payment_status, checkedAt:new Date().toISOString()};
    save();
    const beforeRoleCheck = requestObservations.length;
    const baristaStatus = await call('barista','status');
    const roleRequests = requestObservations.slice(beforeRoleCheck);
    check('Authenticated barista is denied café billing status', baristaStatus.status === 401
      && roleRequests.some(row => row.path === '/auth/v1/user' && row.status === 200)
      && roleRequests.some(row => row.path === '/rest/v1/profiles' && row.status === 200)
      && roleRequests.every(row => row.status < 400),
      {httpStatus:baristaStatus.status,verificationRequests:roleRequests});
    const status = await call('cafe','status',undefined,accountBilling);
    check('Shared account status remains available',status.status===200,{plan:status.body?.plan});
    if (session.payment_status === 'unpaid') {
      check('Unsubmitted browser checkout leaves the test café Free',status.body.plan==='free');
    }
    if (session.status === 'complete' && session.payment_status === 'paid') {
      check('User-completed browser purchase grants shared Pro access',status.body.plan==='pro');
      const subscription = await stripe.subscriptions.retrieve(session.subscription,{expand:['latest_invoice']});
      const invoice = subscription.latest_invoice;
      check('Browser checkout created an active test subscription and paid invoice',subscription.livemode===false
        && subscription.status==='active' && invoice && typeof invoice!=='string'
        && invoice.livemode===false && invoice.status==='paid'
        && invoice.currency==='usd' && invoice.amount_paid===999,
        {subscriptionId:subscription.id,invoiceId:invoice?.id,amountPaidCents:invoice?.amount_paid});
      const subscriptions = await stripe.subscriptions.list({customer:session.customer,status:'all',limit:100});
      check('The browser purchase created exactly one active subscription for this café',!subscriptions.has_more
        && subscriptions.data.filter(row=>row.status==='active').length===1);
      const allowed = await websiteBillingAllowsNative({userId:fixture('cafe').id,
        subscription:await subscriptionFor(fixture('cafe').id),stripe,liveMode:false});
      check('The browser subscriber cannot buy duplicate native access',allowed===false);
      state.browserCheckout.subscriptionId=subscription.id;
      state.browserCheckout.invoiceId=invoice.id;
      state.browserCheckout.amountPaidCents=invoice.amount_paid;
      save();
    }
  }
  if (phase === 'inspect') {
    for (const label of ['cafe','barista','other-cafe']) {
      const status = await call(label,'status',undefined,accountBilling);
      console.log(JSON.stringify({label,httpStatus:status.status,plan:status.body?.plan,status:status.body?.status}));
    }
  }
} catch (error) {
  const failure = {phase,status:'Failed',errorType:error?.name,frames:String(error?.stack||'').split('\n').slice(1,4),diagnostics:stripeErrorDiagnostics(error),assertion:error?.code==='ERR_ASSERTION'?String(error.message).slice(0,240):undefined};
  state.checks.push(failure);save();console.error(JSON.stringify(failure));process.exitCode=1;
}
