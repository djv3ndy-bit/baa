import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import handler from "../api/billing.js";
import { stripeApiClient } from "../api/_billing.js";

const SECRET = "whsec_test_webhook_secret";
const CAFE_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_CAFE_ID = "22222222-2222-4222-8222-222222222222";

function signature(payload, secret = SECRET) {
  const timestamp = Math.floor(Date.now() / 1000);
  const digest = createHmac("sha256", secret).update(`${timestamp}.${payload}`).digest("hex");
  return `t=${timestamp},v1=${digest}`;
}

function request(payload, header = signature(payload)) {
  return {
    method: "POST",
    url: "/api/billing?action=webhook",
    query: { action: "webhook" },
    headers: { "stripe-signature": header },
    async *[Symbol.asyncIterator]() { yield Buffer.from(payload); },
  };
}

function actionRequest(action, body = {}) {
  const payload = JSON.stringify(body);
  return {
    method: "POST",
    url: `/api/billing?action=${action}`,
    query: { action },
    headers: { authorization: "Bearer cafe-session", host: "www.baristajobmatch.com" },
    async *[Symbol.asyncIterator]() { yield Buffer.from(payload); },
  };
}

function statusRequest() {
  return {
    method: "GET",
    url: "/api/billing?action=status",
    query: { action: "status" },
    headers: { authorization: "Bearer cafe-session", host: "www.baristajobmatch.com" },
    async *[Symbol.asyncIterator]() {},
  };
}

function response() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(name, value) { this.headers[name] = value; },
    status(value) { this.statusCode = value; return this; },
    json(value) { this.body = value; return this; },
    send(value) { this.body = value; return this; },
  };
}

function setup(t, fetchImpl) {
  const oldFetch = globalThis.fetch;
  const keys = ["STRIPE_RESTRICTED_KEY", "STRIPE_LIVEMODE", "STRIPE_WEBHOOK_SECRET", "STRIPE_MONTHLY_PRICE_ID", "STRIPE_ACCOUNT_ID", "BILLING_ENABLED", "PUBLIC_SITE_URL", "SUPABASE_URL", "SUPABASE_PUBLISHABLE_KEY", "SUPABASE_SECRET_KEY"];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  Object.assign(process.env, {
    STRIPE_RESTRICTED_KEY: "rk_test_mock_only",
    STRIPE_LIVEMODE: "false",
    STRIPE_WEBHOOK_SECRET: SECRET,
    STRIPE_MONTHLY_PRICE_ID: "price_baristamatch",
    STRIPE_ACCOUNT_ID: "acct_baristamatch",
    BILLING_ENABLED: "true",
    PUBLIC_SITE_URL: "https://www.baristajobmatch.com",
    SUPABASE_URL: "https://project.supabase.co",
    SUPABASE_PUBLISHABLE_KEY: "publishable_test",
    SUPABASE_SECRET_KEY: "sb_secret_test",
  });
  globalThis.fetch = fetchImpl;
  const stripe = stripeApiClient();
  replaceMethod(t, stripe.prices, "retrieve", async () => ({
    id: "price_baristamatch",
    active: true,
    livemode: false,
    currency: "usd",
    unit_amount: 999,
    type: "recurring",
    recurring: { interval: "month", interval_count: 1 },
    metadata: { application: "baristamatch", plan: "cafe_monthly", stripe_account_id: "acct_baristamatch" },
  }));
  t.after(() => {
    globalThis.fetch = oldFetch;
    for (const key of keys) previous[key] === undefined ? delete process.env[key] : process.env[key] = previous[key];
  });
}

function replaceMethod(t, target, name, implementation) {
  const hadOwnMethod = Object.hasOwn(target, name);
  const previous = target[name];
  target[name] = implementation;
  t.after(() => {
    if (hadOwnMethod) target[name] = previous;
    else delete target[name];
  });
}

function eventPayload(id = "evt_handler_test", type = "ping", object = {}, created = 1_800_000_000) {
  return JSON.stringify({ id, object: "event", type, created, data: { object } });
}

function databaseRecorder(calls, initialBilling = null) {
  let billing = initialBilling ? { ...initialBilling } : null;
  return async (url, init = {}) => {
    const method = init.method || "GET";
    const target = String(url);
    calls.push({ url: target, method, body: init.body });
    if (target.endsWith("/rpc/claim_stripe_webhook_event")) return new Response(JSON.stringify("claimed"));
    if (target.endsWith("/rpc/complete_stripe_webhook_event")) return new Response("true");
    if (target.endsWith("/rpc/fail_stripe_webhook_event")) return new Response("true");
    if (target.endsWith("/rpc/sync_stripe_subscription")) {
      const payload = JSON.parse(init.body);
      if (payload.p_authoritative && billing && (
        billing.stripe_subscription_event_created_at !== payload.p_expected_event_created_at ||
        billing.stripe_subscription_sync_revision !== payload.p_expected_revision
      )) return new Response("false");
      if (!payload.p_authoritative && billing) {
        if (billing.stripe_subscription_event_created_at > payload.p_event_created_at) return new Response("true");
        const rank = status => ({ canceled: 4, expired: 4, past_due: 3, active: 2, trialing: 2 }[status] || 1);
        if (
          billing.stripe_subscription_event_created_at === payload.p_event_created_at &&
          billing.stripe_subscription_id === payload.p_subscription_id &&
          (
            rank(payload.p_status) < rank(billing.status) ||
            (
              rank(payload.p_status) === rank(billing.status) &&
              billing.cancel_at_period_end &&
              !payload.p_cancel_at_period_end
            )
          )
        ) return new Response("true");
      }
      if (
        payload.p_authoritative &&
        billing?.stripe_customer_id === payload.p_customer_id &&
        billing?.stripe_subscription_id === payload.p_subscription_id &&
        billing?.stripe_subscription_created_at === payload.p_subscription_created_at &&
        billing?.status === payload.p_status &&
        billing?.current_period_end === payload.p_current_period_end &&
        billing?.cancel_at_period_end === payload.p_cancel_at_period_end
      ) return new Response("true");
      billing = {
        user_id: payload.p_user_id,
        stripe_customer_id: payload.p_customer_id,
        stripe_subscription_id: payload.p_subscription_id,
        stripe_subscription_created_at: payload.p_subscription_created_at,
        status: payload.p_status,
        current_period_end: payload.p_current_period_end,
        cancel_at_period_end: payload.p_cancel_at_period_end,
        stripe_subscription_event_created_at: payload.p_authoritative
          ? billing?.stripe_subscription_event_created_at ?? payload.p_event_created_at
          : payload.p_event_created_at,
        stripe_subscription_sync_revision: (billing?.stripe_subscription_sync_revision || 0) + 1,
      };
      return new Response("true");
    }
    if (target.endsWith("/rpc/record_stripe_subscription_payment")) return new Response("true");
    if (method === "GET" && target.includes("/cafe_subscriptions?")) return new Response(JSON.stringify(billing ? [billing] : []));
    if (method === "PATCH") return new Response("[{}]");
    return new Response(method === "GET" ? "[]" : "", { status: method === "POST" ? 201 : 200 });
  };
}

test("billing status fails closed when a subscription is missing either owned Stripe identifier", async (t) => {
  const subscription = {
    user_id: CAFE_ID,
    status: "active",
    stripe_customer_id: null,
    stripe_subscription_id: "sub_orphaned",
    current_period_end: "2026-10-08T00:00:00.000Z",
    cancel_at_period_end: false,
    complimentary_access: true,
  };
  setup(t, async (url) => {
    const target = String(url);
    if (target.endsWith("/auth/v1/user")) return new Response(JSON.stringify({ id: CAFE_ID, email: "cafe@example.com" }));
    if (target.includes("/rest/v1/profiles?")) return new Response(JSON.stringify([{ role: "cafe_owner_manager", cafe_name: "Test Café", display_name: null, suspended_at: null }]));
    if (target.includes("/rest/v1/cafe_subscriptions?")) return new Response(JSON.stringify([subscription]));
    throw new Error(`Unexpected database request: ${target}`);
  });

  const orphaned = response();
  await handler(statusRequest(), orphaned);
  assert.equal(orphaned.statusCode, 200);
  assert.equal(orphaned.body.connectedToBilling, false);
  assert.equal(orphaned.body.canManageBilling, false);
  assert.equal(orphaned.body.plan, "free");

  subscription.stripe_customer_id = "cus_owned";
  const connected = response();
  await handler(statusRequest(), connected);
  assert.equal(connected.statusCode, 200);
  assert.equal(connected.body.connectedToBilling, true);
  assert.equal(connected.body.canManageBilling, true);
  assert.equal(connected.body.plan, "pro");
});

test("Checkout reconciles an ambiguous Customer attachment, uses a fenced attempt, and expires older Sessions", async (t) => {
  const databaseCalls = [];
  let billingReads = 0;
  setup(t, async (url, init = {}) => {
    const target = String(url);
    const body = init.body ? JSON.parse(init.body) : null;
    databaseCalls.push({ target, method: init.method || "GET", body });
    if (target.endsWith("/auth/v1/user")) return new Response(JSON.stringify({ id: CAFE_ID, email: "cafe@example.com" }));
    if (target.includes("/rest/v1/profiles?")) return new Response(JSON.stringify([{ role: "cafe_owner_manager", cafe_name: "Test Café", display_name: null, suspended_at: null }]));
    if (target.includes("/rest/v1/cafe_subscriptions?")) {
      billingReads += 1;
      return new Response(JSON.stringify([{ user_id: CAFE_ID, status: "free", stripe_customer_id: billingReads > 1 ? "cus_checkout" : null, stripe_subscription_id: null, stripe_subscription_event_created_at: null, stripe_subscription_sync_revision: 0 }]));
    }
    if (target.endsWith("/rpc/claim_stripe_checkout")) return new Response(JSON.stringify({ attemptId: body.p_attempt_id, channel: body.p_channel, recovered: false }));
    if (target.endsWith("/rpc/stripe_checkout_claim_is_current")) return new Response("true");
    if (target.endsWith("/rpc/attach_stripe_checkout_customer")) throw new TypeError("simulated lost attachment response");
    if (target.endsWith("/rpc/release_stripe_checkout")) return new Response("true");
    throw new Error(`Unexpected database request: ${target}`);
  });

  const stripe = stripeApiClient();
  const expired = [];
  const sessionLists = [];
  let createdSession;
  let createdOptions;
  replaceMethod(t, stripe.customers, "create", async () => ({ id: "cus_checkout", metadata: { cafe_user_id: CAFE_ID } }));
  replaceMethod(t, stripe.customers, "del", async () => assert.fail("an attached Customer must not be deleted"));
  replaceMethod(t, stripe.subscriptions, "list", async (options) => {
    assert.deepEqual(options, { customer: "cus_checkout", status: "all", limit: 100 });
    return { data: [], has_more: false };
  });
  replaceMethod(t, stripe.checkout.sessions, "list", async (options) => {
    sessionLists.push(options);
    if (!options.starting_after) return { data: [{ id: "cs_legacy", mode: "subscription" }], has_more: true };
    return { data: [{ id: "cs_other", mode: "subscription" }, { id: "cs_payment", mode: "payment" }], has_more: false };
  });
  replaceMethod(t, stripe.checkout.sessions, "expire", async (id) => { expired.push(id); return { id, status: "expired" }; });
  replaceMethod(t, stripe.checkout.sessions, "create", async (params, options) => {
    createdSession = params;
    createdOptions = options;
    return { id: "cs_new", url: "https://checkout.stripe.com/c/pay/cs_new" };
  });

  const res = response();
  await handler(actionRequest("checkout"), res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { url: "https://checkout.stripe.com/c/pay/cs_new" });
  assert.equal(billingReads, 2);
  assert.deepEqual(expired.sort(), ["cs_legacy", "cs_other"]);
  assert.equal(sessionLists.length, 2);
  assert.equal(sessionLists[1].starting_after, "cs_legacy");
  assert.equal(createdSession.customer, "cus_checkout");
  assert.deepEqual(createdSession.line_items, [{ price: "price_baristamatch", quantity: 1 }]);
  assert.equal("payment_method_types" in createdSession, false);
  const claim = databaseCalls.find(({ target }) => target.endsWith("/rpc/claim_stripe_checkout")).body;
  assert.equal(createdOptions.idempotencyKey, `baristamatch-checkout-${CAFE_ID}-${claim.p_attempt_id}`);
  assert.equal(databaseCalls.filter(({ target }) => target.endsWith("/rpc/stripe_checkout_claim_is_current")).length, 2);
  const attachment = databaseCalls.find(({ target }) => target.endsWith("/rpc/attach_stripe_checkout_customer")).body;
  assert.deepEqual(attachment, { p_user_id: CAFE_ID, p_claim_id: claim.p_claim_id, p_customer_id: "cus_checkout" });
  const release = databaseCalls.find(({ target }) => target.endsWith("/rpc/release_stripe_checkout")).body;
  assert.deepEqual(release, { p_user_id: CAFE_ID, p_claim_id: claim.p_claim_id, p_clear_attempt: true });
});

test("a recovered Checkout attempt reuses its metadata-owned Customer instead of creating a duplicate", async (t) => {
  const databaseCalls = [];
  setup(t, async (url, init = {}) => {
    const target = String(url);
    const body = init.body ? JSON.parse(init.body) : null;
    databaseCalls.push({ target, body });
    if (target.endsWith("/auth/v1/user")) return new Response(JSON.stringify({ id: CAFE_ID, email: "cafe@example.com" }));
    if (target.includes("/rest/v1/profiles?")) return new Response(JSON.stringify([{ role: "cafe_owner_manager", cafe_name: "Test Café", display_name: null, suspended_at: null }]));
    if (target.includes("/rest/v1/cafe_subscriptions?")) return new Response(JSON.stringify([{ user_id: CAFE_ID, status: "free", stripe_customer_id: null, stripe_subscription_id: null, stripe_subscription_event_created_at: null, stripe_subscription_sync_revision: 0 }]));
    if (target.endsWith("/rpc/claim_stripe_checkout")) return new Response(JSON.stringify({ attemptId: body.p_attempt_id, channel: body.p_channel, recovered: true }));
    if (target.endsWith("/rpc/stripe_checkout_claim_is_current")) return new Response("true");
    if (target.endsWith("/rpc/attach_stripe_checkout_customer")) return new Response(JSON.stringify("attached"));
    if (target.endsWith("/rpc/release_stripe_checkout")) return new Response("true");
    throw new Error(`Unexpected database request: ${target}`);
  });

  const stripe = stripeApiClient();
  replaceMethod(t, stripe.customers, "search", async options => {
    assert.deepEqual(options, { query: `metadata['cafe_user_id']:'${CAFE_ID}'`, limit: 100 });
    return { data: [{ id: "cus_recovered", metadata: { cafe_user_id: CAFE_ID } }], has_more: false };
  });
  replaceMethod(t, stripe.customers, "list", async options => {
    assert.deepEqual(options, { email: "cafe@example.com", limit: 100 });
    return { data: [], has_more: false };
  });
  replaceMethod(t, stripe.customers, "create", async () => assert.fail("recovery must not create a duplicate Customer"));
  replaceMethod(t, stripe.subscriptions, "list", async () => ({ data: [], has_more: false }));
  replaceMethod(t, stripe.checkout.sessions, "list", async () => ({ data: [{
    id: "cs_recovered",
    mode: "subscription",
    url: "https://checkout.stripe.com/c/pay/cs_recovered",
    client_reference_id: CAFE_ID,
    metadata: { cafe_user_id: CAFE_ID, checkout_channel: "web" },
    line_items: { data: [{ price: { id: "price_baristamatch" } }] }
  }], has_more: false }));
  replaceMethod(t, stripe.checkout.sessions, "expire", async () => assert.fail("the reusable Session must not expire"));
  replaceMethod(t, stripe.checkout.sessions, "create", async () => assert.fail("the recovered Session must be reused"));

  const res = response();
  await handler(actionRequest("checkout"), res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { url: "https://checkout.stripe.com/c/pay/cs_recovered", reused: true });
  const attachment = databaseCalls.find(({ target }) => target.endsWith("/rpc/attach_stripe_checkout_customer")).body;
  assert.equal(attachment.p_customer_id, "cus_recovered");
});

test("a valid signed webhook is atomically claimed and completed without a Price API lookup", async (t) => {
  const calls = [];
  setup(t, databaseRecorder(calls));
  const payload = eventPayload();
  const res = response();
  await handler(request(payload), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { received: true });
  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /rpc\/claim_stripe_webhook_event$/);
  const claim = JSON.parse(calls[0].body);
  assert.equal(claim.p_event_id, "evt_handler_test");
  assert.equal(claim.p_event_type, "ping");
  assert.match(claim.p_claim_id, /^[0-9a-f-]{36}$/i);
  assert.match(calls[1].url, /rpc\/complete_stripe_webhook_event$/);
  assert.deepEqual(JSON.parse(calls[1].body), { p_event_id: "evt_handler_test", p_claim_id: claim.p_claim_id });
});

test("an invalid webhook signature is rejected before any database call", async (t) => {
  let fetches = 0;
  setup(t, async () => { fetches += 1; return new Response("[]"); });
  const payload = eventPayload();
  const res = response();
  await handler(request(payload, "t=1,v1=invalid"), res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body, "Webhook signature rejected");
  assert.equal(fetches, 0);
});

test("a processing outage returns 500 so Stripe retries the event", async (t) => {
  setup(t, async () => new Response("unavailable", { status: 503 }));
  const payload = eventPayload();
  const res = response();
  await handler(request(payload), res);
  assert.equal(res.statusCode, 500);
  assert.equal(res.body, "Webhook processing failed");
});

test("a claimed webhook failure can only release its own fenced lease", async (t) => {
  const calls = [];
  setup(t, databaseRecorder(calls));
  const stripe = stripeApiClient();
  replaceMethod(t, stripe.subscriptions, "retrieve", async () => {
    throw new Error("simulated Stripe outage");
  });
  const payload = eventPayload("evt_fenced_failure", "customer.subscription.updated", { id: "sub_outage" });
  const res = response();

  await handler(request(payload), res);

  assert.equal(res.statusCode, 500);
  const claim = JSON.parse(calls.find(({ url }) => url.endsWith("/rpc/claim_stripe_webhook_event")).body);
  const failed = JSON.parse(calls.find(({ url }) => url.endsWith("/rpc/fail_stripe_webhook_event")).body);
  assert.deepEqual(failed, { p_event_id: "evt_fenced_failure", p_claim_id: claim.p_claim_id });
  assert.equal(calls.some(({ url }) => url.endsWith("/rpc/complete_stripe_webhook_event")), false);
});

test("a missing signing secret fails closed without mislabeling it as a customer signature", async (t) => {
  setup(t, async () => new Response("[]"));
  delete process.env.STRIPE_WEBHOOK_SECRET;
  const payload = eventPayload();
  const res = response();
  await handler(request(payload), res);
  assert.equal(res.statusCode, 500);
  assert.equal(res.body, "Webhook configuration error");
});

test("a signed subscription Checkout fulfills from the canonical matching subscription", async (t) => {
  const calls = [];
  setup(t, databaseRecorder(calls));
  const stripe = stripeApiClient();
  const canonicalSubscription = {
    id: "sub_cafe_one",
    created: 1_799_999_000,
    status: "active",
    customer: "cus_cafe_one",
    metadata: { cafe_user_id: CAFE_ID },
    current_period_end: 1_800_000_000,
    cancel_at_period_end: false,
    items: { data: [{ price: { id: "price_baristamatch" } }] },
  };
  replaceMethod(t, stripe.subscriptions, "retrieve", async (subscriptionId) => {
    assert.equal(subscriptionId, "sub_cafe_one");
    return canonicalSubscription;
  });
  replaceMethod(t, stripe.subscriptions, "list", async (options) => {
    assert.deepEqual(options, { customer: "cus_cafe_one", status: "all", limit: 100 });
    return { data: [canonicalSubscription], has_more: false };
  });
  const payload = eventPayload("evt_checkout_owned", "checkout.session.completed", {
    id: "cs_test_owned",
    mode: "subscription",
    status: "complete",
    payment_status: "paid",
    subscription: "sub_cafe_one",
    customer: "cus_cafe_one",
    client_reference_id: CAFE_ID,
    metadata: { cafe_user_id: CAFE_ID },
  });

  const res = response();
  await handler(request(payload), res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { received: true });
  const update = calls.find(({ url }) => url.endsWith("/rpc/sync_stripe_subscription"));
  assert.ok(update);
  assert.deepEqual(JSON.parse(update.body), {
    p_user_id: CAFE_ID,
    p_customer_id: "cus_cafe_one",
    p_subscription_id: "sub_cafe_one",
    p_subscription_created_at: new Date(1_799_999_000 * 1000).toISOString(),
    p_status: "active",
    p_current_period_end: "2027-01-15T08:00:00.000Z",
    p_cancel_at_period_end: false,
    p_event_created_at: new Date(1_800_000_000 * 1000).toISOString(),
    p_authoritative: false,
    p_expected_event_created_at: null,
    p_expected_revision: null,
  });
});

test("an equal-second active recovery is corrected by a revision-fenced current-state reconciliation", async (t) => {
  const calls = [];
  const eventCreated = 1_800_000_000;
  const eventCreatedAt = new Date(eventCreated * 1000).toISOString();
  const subscriptionCreatedAt = new Date(1_799_999_000 * 1000).toISOString();
  setup(t, databaseRecorder(calls, {
    user_id: CAFE_ID,
    stripe_customer_id: "cus_cafe_one",
    stripe_subscription_id: "sub_cafe_one",
    stripe_subscription_created_at: subscriptionCreatedAt,
    status: "past_due",
    current_period_end: null,
    cancel_at_period_end: false,
    stripe_subscription_event_created_at: eventCreatedAt,
    stripe_subscription_sync_revision: 7,
  }));
  const activeSubscription = {
    id: "sub_cafe_one",
    created: 1_799_999_000,
    status: "active",
    customer: "cus_cafe_one",
    metadata: { cafe_user_id: CAFE_ID },
    current_period_end: 1_800_010_000,
    cancel_at_period_end: false,
    items: { data: [{ price: { id: "price_baristamatch" } }] },
  };
  const stripe = stripeApiClient();
  replaceMethod(t, stripe.subscriptions, "retrieve", async () => activeSubscription);
  replaceMethod(t, stripe.subscriptions, "list", async () => ({ data: [activeSubscription], has_more: false }));
  const payload = eventPayload("evt_equal_second_recovery", "customer.subscription.updated", {
    id: activeSubscription.id,
    status: "past_due",
  }, eventCreated);

  const res = response();
  await handler(request(payload), res);

  assert.equal(res.statusCode, 200);
  const writes = calls
    .filter(({ url }) => url.endsWith("/rpc/sync_stripe_subscription"))
    .map(({ body }) => JSON.parse(body));
  assert.equal(writes.length, 2);
  assert.equal(writes[0].p_status, "active");
  assert.equal(writes[0].p_authoritative, false);
  assert.equal(writes[1].p_status, "active");
  assert.equal(writes[1].p_authoritative, true);
  assert.equal(writes[1].p_expected_event_created_at, eventCreatedAt);
  assert.equal(writes[1].p_expected_revision, 7);
  assert.equal(writes[1].p_event_created_at, subscriptionCreatedAt);
});

test("authoritative reconciliation retains a just-observed active subscription omitted from a list replica", async (t) => {
  const calls = [];
  setup(t, databaseRecorder(calls));
  const activeSubscription = {
    id: "sub_active_fresh",
    created: 1_799_999_000,
    status: "active",
    customer: "cus_cafe_one",
    metadata: { cafe_user_id: CAFE_ID },
    current_period_end: 1_800_010_000,
    cancel_at_period_end: false,
    items: { data: [{ price: { id: "price_baristamatch" } }] },
  };
  const canceledSubscription = {
    id: "sub_canceled_old",
    created: 1_799_998_000,
    status: "canceled",
    customer: "cus_cafe_one",
    metadata: { cafe_user_id: CAFE_ID },
    cancel_at_period_end: false,
    items: { data: [{ price: { id: "price_baristamatch" } }] },
  };
  let retrieveCalls = 0;
  const stripe = stripeApiClient();
  replaceMethod(t, stripe.subscriptions, "retrieve", async (subscriptionId) => {
    retrieveCalls += 1;
    assert.equal(subscriptionId, activeSubscription.id);
    return activeSubscription;
  });
  replaceMethod(t, stripe.subscriptions, "list", async () => ({ data: [canceledSubscription], has_more: false }));
  const payload = eventPayload("evt_list_replica_lag", "customer.subscription.created", { id: activeSubscription.id });

  const res = response();
  await handler(request(payload), res);

  assert.equal(res.statusCode, 200);
  assert.equal(retrieveCalls, 2);
  const writes = calls
    .filter(({ url }) => url.endsWith("/rpc/sync_stripe_subscription"))
    .map(({ body }) => JSON.parse(body));
  assert.equal(writes.length, 2);
  assert.deepEqual(writes.map(write => [write.p_subscription_id, write.p_status, write.p_authoritative]), [
    [activeSubscription.id, "active", false],
    [activeSubscription.id, "active", true],
  ]);
});

test("an owned subscription moved off the configured Price loses access and is authoritatively fenced", async (t) => {
  const calls = [];
  const eventCreated = 1_800_000_000;
  setup(t, databaseRecorder(calls, {
    user_id: CAFE_ID,
    stripe_customer_id: "cus_cafe_one",
    stripe_subscription_id: "sub_price_switched",
    stripe_subscription_created_at: new Date(1_799_999_000 * 1000).toISOString(),
    status: "active",
    current_period_end: new Date(1_800_010_000 * 1000).toISOString(),
    cancel_at_period_end: false,
    stripe_subscription_event_created_at: new Date(1_799_999_900 * 1000).toISOString(),
    stripe_subscription_sync_revision: 4,
  }));
  const incompatibleSubscription = {
    id: "sub_price_switched",
    created: 1_799_999_000,
    status: "active",
    customer: "cus_cafe_one",
    metadata: { cafe_user_id: CAFE_ID },
    current_period_end: 1_800_010_000,
    cancel_at_period_end: false,
    items: { data: [{ price: { id: "price_unapproved_plan" } }] },
  };
  const stripe = stripeApiClient();
  replaceMethod(t, stripe.subscriptions, "retrieve", async () => incompatibleSubscription);
  replaceMethod(t, stripe.subscriptions, "list", async () => ({ data: [incompatibleSubscription], has_more: false }));
  const payload = eventPayload("evt_price_switched", "customer.subscription.updated", { id: incompatibleSubscription.id }, eventCreated);

  const res = response();
  await handler(request(payload), res);

  assert.equal(res.statusCode, 200);
  const writes = calls
    .filter(({ url }) => url.endsWith("/rpc/sync_stripe_subscription"))
    .map(({ body }) => JSON.parse(body));
  assert.equal(writes.length, 1);
  assert.deepEqual(writes.map(write => [write.p_subscription_id, write.p_status, write.p_authoritative]), [
    [incompatibleSubscription.id, "expired", true],
  ]);
  assert.equal(writes[0].p_expected_revision, 4);
});

test("an Invoice for an unapproved replacement Price revokes stale access without recording plan revenue", async (t) => {
  const calls = [];
  setup(t, databaseRecorder(calls, {
    user_id: CAFE_ID,
    stripe_customer_id: "cus_cafe_one",
    stripe_subscription_id: "sub_unapproved_invoice",
    stripe_subscription_created_at: new Date(1_799_999_000 * 1000).toISOString(),
    status: "active",
    current_period_end: null,
    cancel_at_period_end: false,
    stripe_subscription_event_created_at: new Date(1_799_999_900 * 1000).toISOString(),
    stripe_subscription_sync_revision: 2,
  }));
  const incompatibleSubscription = {
    id: "sub_unapproved_invoice",
    created: 1_799_999_000,
    status: "active",
    customer: "cus_cafe_one",
    metadata: { cafe_user_id: CAFE_ID },
    cancel_at_period_end: false,
    items: { data: [{ price: { id: "price_unapproved_plan" } }] },
  };
  const stripe = stripeApiClient();
  replaceMethod(t, stripe.subscriptions, "retrieve", async () => incompatibleSubscription);
  replaceMethod(t, stripe.subscriptions, "list", async () => ({ data: [incompatibleSubscription], has_more: false }));
  const payload = eventPayload("evt_unapproved_invoice", "invoice.paid", {
    id: "in_unapproved_plan",
    subscription: incompatibleSubscription.id,
    paid: true,
    status: "paid",
    amount_paid: 4999,
    currency: "usd",
  });

  const res = response();
  await handler(request(payload), res);

  assert.equal(res.statusCode, 200);
  const subscriptionWrite = calls.find(({ url }) => url.endsWith("/rpc/sync_stripe_subscription"));
  assert.equal(JSON.parse(subscriptionWrite.body).p_status, "expired");
  assert.equal(calls.some(({ url }) => url.endsWith("/rpc/record_stripe_subscription_payment")), false);
});

test("subscription reconciliation keeps an older active plan ahead of a newer canceled duplicate", async (t) => {
  const calls = [];
  setup(t, databaseRecorder(calls));
  const activeSubscription = {
    id: "sub_active_older",
    created: 1_799_998_000,
    status: "active",
    customer: "cus_cafe_one",
    metadata: { cafe_user_id: CAFE_ID },
    current_period_end: 1_800_010_000,
    cancel_at_period_end: false,
    items: { data: [{ price: { id: "price_baristamatch" } }] },
  };
  const canceledSubscription = {
    id: "sub_canceled_newer",
    created: 1_799_999_000,
    status: "canceled",
    customer: "cus_cafe_one",
    metadata: { cafe_user_id: CAFE_ID },
    current_period_end: 1_800_000_000,
    cancel_at_period_end: false,
    items: { data: [{ price: { id: "price_baristamatch" } }] },
  };
  const stripe = stripeApiClient();
  replaceMethod(t, stripe.subscriptions, "retrieve", async (subscriptionId) => {
    assert.equal(subscriptionId, canceledSubscription.id);
    return canceledSubscription;
  });
  replaceMethod(t, stripe.subscriptions, "list", async (options) => {
    assert.deepEqual(options, { customer: "cus_cafe_one", status: "all", limit: 100 });
    return { data: [canceledSubscription, activeSubscription], has_more: false };
  });
  const payload = eventPayload("evt_duplicate_subscription", "customer.subscription.deleted", {
    id: canceledSubscription.id,
  });

  const res = response();
  await handler(request(payload), res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { received: true });
  const update = calls.find(({ url }) => url.endsWith("/rpc/sync_stripe_subscription"));
  assert.ok(update);
  assert.deepEqual(JSON.parse(update.body), {
    p_user_id: CAFE_ID,
    p_customer_id: "cus_cafe_one",
    p_subscription_id: "sub_active_older",
    p_subscription_created_at: new Date(activeSubscription.created * 1000).toISOString(),
    p_status: "active",
    p_current_period_end: new Date(activeSubscription.current_period_end * 1000).toISOString(),
    p_cancel_at_period_end: false,
    p_event_created_at: new Date(1_800_000_000 * 1000).toISOString(),
    p_authoritative: false,
    p_expected_event_created_at: null,
    p_expected_revision: null,
  });
});

test("unrelated signed Checkout and subscription events are acknowledged without changing billing state", async (t) => {
  const calls = [];
  setup(t, databaseRecorder(calls));
  const stripe = stripeApiClient();
  replaceMethod(t, stripe.subscriptions, "retrieve", async (subscriptionId) => ({
    id: subscriptionId,
    created: 1_799_999_000,
    status: "active",
    customer: "cus_unrelated",
    metadata: { cafe_user_id: OTHER_CAFE_ID },
    items: { data: [{ price: { id: "price_some_other_product" } }] },
  }));

  const unrelatedCheckout = eventPayload("evt_payment_checkout", "checkout.session.completed", {
    id: "cs_test_one_time",
    mode: "payment",
    status: "complete",
    payment_status: "paid",
    customer: "cus_unrelated",
  });
  const unrelatedSubscription = eventPayload("evt_unrelated_subscription", "customer.subscription.updated", {
    id: "sub_unrelated",
  });

  for (const payload of [unrelatedCheckout, unrelatedSubscription]) {
    const res = response();
    await handler(request(payload), res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { received: true });
  }

  assert.equal(calls.some(({ url }) => url.endsWith("/rpc/sync_stripe_subscription")), false);
  const claimedEvents = calls
    .filter(({ method, url }) => method === "POST" && url.endsWith("/rpc/claim_stripe_webhook_event"))
    .map(({ body }) => {
      const parsed = JSON.parse(body);
      assert.match(parsed.p_claim_id, /^[0-9a-f-]{36}$/i);
      return { p_event_id: parsed.p_event_id, p_event_type: parsed.p_event_type };
    });
  assert.deepEqual(claimedEvents, [
    { p_event_id: "evt_payment_checkout", p_event_type: "checkout.session.completed" },
    { p_event_id: "evt_unrelated_subscription", p_event_type: "customer.subscription.updated" },
  ]);
  assert.equal(calls.filter(({ url }) => url.endsWith("/rpc/complete_stripe_webhook_event")).length, 2);
});

test("signed Checkout fulfillment rejects canonical Price, metadata, and customer mismatches without poisoning the event", async (t) => {
  const calls = [];
  setup(t, databaseRecorder(calls));
  const canonicalSubscriptions = {
    sub_wrong_price: {
      id: "sub_wrong_price",
      status: "active",
      customer: "cus_cafe_one",
      metadata: { cafe_user_id: CAFE_ID },
      items: { data: [{ price: { id: "price_other" } }] },
    },
    sub_wrong_metadata: {
      id: "sub_wrong_metadata",
      status: "active",
      customer: "cus_cafe_one",
      metadata: { cafe_user_id: OTHER_CAFE_ID },
      items: { data: [{ price: { id: "price_baristamatch" } }] },
    },
    sub_wrong_customer: {
      id: "sub_wrong_customer",
      status: "active",
      customer: "cus_other",
      metadata: { cafe_user_id: CAFE_ID },
      items: { data: [{ price: { id: "price_baristamatch" } }] },
    },
  };
  const stripe = stripeApiClient();
  replaceMethod(t, stripe.subscriptions, "retrieve", async (subscriptionId) => canonicalSubscriptions[subscriptionId]);

  for (const [index, subscriptionId] of Object.keys(canonicalSubscriptions).entries()) {
    const payload = eventPayload(`evt_scope_${index}`, "checkout.session.completed", {
      id: `cs_test_scope_${index}`,
      mode: "subscription",
      status: "complete",
      payment_status: "paid",
      subscription: subscriptionId,
      customer: "cus_cafe_one",
      client_reference_id: CAFE_ID,
      metadata: { cafe_user_id: CAFE_ID },
    });
    const res = response();
    await handler(request(payload), res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { received: true });
  }

  assert.equal(calls.some(({ url }) => url.endsWith("/rpc/sync_stripe_subscription")), false);
  assert.equal(calls.filter(({ method, url }) => method === "POST" && url.endsWith("/rpc/claim_stripe_webhook_event")).length, 3);
  assert.equal(calls.filter(({ method, url }) => method === "POST" && url.endsWith("/rpc/complete_stripe_webhook_event")).length, 3);
});

test("reverse-ordered Invoice events pass Stripe event time to the monotonic payment RPC", async (t) => {
  const calls = [];
  setup(t, databaseRecorder(calls));
  const stripe = stripeApiClient();
  const canonicalSubscription = {
    id: "sub_cafe_one",
    created: 1_799_999_000,
    status: "active",
    customer: "cus_cafe_one",
    metadata: { cafe_user_id: CAFE_ID },
    items: { data: [{ price: { id: "price_baristamatch" } }] },
  };
  replaceMethod(t, stripe.subscriptions, "retrieve", async (subscriptionId) => {
    assert.equal(subscriptionId, canonicalSubscription.id);
    return canonicalSubscription;
  });
  replaceMethod(t, stripe.subscriptions, "list", async (options) => {
    assert.deepEqual(options, { customer: "cus_cafe_one", status: "all", limit: 100 });
    return { data: [canonicalSubscription], has_more: false };
  });

  const paidEventCreated = 1_800_000_100;
  const olderFailureCreated = 1_800_000_000;
  const paidPayload = eventPayload("evt_invoice_paid", "invoice.paid", {
    id: "in_reverse_order",
    subscription: "sub_cafe_one",
    paid: true,
    status: "paid",
    amount_paid: 999,
    amount_due: 999,
    currency: "usd",
    status_transitions: { paid_at: paidEventCreated },
  }, paidEventCreated);
  const staleFailurePayload = eventPayload("evt_invoice_failed_older", "invoice.payment_failed", {
    id: "in_reverse_order",
    subscription: "sub_cafe_one",
    paid: false,
    status: "open",
    amount_paid: 0,
    amount_due: 999,
    currency: "usd",
  }, olderFailureCreated);

  for (const payload of [paidPayload, staleFailurePayload]) {
    const res = response();
    await handler(request(payload), res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { received: true });
  }

  const paymentCalls = calls
    .filter(({ url }) => url.endsWith("/rpc/record_stripe_subscription_payment"))
    .map(({ body }) => JSON.parse(body));
  assert.equal(paymentCalls.length, 2);
  assert.deepEqual(paymentCalls[0], {
    p_cafe_user_id: CAFE_ID,
    p_provider_payment_id: "in_reverse_order",
    p_amount_cents: 999,
    p_currency: "usd",
    p_status: "succeeded",
    p_paid_at: new Date(paidEventCreated * 1000).toISOString(),
    p_event_created_at: new Date(paidEventCreated * 1000).toISOString(),
  });
  assert.deepEqual(paymentCalls[1], {
    p_cafe_user_id: CAFE_ID,
    p_provider_payment_id: "in_reverse_order",
    p_amount_cents: 999,
    p_currency: "usd",
    p_status: "failed",
    p_paid_at: null,
    p_event_created_at: new Date(olderFailureCreated * 1000).toISOString(),
  });

  const coordinationSql = readFileSync(
    new URL("../supabase/migrations/20260908090000_harden_stripe_runtime_coordination.sql", import.meta.url),
    "utf8"
  ).replace(/\s+/g, " ");
  assert.match(coordinationSql, /excluded\.provider_event_created_at >= coalesce/);
  assert.match(coordinationSql, /excluded\.status = 'succeeded' and existing\.status <> 'succeeded'/);
  assert.match(coordinationSql, /existing\.status <> 'succeeded' or excluded\.status = 'succeeded'/);
  assert.match(coordinationSql, /existing\.cafe_user_id = excluded\.cafe_user_id/);
  assert.doesNotMatch(coordinationSql, /set cafe_user_id = excluded\.cafe_user_id/);
  assert.match(coordinationSql, /if not p_authoritative and existing\.stripe_subscription_event_created_at > p_event_created_at then/);
  assert.match(coordinationSql, /stripe_subscription_event_created_at is distinct from p_expected_event_created_at/);
  assert.match(coordinationSql, /stripe_subscription_sync_revision is distinct from p_expected_revision/);
  assert.match(coordinationSql, /stripe_subscription_sync_revision = stripe_subscription_sync_revision \+ 1/);
  assert.match(coordinationSql, /if p_authoritative and existing\.stripe_subscription_event_created_at is not null and existing\.stripe_customer_id is not distinct from p_customer_id/);
  assert.match(coordinationSql, /incoming_selection_rank < existing_selection_rank/);
  assert.match(coordinationSql, /p_subscription_created_at < existing\.stripe_subscription_created_at/);
  assert.match(coordinationSql, /p_subscription_id collate "C" < existing\.stripe_subscription_id collate "C"/);
  assert.match(coordinationSql, /stripe_subscription_created_at = p_subscription_created_at/);
  assert.match(coordinationSql, /if existing\.stripe_subscription_id = p_subscription_id then/);
  assert.match(coordinationSql, /and claim_id = p_claim_id/);
  assert.match(coordinationSql, /claimed_attempt_id := coalesce/);
  assert.match(coordinationSql, /'recovered', recovered/);
  assert.match(coordinationSql, /case when p_clear_attempt then null else stripe_checkout_attempt_id end/);
  assert.match(coordinationSql, /stripe_checkout_claim_kind = 'deletion'/);
  assert.match(coordinationSql, /else 'recovering'/);
  assert.match(coordinationSql, /greatest\(existing\.amount_cents, excluded\.amount_cents\)/);
  const billingRuntime = readFileSync(new URL("../api/billing.js", import.meta.url), "utf8");
  assert.match(billingRuntime, /preferredConfiguredSubscription\(subscriptions, userId, customerId\)/);
  assert.match(billingRuntime, /if \(attachment === "missing"\)/);
  assert.doesNotMatch(billingRuntime, /\["deletion", "missing"\]\.includes\(attachment\)/);
});
