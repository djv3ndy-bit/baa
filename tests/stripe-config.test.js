import test from "node:test";
import assert from "node:assert/strict";
import { stripeMode, subscriptionUsesConfiguredPrice, validateConfiguredPrice } from "../api/_billing.js";

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

test("subscription fulfillment requires the configured Price", () => {
  const subscription = { items: { data: [{ price: { id: "price_baristamatch" } }] } };
  assert.equal(subscriptionUsesConfiguredPrice(subscription, "price_baristamatch"), true);
  assert.equal(subscriptionUsesConfiguredPrice(subscription, "price_other"), false);
  assert.equal(subscriptionUsesConfiguredPrice({}, "price_baristamatch"), false);
});
