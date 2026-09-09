import test from "node:test";
import assert from "node:assert/strict";
import handler from "../api/billing.js";
import { stripeApiClient, stripePublishableKey } from "../api/_billing.js";

const CAFE = "11111111-1111-4111-8111-111111111111";
const OLD_ATTEMPT = "33333333-3333-4333-8333-333333333333";
const SITE = "https://www.baristajobmatch.com";
const EMBEDDED = { channel: "web", uiMode: "embedded" };

function replace(t, object, key, value) {
  const previous = object[key], owned = Object.hasOwn(object, key);
  object[key] = value;
  t.after(() => { if (owned) object[key] = previous; else delete object[key]; });
}

function request(body) {
  return {
    method: "POST", query: { action: "checkout" }, headers: { authorization: "Bearer fixture" },
    async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)); },
  };
}

function response() {
  return {
    statusCode: 200, body: null, headers: {},
    setHeader(key, value) { this.headers[key] = value; },
    status(value) { this.statusCode = value; return this; },
    json(value) { this.body = value; return this; },
  };
}

function session(id = "cs_test_Embedded123", uiMode = "embedded") {
  return {
    id, mode: "subscription", ui_mode: uiMode === "embedded" ? "embedded_page" : "hosted_page",
    livemode: false, status: "open", payment_status: "unpaid", customer: "cus_fixture",
    client_reference_id: CAFE, metadata: { cafe_user_id: CAFE, checkout_channel: "web" },
    line_items: { data: [{ price: { id: "price_embedded" }, quantity: 1 }] },
    managed_payments: { enabled: true },
    url: uiMode === "hosted" ? `https://checkout.stripe.com/c/pay/${id}` : null,
    client_secret: uiMode === "embedded" ? `${id}_secret_private123` : null,
    customer_details: { email: "private@example.com" },
  };
}

function fixture(t, recoveredUiMode = null) {
  const env = {
    STRIPE_RESTRICTED_KEY: "rk_test_mock_only", STRIPE_PUBLISHABLE_KEY: "pk_test_fixture",
    STRIPE_LIVEMODE: "false", VERCEL_ENV: "preview", STRIPE_MONTHLY_PRICE_ID: "price_embedded",
    STRIPE_ACCOUNT_ID: "acct_embedded", BILLING_ENABLED: "true", PUBLIC_SITE_URL: SITE,
    SUPABASE_URL: "https://fixture.invalid", SUPABASE_PUBLISHABLE_KEY: "fixture", SUPABASE_SECRET_KEY: "sb_secret_fixture",
  };
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  t.after(() => { for (const key of Object.keys(env)) previous[key] === undefined ? delete process.env[key] : process.env[key] = previous[key]; });
  const state = { claimId: null, attemptId: recoveredUiMode ? OLD_ATTEMPT : null, channel: recoveredUiMode ? "web" : null, uiMode: recoveredUiMode };
  const calls = { claims: [], releases: [], creates: [], retrieves: [], expires: [], logs: [] };
  const control = { authenticated: true, suspended: false, sessions: [], subscriptions: [], createError: null, expireError: null };
  const stored = new Map();
  replace(t, globalThis, "fetch", async (url, init = {}) => {
    const target = String(url), body = init.body ? JSON.parse(init.body) : null;
    if (target.endsWith("/auth/v1/user")) return control.authenticated ? Response.json({ id: CAFE }) : new Response("", { status: 401 });
    if (target.includes("/profiles?")) return Response.json([{ role: "cafe_owner_manager", suspended_at: control.suspended ? "2026-01-01" : null }]);
    if (target.includes("/cafe_subscriptions?")) return Response.json([{ user_id: CAFE, status: "free", stripe_customer_id: "cus_fixture", stripe_subscription_id: null }]);
    if (target.endsWith("/rpc/claim_stripe_checkout")) {
      if (state.claimId) return Response.json(null);
      const recovered = state.attemptId !== null;
      state.claimId = body.p_claim_id;
      state.attemptId ??= body.p_attempt_id;
      state.channel ??= body.p_channel;
      state.uiMode ??= body.p_ui_mode;
      calls.claims.push(body);
      return Response.json({ attemptId: state.attemptId, channel: state.channel, uiMode: state.uiMode, recovered });
    }
    if (target.endsWith("/rpc/stripe_checkout_claim_is_current")) return Response.json(state.claimId === body.p_claim_id);
    if (target.endsWith("/rpc/release_stripe_checkout")) {
      calls.releases.push(body);
      if (state.claimId !== body.p_claim_id) return Response.json(false);
      state.claimId = null;
      if (body.p_clear_attempt) { state.attemptId = null; state.channel = null; state.uiMode = null; }
      return Response.json(true);
    }
    assert.fail(`Unexpected database request ${target}`);
  });
  replace(t, console, "error", (...args) => calls.logs.push(args));
  const stripe = stripeApiClient();
  replace(t, stripe.prices, "retrieve", async () => ({ id: "price_embedded", active: true, livemode: false, currency: "usd", unit_amount: 999, type: "recurring", recurring: { interval: "month", interval_count: 1 }, metadata: { application: "baristamatch", plan: "cafe_monthly", stripe_account_id: "acct_embedded" } }));
  replace(t, stripe.customers, "create", async () => assert.fail("must preserve the attached Customer"));
  replace(t, stripe.customers, "del", async () => assert.fail("must preserve the attached Customer"));
  replace(t, stripe.subscriptions, "list", async () => ({ data: control.subscriptions, has_more: false }));
  replace(t, stripe.checkout.sessions, "list", async () => ({ data: control.sessions.filter(candidate => candidate.status === "open"), has_more: false }));
  replace(t, stripe.checkout.sessions, "create", async (params, options) => {
    calls.creates.push({ params, options });
    control.onCreate?.();
    if (control.createError) throw control.createError;
    const value = control.created || session(`cs_test_Created${calls.creates.length}`, params.ui_mode === "embedded_page" ? "embedded" : "hosted");
    value.metadata.checkout_channel = params.metadata.checkout_channel;
    stored.set(value.id, value);
    return structuredClone(value);
  });
  replace(t, stripe.checkout.sessions, "retrieve", async (id, params) => {
    calls.retrieves.push({ id, params });
    control.onRetrieve?.();
    if (control.retrieveError) throw control.retrieveError;
    return control.retrieved || stored.get(id) || control.sessions.find(value => value.id === id);
  });
  replace(t, stripe.checkout.sessions, "expire", async id => {
    calls.expires.push(id);
    if (control.expireError) throw control.expireError;
    const value = stored.get(id) || control.sessions.find(candidate => candidate.id === id);
    if (value) value.status = "expired";
    return { id, status: "expired" };
  });
  const run = async (body = EMBEDDED) => { const res = response(); await handler(request(body), res); return res; };
  return { state, calls, control, run };
}

test("embedded web Checkout mounts only an owned canonical session and keeps Managed Payments", async t => {
  const { calls, run } = fixture(t);
  const res = await run();
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { uiMode: "embedded", sessionId: "cs_test_Created1", clientSecret: "cs_test_Created1_secret_private123", publishableKey: "pk_test_fixture" });
  assert.equal(res.headers["Cache-Control"], "no-store");
  assert.equal(calls.claims[0].p_ui_mode, "embedded");
  const params = calls.creates[0].params;
  assert.equal(params.ui_mode, "embedded_page");
  assert.deepEqual(params.managed_payments, { enabled: true });
  assert.deepEqual(params.branding_settings, { background_color: "#FFFFFF", button_color: "#000000" });
  assert.equal(params.return_url, `${SITE}/dashboard.html?billing=success&session_id={CHECKOUT_SESSION_ID}`);
  assert.equal(params.redirect_on_completion, "if_required");
  assert.deepEqual(params.line_items, [{ price: "price_embedded", quantity: 1 }]);
  for (const field of ["success_url", "cancel_url", "payment_method_types", "automatic_tax", "tax_id_collection"]) assert.equal(field in params, false);
  assert.deepEqual(calls.retrieves[0].params, { expand: ["line_items"] });
  assert.equal(JSON.stringify(calls.logs).includes("private"), false);
  assert.equal(calls.releases[0].p_clear_attempt, true);
});

test("mobile and legacy website requests retain hosted checkout without a publishable key", async t => {
  for (const body of [{ channel: "mobile", uiMode: "embedded" }, {}]) await t.test(JSON.stringify(body), async t => {
    const { calls, run } = fixture(t);
    delete process.env.STRIPE_PUBLISHABLE_KEY;
    const res = await run(body);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(Object.keys(res.body), ["url"]);
    const params = calls.creates[0].params, mobile = body.channel === "mobile";
    assert.equal(calls.claims[0].p_ui_mode, "hosted");
    assert.equal(params.success_url, `${SITE}/${mobile ? "mobile-billing-return.html" : "dashboard.html"}?billing=success&session_id={CHECKOUT_SESSION_ID}`);
    assert.equal(params.cancel_url, `${SITE}/${mobile ? "mobile-billing-return.html" : "dashboard.html"}?billing=canceled`);
    for (const field of ["ui_mode", "managed_payments", "return_url", "redirect_on_completion", "branding_settings"]) assert.equal(field in params, false);
    assert.equal(calls.retrieves.length, 0);
  });
});

test("a matching open embedded Checkout is retrieved and reused without creating another session", async t => {
  const { calls, control, run } = fixture(t);
  control.sessions = [session()];
  const res = await run();
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.reused, true);
  assert.equal(res.body.sessionId, control.sessions[0].id);
  assert.equal(calls.creates.length, 0);
  assert.equal(calls.expires.length, 0);
  assert.equal(calls.retrieves.length, 1);
});

test("a recovered embedded attempt resolves its durable key before exposing a listed session secret", async t => {
  const { calls, control, run } = fixture(t, "embedded");
  control.sessions = [session()];
  control.created = control.sessions[0];
  const res = await run();
  assert.equal(res.statusCode, 200);
  assert.equal(calls.creates.length, 1);
  assert.equal(calls.creates[0].options.idempotencyKey, `baristamatch-checkout-${CAFE}-${OLD_ATTEMPT}`);
  assert.equal(res.body.sessionId, control.sessions[0].id);
  assert.equal(calls.expires.length, 0);
});

test("opaque embedded client secrets survive creation, reuse, and durable recovery unchanged", async t => {
  for (const path of ["creation", "reuse", "recovery"]) await t.test(path, async t => {
    const { calls, control, state, run } = fixture(t, path === "recovery" ? "embedded" : null);
    const ownedSession = session("cs_test_Opaque123");
    // Synthetic encoded token: no real Stripe credential or response is used.
    ownedSession.client_secret = `${ownedSession.id}_secret_synthetic_private_%2Fpart_%3D`;
    if (path !== "creation") control.sessions = [ownedSession];
    control.created = ownedSession;
    const res = await run();
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.clientSecret, ownedSession.client_secret);
    assert.equal(res.body.sessionId, ownedSession.id);
    assert.equal(res.body.reused, path === "reuse" ? true : undefined);
    assert.equal(calls.creates.length, path === "reuse" ? 0 : 1);
    assert.deepEqual(calls.retrieves, [{ id: ownedSession.id, params: { expand: ["line_items"] } }]);
    assert.equal(calls.expires.length, 0);
    if (path === "recovery") {
      assert.equal(calls.creates[0].options.idempotencyKey, `baristamatch-checkout-${CAFE}-${OLD_ATTEMPT}`);
    }
    assert.equal(state.attemptId, null);
    assert.equal(calls.releases[0].p_clear_attempt, true);
    assert.equal(JSON.stringify(calls.logs).includes("private"), false);
  });
});

test("embedded secrets are withheld for mismatched or malformed Stripe sessions", async t => {
  const mutations = [
    ["session id", value => { value.id = "cs_test_Other"; }],
    ["customer", value => { value.customer = "cus_other"; }],
    ["reference", value => { value.client_reference_id = "another-user"; }],
    ["owner", value => { value.metadata.cafe_user_id = "another-user"; }],
    ["mode", value => { value.mode = "payment"; }],
    ["live mode", value => { value.livemode = true; }],
    ["UI mode", value => { value.ui_mode = "hosted"; }],
    ["channel", value => { value.metadata.checkout_channel = "app"; }],
    ["price", value => { value.line_items.data[0].price.id = "price_other"; }],
    ["extra item", value => { value.line_items.data.push(value.line_items.data[0]); }],
    ["quantity", value => { value.line_items.data[0].quantity = 2; }],
    ["Managed Payments", value => { value.managed_payments.enabled = false; }],
    ["missing secret", value => { value.client_secret = null; }],
    ["empty secret suffix", value => { value.client_secret = `${value.id}_secret_`; }],
    ["another secret", value => { value.client_secret = "cs_test_Other_secret_private123"; }],
  ];
  for (const [name, mutate] of mutations) await t.test(name, async t => {
    const { calls, control, run } = fixture(t);
    control.sessions = [session()];
    control.retrieved = structuredClone(control.sessions[0]);
    mutate(control.retrieved);
    const res = await run();
    assert.equal(res.statusCode, 502);
    assert.deepEqual(res.body, { error: "Secure checkout could not be opened. Please try again." });
    assert.equal(JSON.stringify(calls.logs).includes("private"), false);
    assert.equal(calls.creates.length, 0);
  });
});

test("an authoritative closed session settles recovery without returning its secret or creating another session", async t => {
  for (const status of ["complete", "expired"]) await t.test(status, async t => {
    const { state, calls, control, run } = fixture(t, "embedded");
    control.retrieved = session("cs_test_Created1");
    control.retrieved.status = status;
    const res = await run();
    assert.equal(res.statusCode, 409);
    assert.equal(res.body.retryCheckout, status === "expired" ? true : undefined);
    assert.equal("clientSecret" in res.body, false);
    assert.equal(calls.creates.length, 1);
    assert.equal(calls.expires.length, 0);
    assert.equal(state.attemptId, null);
    assert.equal(calls.releases[0].p_clear_attempt, true);
  });
});

test("embedded Checkout fails before claiming or Stripe calls when authentication or the public key is invalid", async t => {
  for (const variant of ["unauthenticated", "suspended", "missing key", "wrong key mode", "secret key"]) await t.test(variant, async t => {
    const { calls, control, run } = fixture(t);
    if (variant === "unauthenticated") control.authenticated = false;
    if (variant === "suspended") control.suspended = true;
    if (variant === "missing key") delete process.env.STRIPE_PUBLISHABLE_KEY;
    if (variant === "wrong key mode") process.env.STRIPE_PUBLISHABLE_KEY = "pk_live_fixture";
    if (variant === "secret key") process.env.STRIPE_PUBLISHABLE_KEY = "rk_test_private";
    const res = await run();
    assert.equal(res.statusCode, variant === "unauthenticated" ? 401 : variant === "suspended" ? 403 : 502);
    assert.equal(calls.claims.length, 0);
    assert.equal(calls.creates.length, 0);
    assert.equal(JSON.stringify(res.body).includes("private"), false);
  });
  assert.equal(stripePublishableKey({ STRIPE_LIVEMODE: "true", STRIPE_PUBLISHABLE_KEY: "pk_live_fixture" }), "pk_live_fixture");
});

test("changing a recovered hosted attempt resolves its original payload before a fresh embedded attempt", async t => {
  const { state, calls, run } = fixture(t, "hosted");
  const refreshed = await run();
  assert.equal(refreshed.statusCode, 409);
  assert.equal(refreshed.body.retryCheckout, true);
  assert.equal(calls.creates.length, 1);
  assert.equal(calls.creates[0].options.idempotencyKey, `baristamatch-checkout-${CAFE}-${OLD_ATTEMPT}`);
  assert.deepEqual(calls.creates[0].params, {
    mode: "subscription", customer: "cus_fixture", client_reference_id: CAFE,
    line_items: [{ price: "price_embedded", quantity: 1 }],
    success_url: `${SITE}/dashboard.html?billing=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${SITE}/dashboard.html?billing=canceled`, integration_identifier: "baristamatch_web_qtmzjvka",
    metadata: { cafe_user_id: CAFE, checkout_channel: "web" }, subscription_data: { metadata: { cafe_user_id: CAFE } }, allow_promotion_codes: true,
  });
  assert.deepEqual(calls.expires, ["cs_test_Created1"]);
  assert.equal(state.attemptId, null);
  const embedded = await run();
  assert.equal(embedded.statusCode, 200);
  assert.equal(calls.creates[1].params.ui_mode, "embedded_page");
  assert.notEqual(calls.creates[1].options.idempotencyKey, calls.creates[0].options.idempotencyKey);
});

test("a recovered hosted session is replayed before conversion even when an open session was discovered", async t => {
  const { calls, control, run } = fixture(t, "hosted");
  control.sessions = [session("cs_test_Original", "hosted")];
  control.created = control.sessions[0];
  const res = await run();
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.retryCheckout, true);
  assert.equal(calls.creates.length, 1, "listing a session must not substitute for resolving the durable key");
  assert.equal(calls.creates[0].options.idempotencyKey, `baristamatch-checkout-${CAFE}-${OLD_ATTEMPT}`);
  assert.deepEqual(calls.expires, ["cs_test_Original"]);
});

test("a legacy hosted UI value can also be retired during mode recovery", async t => {
  const { state, calls, control, run } = fixture(t, "hosted");
  control.created = session("cs_test_Legacy", "hosted");
  control.created.ui_mode = "hosted";
  const res = await run();
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.retryCheckout, true);
  assert.deepEqual(calls.expires, ["cs_test_Legacy"]);
  assert.equal(state.attemptId, null);
});

test("a fresh embedded attempt retires an old hosted session before creating the onsite form", async t => {
  const { calls, control, run } = fixture(t);
  control.sessions = [session("cs_test_Previous", "hosted")];
  const res = await run();
  assert.equal(res.statusCode, 200);
  assert.deepEqual(calls.expires, ["cs_test_Previous"]);
  assert.equal(calls.creates.length, 1);
  assert.equal(calls.creates[0].params.ui_mode, "embedded_page");
});

test("completion racing an expiration retains recovery until authoritative completion is observed", async t => {
  const { state, calls, control, run } = fixture(t, "hosted");
  control.expireError = Object.assign(new Error("already completed"), { type: "StripeInvalidRequestError", statusCode: 400 });
  const first = await run();
  assert.equal(first.statusCode, 502);
  assert.equal(state.attemptId, OLD_ATTEMPT);
  assert.equal(calls.releases[0].p_clear_attempt, false);
  control.expireError = null;
  control.retrieved = session("cs_test_Created2", "hosted");
  control.retrieved.status = "complete";
  const second = await run();
  assert.equal(second.statusCode, 409);
  assert.equal(second.body.retryCheckout, undefined);
  assert.equal(state.attemptId, null);
  assert.equal(calls.creates[1].options.idempotencyKey, calls.creates[0].options.idempotencyKey);
  assert.equal(calls.expires.length, 1);
});

test("a mobile request cannot rewrite a recovered embedded payload", async t => {
  const { calls, state, run } = fixture(t, "embedded");
  const refreshed = await run({ channel: "mobile" });
  assert.equal(refreshed.statusCode, 409);
  assert.equal(refreshed.body.retryCheckout, true);
  assert.equal(calls.creates[0].params.ui_mode, "embedded_page");
  assert.equal(calls.creates[0].params.metadata.checkout_channel, "web");
  assert.equal(state.attemptId, null);
  const hosted = await run({ channel: "mobile" });
  assert.equal(hosted.statusCode, 200);
  assert.equal(calls.creates[1].params.ui_mode, undefined);
  assert.equal(calls.creates[1].params.metadata.checkout_channel, "app");
});

test("mode changes retain the original key when creation, verification, or expiration is uncertain", async t => {
  for (const stage of ["create", "retrieve", "expire"]) await t.test(stage, async t => {
    const { state, calls, control, run } = fixture(t, "hosted");
    control[`${stage}Error`] = new Error("private provider failure");
    const first = await run();
    assert.equal(first.statusCode, 502);
    assert.equal(state.attemptId, OLD_ATTEMPT);
    assert.equal(state.uiMode, "hosted");
    assert.equal(calls.releases[0].p_clear_attempt, false);
    const second = await run();
    assert.equal(second.statusCode, 502);
    assert.equal(calls.creates[0].options.idempotencyKey, calls.creates[1].options.idempotencyKey);
    assert.deepEqual(calls.creates[0].params, calls.creates[1].params);
  });
});

test("losing the lease before secret delivery or UI conversion preserves the successor", async t => {
  for (const originalUiMode of [null, "hosted"]) await t.test(originalUiMode || "fresh embedded", async t => {
    const { state, calls, control, run } = fixture(t, originalUiMode);
    const successor = { claimId: "44444444-4444-4444-8444-444444444444", attemptId: "55555555-5555-4555-8555-555555555555", channel: "app", uiMode: "hosted" };
    control.onRetrieve = () => Object.assign(state, successor);
    const res = await run();
    assert.equal(res.statusCode, 409);
    assert.equal("clientSecret" in res.body, false);
    assert.equal(calls.expires.length, 0);
    assert.deepEqual(state, successor);
  });
});
