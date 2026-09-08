import test from "node:test";
import assert from "node:assert/strict";
import { stripeMode, subscriptionCanBeManaged, subscriptionHasPaidAccess, subscriptionIsConnected, subscriptionUsesConfiguredPrice, validateConfiguredPrice } from "../api/_billing.js";
import { checkoutSessionBelongsToCafe, checkoutSessionCanFulfill } from "../api/billing.js";

const configuredPrice = {
  id: "price_baristamatch",
  active: true,
  livemode: true,
  currency: "usd",
  unit_amount: 999,
  type: "recurring",
  recurring: { interval: "month", interval_count: 1 },
  metadata: {
    application: "baristamatch",
    plan: "cafe_monthly",
    stripe_account_id: "acct_baristamatch",
  },
};

test("Stripe mode is test by default and only becomes live explicitly", () => {
  assert.equal(stripeMode({}), "test");
  assert.equal(stripeMode({ STRIPE_LIVEMODE: "false" }), "test");
  assert.equal(stripeMode({ STRIPE_LIVEMODE: "true" }), "live");
});

test("accepts only the configured active $9.99 monthly live Price", () => {
  assert.equal(validateConfiguredPrice(configuredPrice, {
    accountId: "acct_baristamatch",
    priceId: "price_baristamatch",
    mode: "live",
  }), true);
});

test("rejects a Price from another mode, account, amount, or plan", () => {
  const expected = { accountId: "acct_baristamatch", priceId: "price_baristamatch", mode: "live" };
  assert.equal(validateConfiguredPrice({ ...configuredPrice, livemode: false }, expected), false);
  assert.equal(validateConfiguredPrice({ ...configuredPrice, unit_amount: 1099 }, expected), false);
  assert.equal(validateConfiguredPrice({ ...configuredPrice, metadata: { ...configuredPrice.metadata, stripe_account_id: "acct_other" } }, expected), false);
  assert.equal(validateConfiguredPrice({ ...configuredPrice, metadata: { ...configuredPrice.metadata, plan: "other" } }, expected), false);
});

test("webhook reconciliation accepts an archived canonical Price but not a mismatched one", () => {
  const expected = { accountId: "acct_baristamatch", priceId: "price_baristamatch", mode: "live", requireActive: false };
  assert.equal(validateConfiguredPrice({ ...configuredPrice, active: false }, expected), true);
  assert.equal(validateConfiguredPrice({ ...configuredPrice, active: false, unit_amount: 1000 }, expected), false);
});

test("subscription fulfillment requires the configured Price", () => {
  const subscription = { items: { data: [{ price: { id: "price_baristamatch" } }] } };
  assert.equal(subscriptionUsesConfiguredPrice(subscription, "price_baristamatch"), true);
  assert.equal(subscriptionUsesConfiguredPrice(subscription, "price_other"), false);
  assert.equal(subscriptionUsesConfiguredPrice({}, "price_baristamatch"), false);
});

test("only paid lifecycle states grant Pro while recoverable states remain manageable", () => {
  assert.equal(subscriptionHasPaidAccess("active"), true);
  assert.equal(subscriptionHasPaidAccess("trialing"), true);
  for (const status of ["past_due", "unpaid", "incomplete", "paused", "canceled", "expired"]) {
    assert.equal(subscriptionHasPaidAccess(status), false);
  }
  for (const status of ["active", "trialing", "past_due", "unpaid", "incomplete", "paused"]) {
    assert.equal(subscriptionCanBeManaged({ status }), true);
  }
  assert.equal(subscriptionCanBeManaged({ status: "canceled" }), false);
  assert.equal(subscriptionCanBeManaged({ status: "expired" }), false);
});

test("billing is connected only when both Stripe identifiers are present and well formed", () => {
  assert.equal(subscriptionIsConnected({ stripe_customer_id: "cus_cafe", stripe_subscription_id: "sub_cafe" }), true);
  assert.equal(subscriptionIsConnected({ stripe_customer_id: "cus_cafe", stripe_subscription_id: null }), false);
  assert.equal(subscriptionIsConnected({ stripe_customer_id: null, stripe_subscription_id: "sub_cafe" }), false);
  assert.equal(subscriptionIsConnected({ stripe_customer_id: "customer_cafe", stripe_subscription_id: "sub_cafe" }), false);
  assert.equal(subscriptionIsConnected({ stripe_customer_id: "cus_cafe", stripe_subscription_id: "subscription_cafe" }), false);
});

test("Checkout fulfillment requires a completed paid session owned by the café", () => {
  const session = {
    status: "complete",
    payment_status: "paid",
    mode: "subscription",
    subscription: "sub_one",
    client_reference_id: "cafe_one",
    customer: "cus_one",
    metadata: { cafe_user_id: "cafe_one" },
  };
  assert.equal(checkoutSessionCanFulfill(session), true);
  assert.equal(checkoutSessionCanFulfill({ ...session, payment_status: "no_payment_required" }), true);
  assert.equal(checkoutSessionCanFulfill({ ...session, payment_status: "unpaid" }), false);
  assert.equal(checkoutSessionCanFulfill({ ...session, status: "open" }), false);
  assert.equal(checkoutSessionCanFulfill({ ...session, mode: "payment" }), false);
  assert.equal(checkoutSessionCanFulfill({ ...session, subscription: null }), false);
  assert.equal(checkoutSessionBelongsToCafe(session, "cafe_one", "cus_one"), true);
  assert.equal(checkoutSessionBelongsToCafe({ ...session, mode: "payment" }, "cafe_one", "cus_one"), false);
  assert.equal(checkoutSessionBelongsToCafe({ ...session, client_reference_id: "cafe_two" }, "cafe_one", "cus_one"), false);
  assert.equal(checkoutSessionBelongsToCafe({ ...session, metadata: { cafe_user_id: "cafe_two" } }, "cafe_one", "cus_one"), false);
  assert.equal(checkoutSessionBelongsToCafe({ ...session, customer: "cus_two" }, "cafe_one", "cus_one"), false);
});
