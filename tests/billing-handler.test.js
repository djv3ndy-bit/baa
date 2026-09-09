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
  const keys = ["STRIPE_RESTRICTED_KEY", "STRIPE_LIVEMODE", "STRIPE_WEBHOOK_SECRET", "STRIPE_MONTHLY_PRICE_ID", "STRIPE_ACCOUNT_ID", "BILLING_ENABLED", "PUBLIC_SITE_URL", "SUPABASE_URL", "SUPABASE_PUBLISHABLE_KEY", "SUPABASE_SECRET_KEY", "VERCEL_ENV"];
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
    VERCEL_ENV: "preview",
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
    if (target.endsWith("/rpc/claim_stripe_checkout")) return new Response(JSON.stringify({ attemptId: body.p_attempt_id, channel: body.p_channel, uiMode: "hosted", recovered: false }));
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
  assert.equal(databaseCalls.filter(({ target }) => target.endsWith("/rpc/stripe_checkout_claim_is_current")).length, 3);
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
    if (target.endsWith("/rpc/claim_stripe_checkout")) return new Response(JSON.stringify({ attemptId: body.p_attempt_id, channel: body.p_channel, uiMode: "hosted", recovered: true }));
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

function checkoutRetryFixture(t, error, recovered = true) {
  const oldAttempt = "33333333-3333-4333-8333-333333333333";
  const state = { claimId: null, attemptId: recovered ? oldAttempt : null, channel: recovered ? "web" : null };
  const calls = { claims: [], releases: [], creates: [], timeline: [], logs: [] };
  const control = { error, subscriptions: [], sessions: [], beforeReject: null };
  setup(t, async (url, init = {}) => {
    const target = String(url), body = init.body ? JSON.parse(init.body) : null;
    if (target.endsWith("/auth/v1/user")) return Response.json({ id: CAFE_ID, email: "cafe@example.com" });
    if (target.includes("/rest/v1/profiles?")) return Response.json([{ role: "cafe_owner_manager", suspended_at: null }]);
    if (target.includes("/rest/v1/cafe_subscriptions?")) return Response.json([{
      user_id: CAFE_ID, status: "free", stripe_customer_id: "cus_retry", stripe_subscription_id: null,
      stripe_subscription_event_created_at: null, stripe_subscription_sync_revision: 0,
    }]);
    if (target.endsWith("/rpc/claim_stripe_checkout")) {
      assert.equal(state.claimId, null);
      const recovering = state.attemptId !== null;
      state.claimId = body.p_claim_id;
      state.attemptId ??= body.p_attempt_id;
      state.channel ??= body.p_channel;
      calls.claims.push({ ...body, attemptId: state.attemptId });
      return Response.json({ attemptId: state.attemptId, channel: state.channel, uiMode: "hosted", recovered: recovering });
    }
    if (target.endsWith("/rpc/stripe_checkout_claim_is_current")) return Response.json(state.claimId === body.p_claim_id);
    if (target.endsWith("/rpc/release_stripe_checkout")) {
      calls.releases.push(body);
      if (state.claimId !== body.p_claim_id) return Response.json(false);
      state.claimId = null;
      if (body.p_clear_attempt) { state.attemptId = null; state.channel = null; }
      return Response.json(true);
    }
    assert.fail(`Unexpected database request: ${target}`);
  });
  replaceMethod(t, console, "error", (...args) => calls.logs.push(args));
  const stripe = stripeApiClient();
  replaceMethod(t, stripe.customers, "create", async () => assert.fail("the attached Customer must be preserved"));
  replaceMethod(t, stripe.customers, "del", async () => assert.fail("the attached Customer must be preserved"));
  replaceMethod(t, stripe.subscriptions, "list", async () => {
    calls.timeline.push("subscriptions");
    if (control.preflightError) throw control.preflightError;
    return { data: control.subscriptions, has_more: false };
  });
  replaceMethod(t, stripe.checkout.sessions, "list", async () => {
    calls.timeline.push("sessions");
    return { data: control.sessions, has_more: false };
  });
  replaceMethod(t, stripe.checkout.sessions, "expire", async () => assert.fail("no unrelated Session should be expired"));
  replaceMethod(t, stripe.checkout.sessions, "create", async (params, options) => {
    calls.timeline.push("create");
    calls.creates.push({ params, options });
    if (control.error) { control.beforeReject?.(); throw control.error; }
    return { id: "cs_retry", url: "https://checkout.stripe.com/c/pay/cs_retry" };
  });
  return { state, calls, control, oldAttempt };
}

const rejectedCheckout = (overrides = {}) => Object.freeze(Object.assign(new Error("private provider message"), {
  type: "StripeInvalidRequestError", statusCode: 400, headers: {}, ...overrides,
}));

test("a rejected Checkout rotates a fresh attempt or a verified replay and reconciles before the next create", async t => {
  for (const recovered of [false, true]) {
    await t.test(recovered ? "replayed durable attempt" : "fresh attempt", async t => {
      const fixture = checkoutRetryFixture(t, rejectedCheckout({
        headers: recovered ? { "idempotent-replayed": "true" } : {},
      }), recovered);
      const { state, calls, control, oldAttempt } = fixture;
      const failed = response();
      await handler(actionRequest("checkout"), failed);
      assert.equal(failed.statusCode, 502);
      assert.deepEqual(failed.body, { error: "Secure checkout could not be opened. Please try again." });
      assert.equal(calls.creates.length, 1, "a rejection must not retry in the same request");
      assert.equal(calls.releases[0].p_clear_attempt, true);
      assert.deepEqual(state, { claimId: null, attemptId: null, channel: null });
      assert.equal(calls.logs[0][1].stage, "checkout_create");
      assert.equal(JSON.stringify(calls.logs).includes("private provider message"), false);
      if (recovered) assert.equal(calls.creates[0].options.idempotencyKey, `baristamatch-checkout-${CAFE_ID}-${oldAttempt}`);

      control.error = null;
      const succeeded = response();
      await handler(actionRequest("checkout", { channel: "mobile" }), succeeded);
      assert.equal(succeeded.statusCode, 200);
      assert.notEqual(calls.creates[1].options.idempotencyKey, calls.creates[0].options.idempotencyKey);
      assert.equal(calls.creates[1].params.customer, "cus_retry");
      assert.equal(calls.creates[1].params.metadata.checkout_channel, "app");
      assert.deepEqual(calls.timeline, ["subscriptions", "sessions", "create", "subscriptions", "sessions", "create"]);
    });
  }
});

test("uncertain or concurrent Checkout failures preserve the durable key and channel on retry", async t => {
  const errors = [
    ["recovered rejection without replay confirmation", rejectedCheckout()],
    ["recovered non-replayed rejection", rejectedCheckout({ headers: { "idempotent-replayed": "false" } })],
    ["unverified replay header", rejectedCheckout({ headers: { "idempotent-replayed": "TRUE" } })],
    ["transport failure", new TypeError("network failed")],
    ["server failure", rejectedCheckout({ statusCode: 500, headers: { "idempotent-replayed": "true" } })],
    ["rate limit", rejectedCheckout({ statusCode: 429, headers: { "idempotent-replayed": "true" } })],
    ["conflict", rejectedCheckout({ statusCode: 409, headers: { "idempotent-replayed": "true" } })],
    ["idempotency error", rejectedCheckout({ type: "StripeIdempotencyError", headers: { "idempotent-replayed": "true" } })],
    ["in-progress key", rejectedCheckout({ code: "idempotency_key_in_use", headers: { "idempotent-replayed": "true" } })],
    ["lock timeout", rejectedCheckout({ code: "lock_timeout", headers: { "idempotent-replayed": "true" } })],
    ["provider requests retry", rejectedCheckout({ headers: { "idempotent-replayed": "true", "stripe-should-retry": "true" } })],
    ["other invalid-request status", rejectedCheckout({ statusCode: 404, headers: { "idempotent-replayed": "true" } })],
    ["unverified status", rejectedCheckout({ statusCode: "400", headers: { "idempotent-replayed": "true" } })],
  ];
  for (const [name, error] of errors) {
    await t.test(name, async t => {
      const { state, calls, oldAttempt } = checkoutRetryFixture(t, error);
      for (const channel of ["web", "mobile"]) {
        const failed = response();
        await handler(actionRequest("checkout", { channel }), failed);
        assert.equal(failed.statusCode, 502);
        assert.deepEqual(state, { claimId: null, attemptId: oldAttempt, channel: "web" });
      }
      assert.equal(calls.creates.length, 2);
      assert.equal(calls.creates[0].options.idempotencyKey, calls.creates[1].options.idempotencyKey);
      assert.equal(calls.creates[1].params.metadata.checkout_channel, "web");
      assert.ok(calls.releases.every(release => release.p_clear_attempt === false));
    });
  }
});

test("a recovered attempt keeps its key until Stripe confirms the cached rejection", async t => {
  const { state, calls, control, oldAttempt } = checkoutRetryFixture(t, rejectedCheckout());
  await handler(actionRequest("checkout"), response());
  assert.equal(state.attemptId, oldAttempt);
  control.error = rejectedCheckout({ headers: { "idempotent-replayed": "true" } });
  await handler(actionRequest("checkout"), response());
  assert.equal(state.attemptId, null);
  assert.equal(calls.creates[0].options.idempotencyKey, calls.creates[1].options.idempotencyKey);
  assert.deepEqual(calls.releases.map(release => release.p_clear_attempt), [false, true]);
  control.error = null;
  const succeeded = response();
  await handler(actionRequest("checkout"), succeeded);
  assert.equal(succeeded.statusCode, 200);
  assert.notEqual(calls.creates[2].options.idempotencyKey, calls.creates[1].options.idempotencyKey);
});

test("a replayed rejection from another Stripe operation cannot settle a Checkout attempt", async t => {
  const { state, calls, control, oldAttempt } = checkoutRetryFixture(t, null);
  control.preflightError = rejectedCheckout({ headers: { "idempotent-replayed": "true" } });
  const failed = response();
  await handler(actionRequest("checkout"), failed);
  assert.equal(failed.statusCode, 502);
  assert.equal(calls.creates.length, 0);
  assert.equal(calls.releases[0].p_clear_attempt, false);
  assert.deepEqual(state, { claimId: null, attemptId: oldAttempt, channel: "web" });
});

test("a settled rejection still reuses a discovered Checkout or blocks an existing subscription", async t => {
  for (const resource of ["session", "subscription"]) {
    await t.test(resource, async t => {
      const { calls, control } = checkoutRetryFixture(t, rejectedCheckout({ headers: { "idempotent-replayed": "true" } }));
      await handler(actionRequest("checkout"), response());
      control.error = null;
      if (resource === "session") control.sessions = [{
        id: "cs_discovered", mode: "subscription", url: "https://checkout.stripe.com/c/pay/cs_discovered",
        client_reference_id: CAFE_ID, metadata: { cafe_user_id: CAFE_ID, checkout_channel: "web" },
        line_items: { data: [{ price: { id: "price_baristamatch" } }] },
      }];
      else control.subscriptions = [{ id: "sub_discovered", status: "active" }];
      const retried = response();
      await handler(actionRequest("checkout"), retried);
      assert.equal(retried.statusCode, resource === "session" ? 200 : 409);
      if (resource === "session") assert.equal(retried.body.reused, true);
      assert.equal(calls.creates.length, 1, "reconciliation must prevent another create");
    });
  }
});

test("a late rejected Checkout cannot clear a successor's claim or durable attempt", async t => {
  const { state, calls, control } = checkoutRetryFixture(t, rejectedCheckout({ headers: { "idempotent-replayed": "true" } }));
  const successor = {
    claimId: "44444444-4444-4444-8444-444444444444",
    attemptId: "55555555-5555-4555-8555-555555555555", channel: "app",
  };
  control.beforeReject = () => Object.assign(state, successor);
  const failed = response();
  await handler(actionRequest("checkout"), failed);
  assert.equal(failed.statusCode, 502);
  assert.equal(calls.releases[0].p_clear_attempt, true);
  assert.equal(calls.releases[0].p_claim_id, calls.claims[0].p_claim_id);
  assert.notEqual(calls.releases[0].p_claim_id, successor.claimId);
  assert.deepEqual(state, successor);
  assert.equal(calls.creates.length, 1);
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

test("Customer Portal opens only after current Stripe Customer, subscription, mode, and Price ownership are verified", async (t) => {
  const billing = {
    user_id: CAFE_ID,
    status: "active",
    stripe_customer_id: "cus_portal_owner",
    stripe_subscription_id: "sub_portal_owner",
  };
  setup(t, async (url) => {
    const target = String(url);
    if (target.endsWith("/auth/v1/user")) return new Response(JSON.stringify({ id: CAFE_ID, email: "cafe@example.com" }));
    if (target.includes("/rest/v1/profiles?")) return new Response(JSON.stringify([{ role: "cafe_owner_manager", suspended_at: null }]));
    if (target.includes("/rest/v1/cafe_subscriptions?")) return new Response(JSON.stringify([billing]));
    throw new Error(`Unexpected database request: ${target}`);
  });
  const stripe = stripeApiClient();
  replaceMethod(t, stripe.customers, "retrieve", async (customerId) => {
    assert.equal(customerId, billing.stripe_customer_id);
    return { id: customerId, livemode: false, deleted: false, metadata: { cafe_user_id: CAFE_ID } };
  });
  replaceMethod(t, stripe.subscriptions, "retrieve", async (subscriptionId) => {
    assert.equal(subscriptionId, billing.stripe_subscription_id);
    return {
      id: subscriptionId,
      livemode: false,
      status: "active",
      customer: billing.stripe_customer_id,
      metadata: { cafe_user_id: CAFE_ID },
      items: { data: [{ price: { id: "price_baristamatch" } }] },
    };
  });
  let portalOptions;
  replaceMethod(t, stripe.billingPortal.sessions, "create", async (options) => {
    portalOptions = options;
    return { url: "https://billing.stripe.test/session" };
  });

  const res = response();
  await handler(actionRequest("portal"), res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { url: "https://billing.stripe.test/session" });
  assert.deepEqual(portalOptions, {
    customer: billing.stripe_customer_id,
    return_url: "https://www.baristajobmatch.com/dashboard.html",
  });
});

test("Customer Portal fails closed for stale or foreign Stripe ownership and never creates a session", async (t) => {
  const billing = {
    user_id: CAFE_ID,
    status: "active",
    stripe_customer_id: "cus_portal_owner",
    stripe_subscription_id: "sub_portal_owner",
  };
  setup(t, async (url) => {
    const target = String(url);
    if (target.endsWith("/auth/v1/user")) return new Response(JSON.stringify({ id: CAFE_ID, email: "cafe@example.com" }));
    if (target.includes("/rest/v1/profiles?")) return new Response(JSON.stringify([{ role: "cafe_owner_manager", suspended_at: null }]));
    if (target.includes("/rest/v1/cafe_subscriptions?")) return new Response(JSON.stringify([billing]));
    throw new Error(`Unexpected database request: ${target}`);
  });
  const stripe = stripeApiClient();
  const ownedCustomer = { id: billing.stripe_customer_id, livemode: false, deleted: false, metadata: { cafe_user_id: CAFE_ID } };
  const ownedSubscription = {
    id: billing.stripe_subscription_id,
    livemode: false,
    status: "active",
    customer: billing.stripe_customer_id,
    metadata: { cafe_user_id: CAFE_ID },
    items: { data: [{ price: { id: "price_baristamatch" } }] },
  };
  let customer = ownedCustomer;
  let subscription = ownedSubscription;
  let portalCreates = 0;
  replaceMethod(t, stripe.customers, "retrieve", async () => customer);
  replaceMethod(t, stripe.subscriptions, "retrieve", async () => subscription);
  replaceMethod(t, stripe.billingPortal.sessions, "create", async () => {
    portalCreates += 1;
    return { url: "https://billing.stripe.test/should-not-open" };
  });

  const cases = [
    ["deleted Customer", { ...ownedCustomer, deleted: true }, ownedSubscription],
    ["foreign Customer metadata", { ...ownedCustomer, metadata: { cafe_user_id: OTHER_CAFE_ID } }, ownedSubscription],
    ["wrong Customer mode", { ...ownedCustomer, livemode: true }, ownedSubscription],
    ["foreign subscription metadata", ownedCustomer, { ...ownedSubscription, metadata: { cafe_user_id: OTHER_CAFE_ID } }],
    ["foreign subscription Customer", ownedCustomer, { ...ownedSubscription, customer: "cus_someone_else" }],
    ["wrong subscription Price", ownedCustomer, { ...ownedSubscription, items: { data: [{ price: { id: "price_other" } }] } }],
    ["wrong subscription mode", ownedCustomer, { ...ownedSubscription, livemode: true }],
    ["canceled current subscription", ownedCustomer, { ...ownedSubscription, status: "canceled" }],
  ];
  for (const [label, candidateCustomer, candidateSubscription] of cases) {
    customer = candidateCustomer;
    subscription = candidateSubscription;
    const res = response();
    await handler(actionRequest("portal"), res);
    assert.equal(res.statusCode, 409, label);
    assert.match(res.body.error, /no current subscription/i, label);
  }
  assert.equal(portalCreates, 0);
});

test("refund revenue is recorded only through an authoritative Charge, InvoicePayment, Invoice, and owned canonical subscription", async (t) => {
  const calls = [];
  setup(t, databaseRecorder(calls, {
    user_id: CAFE_ID,
    status: "active",
    stripe_customer_id: "cus_refund_owner",
    stripe_subscription_id: "sub_refund_owner",
  }));
  const stripe = stripeApiClient();
  replaceMethod(t, stripe.charges, "retrieve", async (chargeId) => ({
    id: chargeId,
    livemode: false,
    paid: true,
    customer: "cus_refund_owner",
    payment_intent: "pi_refund_owner",
    amount_refunded: 400,
    currency: "usd",
  }));
  replaceMethod(t, stripe.invoicePayments, "list", async (options) => {
    assert.deepEqual(options, {
      payment: { type: "payment_intent", payment_intent: "pi_refund_owner" },
      status: "paid",
      limit: 2,
    });
    return {
      data: [{
        id: "inpay_refund_owner",
        status: "paid",
        livemode: false,
        currency: "usd",
        amount_paid: 999,
        invoice: "in_refund_owner",
        payment: { type: "payment_intent", payment_intent: "pi_refund_owner" },
      }],
      has_more: false,
    };
  });
  replaceMethod(t, stripe.invoices, "retrieve", async (invoiceId) => ({
    id: invoiceId,
    livemode: false,
    currency: "usd",
    customer: "cus_refund_owner",
    parent: { type: "subscription_details", subscription_details: { subscription: "sub_refund_owner" } },
  }));
  replaceMethod(t, stripe.subscriptions, "retrieve", async (subscriptionId) => ({
    id: subscriptionId,
    livemode: false,
    status: "active",
    customer: "cus_refund_owner",
    metadata: { cafe_user_id: CAFE_ID },
    items: { data: [{ price: { id: "price_baristamatch" } }] },
  }));
  const eventCreated = 1_800_000_321;
  const payload = eventPayload("evt_refund_owned", "charge.refunded", {
    id: "ch_refund_owner",
    amount_refunded: 999999,
    customer: "cus_spoofed_snapshot",
  }, eventCreated);

  const res = response();
  await handler(request(payload), res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { received: true });
  const payments = calls
    .filter(({ url }) => url.endsWith("/rpc/record_stripe_subscription_payment"))
    .map(({ body }) => JSON.parse(body));
  assert.deepEqual(payments, [{
    p_cafe_user_id: CAFE_ID,
    p_provider_payment_id: "refund:ch_refund_owner",
    p_amount_cents: 400,
    p_currency: "usd",
    p_status: "refunded",
    p_paid_at: new Date(eventCreated * 1000).toISOString(),
    p_event_created_at: new Date(eventCreated * 1000).toISOString(),
  }]);
  assert.ok(calls.some(({ url }) => url.includes("stripe_customer_id=eq.cus_refund_owner") && url.includes("stripe_subscription_id=eq.sub_refund_owner")));
});

test("unlinked, ambiguous, wrong-Price, and DB-stale refunds are acknowledged without contaminating plan revenue", async (t) => {
  const calls = [];
  setup(t, databaseRecorder(calls, {
    user_id: CAFE_ID,
    status: "active",
    stripe_customer_id: "cus_refund_owner",
    stripe_subscription_id: "sub_refund_owner",
  }));
  const stripe = stripeApiClient();
  let scenario;
  replaceMethod(t, stripe.charges, "retrieve", async (chargeId) => ({
    id: chargeId,
    livemode: false,
    paid: true,
    customer: "cus_refund_owner",
    payment_intent: `pi_${scenario}`,
    amount_refunded: 400,
    currency: "usd",
  }));
  replaceMethod(t, stripe.invoicePayments, "list", async () => {
    if (scenario === "unlinked") return { data: [], has_more: false };
    const payment = {
      id: `inpay_${scenario}`,
      status: "paid",
      livemode: false,
      currency: "usd",
      amount_paid: 999,
      invoice: `in_${scenario}`,
      payment: { type: "payment_intent", payment_intent: `pi_${scenario}` },
    };
    if (scenario === "ambiguous") return { data: [payment], has_more: true };
    return { data: [payment], has_more: false };
  });
  replaceMethod(t, stripe.invoices, "retrieve", async (invoiceId) => ({
    id: invoiceId,
    livemode: false,
    currency: "usd",
    customer: scenario === "foreign_customer" ? "cus_someone_else" : "cus_refund_owner",
    parent: {
      type: "subscription_details",
      subscription_details: { subscription: scenario === "stale_db" ? "sub_stale_db" : "sub_refund_owner" },
    },
  }));
  replaceMethod(t, stripe.subscriptions, "retrieve", async (subscriptionId) => ({
    id: subscriptionId,
    livemode: false,
    status: "active",
    customer: "cus_refund_owner",
    metadata: { cafe_user_id: CAFE_ID },
    items: { data: [{ price: { id: scenario === "wrong_price" ? "price_other" : "price_baristamatch" } }] },
  }));

  for (const [index, candidate] of ["unlinked", "ambiguous", "foreign_customer", "wrong_price", "stale_db"].entries()) {
    scenario = candidate;
    const payload = eventPayload(`evt_refund_rejected_${index}`, "charge.refunded", { id: `ch_${candidate}` });
    const res = response();
    await handler(request(payload), res);
    assert.equal(res.statusCode, 200, candidate);
    assert.deepEqual(res.body, { received: true }, candidate);
  }
  assert.equal(calls.some(({ url }) => url.endsWith("/rpc/record_stripe_subscription_payment")), false);
  assert.equal(calls.filter(({ url }) => url.endsWith("/rpc/complete_stripe_webhook_event")).length, 5);
});
