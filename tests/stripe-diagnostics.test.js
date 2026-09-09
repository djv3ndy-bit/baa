import test from "node:test";
import assert from "node:assert/strict";
import handler from "../api/billing.js";
import { stripeApiClient, stripeErrorDiagnostics, stripeOperation } from "../api/_billing.js";

const CAFE = "11111111-1111-4111-8111-111111111111";
const PRIVATE_MESSAGE = "rk_live_never_log_this cafe@example.com raw private response";
const providerError = () => Object.assign(new Error(PRIVATE_MESSAGE), {
  type: "StripeInvalidRequestError", code: "resource_missing", param: "line_items[0][price]",
  requestId: "req_Diagnostic123", statusCode: 404,
  raw: { message: PRIVATE_MESSAGE }, headers: { authorization: PRIVATE_MESSAGE },
});

test("Stripe diagnostics retain actionable fields without provider messages, credentials, or response payloads", () => {
  assert.deepEqual(stripeErrorDiagnostics(providerError(), "checkout"), {
    stage: "checkout", type: "StripeInvalidRequestError", code: "resource_missing",
    param: "line_items[0][price]", requestId: "req_Diagnostic123", statusCode: 404,
  });
  for (const value of ["rk_live_secret", "rk_test_secret", "sk_live_secret", "whsec_secret", "sb_secret_key", "BearerToken", "cafe@example.com", "bad\nvalue", "x".repeat(121)]) {
    assert.deepEqual(stripeErrorDiagnostics({ type: value, code: value, param: value, requestId: value, statusCode: "404" }, value), { stage: "billing" });
  }
  for (const value of ["cus_private_fixture", "sub_private", "cs_live_private", "ch_private", "pi_private", "pm_private", "seti_private", "src_private", "in_private", "price_private", "prod_private", "acct_private", "card_private", "tok_private", "metadata[cus_private]", "https://private.example.com"]) {
    assert.deepEqual(stripeErrorDiagnostics({ type: value, code: value, param: value }, "checkout"), { stage: "checkout" });
  }
  assert.deepEqual(stripeErrorDiagnostics(new Error(PRIVATE_MESSAGE), "checkout"), { stage: "checkout" });
  assert.deepEqual(stripeErrorDiagnostics(PRIVATE_MESSAGE, "checkout"), { stage: "checkout" });
});

test("operation diagnostics preserve original errors and their innermost stage across concurrent requests", async () => {
  const first = Object.freeze(providerError()), second = providerError();
  const outcomes = await Promise.allSettled([
    stripeOperation("price_validation", () => stripeOperation("price_retrieve", async () => { throw first; })),
    stripeOperation("customer_create", async () => { throw second; }),
  ]);
  assert.equal(outcomes[0].reason, first);
  assert.equal(outcomes[1].reason, second);
  assert.equal(stripeErrorDiagnostics(first).stage, "price_retrieve");
  assert.equal(stripeErrorDiagnostics(second).stage, "customer_create");
  assert.equal(await stripeOperation("checkout_create", async () => "unchanged"), "unchanged");
});

test("Stripe replay diagnostics expose only a validated boolean without leaking response headers", () => {
  for (const [header, expected] of [["true", true], [true, true], ["false", false], [false, false]]) {
    const error = Object.assign(new Error(PRIVATE_MESSAGE), {
      headers: { "idempotent-replayed": header, authorization: PRIVATE_MESSAGE, "set-cookie": PRIVATE_MESSAGE },
    });
    assert.deepEqual(stripeErrorDiagnostics(error, "checkout_create"), {
      stage: "checkout_create", idempotentReplayed: expected,
    });
  }
  for (const header of [PRIVATE_MESSAGE, "true\n", "TRUE", 1, [], {}, null]) {
    assert.deepEqual(stripeErrorDiagnostics({ headers: { "idempotent-replayed": header } }, "checkout_create"), {
      stage: "checkout_create",
    });
  }
});

function replace(t, object, key, value) {
  const previous = object[key], owned = Object.hasOwn(object, key);
  object[key] = value;
  t.after(() => { if (owned) object[key] = previous; else delete object[key]; });
}

test("real billing handlers report the failing Stripe stage and keep the frontend response generic", async t => {
  const environment = {
    STRIPE_RESTRICTED_KEY: "rk_test_mock_only", STRIPE_LIVEMODE: "false", VERCEL_ENV: "preview",
    STRIPE_MONTHLY_PRICE_ID: "price_diagnostics", STRIPE_ACCOUNT_ID: "acct_diagnostics",
    BILLING_ENABLED: "true", PUBLIC_SITE_URL: "https://www.baristajobmatch.com",
    SUPABASE_URL: "https://fixture.invalid", SUPABASE_PUBLISHABLE_KEY: "fixture",
    SUPABASE_SECRET_KEY: "sb_secret_fixture",
  };
  const previous = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]));
  Object.assign(process.env, environment);
  t.after(() => { for (const key of Object.keys(environment)) previous[key] === undefined ? delete process.env[key] : process.env[key] = previous[key]; });
  const stripe = stripeApiClient();

  // Price failure runs before the first successful cached Price validation.
  for (const stage of ["price_retrieve", "price_validation", "customer_create", "customer_search", "customer_list", "subscriptions_list", "checkout_list", "checkout_expire", "checkout_create", "customer_retrieve"]) {
    await t.test(stage, async t => {
      const logs = [], releases = [];
      const error = providerError();
      const recovering = stage === "customer_search" || stage === "customer_list";
      const portal = stage === "customer_retrieve";
      const failAt = (name, result) => async () => { if (stage === name) throw error; return result; };
      replace(t, console, "error", (...args) => logs.push(args));
      if (stage === "price_validation") {
        delete process.env.STRIPE_ACCOUNT_ID;
        t.after(() => { process.env.STRIPE_ACCOUNT_ID = environment.STRIPE_ACCOUNT_ID; });
      }
      replace(t, globalThis, "fetch", async (url, init = {}) => {
        const target = String(url), body = init.body ? JSON.parse(init.body) : {};
        if (target.endsWith("/auth/v1/user")) return Response.json({ id: CAFE, email: "cafe@example.com" });
        if (target.includes("/profiles?")) return Response.json([{ role: "cafe_owner_manager", cafe_name: "Fixture Café", suspended_at: null }]);
        if (target.includes("/cafe_subscriptions?")) return Response.json([{
          user_id: CAFE, status: portal ? "active" : "free", stripe_customer_id: portal ? "cus_diagnostics" : null,
          stripe_subscription_id: portal ? "sub_diagnostics" : null,
          stripe_subscription_event_created_at: null, stripe_subscription_sync_revision: 0,
        }]);
        if (target.endsWith("/rpc/claim_stripe_checkout")) return Response.json({ attemptId: body.p_attempt_id, channel: body.p_channel, recovered: recovering });
        if (target.endsWith("/rpc/stripe_checkout_claim_is_current")) return Response.json(true);
        if (target.endsWith("/rpc/attach_stripe_checkout_customer")) return Response.json("attached");
        if (target.endsWith("/rpc/release_stripe_checkout")) { releases.push(body); return Response.json(true); }
        assert.fail(`Unexpected database request: ${target}`);
      });
      replace(t, stripe.prices, "retrieve", failAt("price_retrieve", {
        id: "price_diagnostics", active: true, livemode: false, currency: "usd", unit_amount: 999,
        type: "recurring", recurring: { interval: "month", interval_count: 1 },
        metadata: { application: "baristamatch", plan: "cafe_monthly", stripe_account_id: "acct_diagnostics" },
      }));
      replace(t, stripe.customers, "create", failAt("customer_create", { id: "cus_diagnostics" }));
      replace(t, stripe.customers, "search", failAt("customer_search", { data: [], has_more: false }));
      replace(t, stripe.customers, "list", failAt("customer_list", { data: [], has_more: false }));
      replace(t, stripe.customers, "retrieve", failAt("customer_retrieve", {}));
      replace(t, stripe.subscriptions, "list", failAt("subscriptions_list", { data: [], has_more: false }));
      replace(t, stripe.checkout.sessions, "list", failAt("checkout_list", {
        data: stage === "checkout_expire" ? [{ id: "cs_old", mode: "subscription" }] : [], has_more: false,
      }));
      replace(t, stripe.checkout.sessions, "expire", failAt("checkout_expire", {}));
      replace(t, stripe.checkout.sessions, "create", failAt("checkout_create", { url: "https://checkout.stripe.com/fixture" }));
      const req = {
        method: "POST", query: { action: portal ? "portal" : "checkout" }, headers: { authorization: "Bearer fixture" },
        async *[Symbol.asyncIterator]() { yield Buffer.from('{"channel":"web"}'); },
      };
      const res = { statusCode: 200, setHeader() {}, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
      await handler(req, res);
      assert.equal(res.statusCode, 502);
      assert.deepEqual(res.body, { error: portal ? "Billing management could not be opened. Please try again." : "Secure checkout could not be opened. Please try again." });
      assert.equal(logs.length, 1);
      assert.equal(logs[0][0], portal ? "Stripe portal failed" : "Stripe Checkout failed");
      assert.deepEqual(logs[0][1], stage === "price_validation" ? { stage } : {
        stage, type: "StripeInvalidRequestError", code: "resource_missing", param: "line_items[0][price]",
        requestId: "req_Diagnostic123", statusCode: 404,
      });
      assert.equal(JSON.stringify(logs).includes(PRIVATE_MESSAGE), false);
      if (!portal) assert.equal(releases.length, 1, "Diagnostics must retain claim cleanup.");
      if (stage === "customer_create") assert.equal(releases[0].p_clear_attempt, true, "A conclusive customer rejection must retain existing recovery behavior.");
      if (stage === "checkout_create") assert.equal(releases[0].p_clear_attempt, false, "Diagnostics must retain the durable Checkout attempt.");
    });
  }
});
