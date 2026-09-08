import Stripe from "stripe";

let stripeClientPromise;
let stripeWebhookClientPromise;
let stripeApiClientInstance;

const PAID_STATUSES = new Set(["active", "trialing"]);
const MANAGEABLE_STATUSES = new Set(["active", "trialing", "past_due", "unpaid", "incomplete", "paused"]);

export function stripeMode(environment = process.env) {
  return environment.STRIPE_LIVEMODE === "true" ? "live" : "test";
}

export function validateConfiguredPrice(price, { accountId, priceId, mode, requireActive = true }) {
  const liveMode = mode === "live";
  return Boolean(
    price &&
    price.id === priceId &&
    (!requireActive || price.active === true) &&
    price.livemode === liveMode &&
    price.currency === "usd" &&
    price.unit_amount === 999 &&
    price.type === "recurring" &&
    price.recurring?.interval === "month" &&
    price.recurring?.interval_count === 1 &&
    price.metadata?.application === "baristamatch" &&
    price.metadata?.plan === "cafe_monthly" &&
    price.metadata?.stripe_account_id === accountId
  );
}

export function subscriptionUsesConfiguredPrice(subscription, priceId) {
  return Boolean(subscription?.items?.data?.some((item) => item?.price?.id === priceId));
}

export function subscriptionHasPaidAccess(subscription) {
  const status = typeof subscription === "string" ? subscription : subscription?.status;
  return PAID_STATUSES.has(status);
}

export function subscriptionCanBeManaged(subscription) {
  const status = typeof subscription === "string" ? subscription : subscription?.status;
  return MANAGEABLE_STATUSES.has(status);
}

export function subscriptionIsConnected(subscription) {
  return Boolean(
    /^cus_[A-Za-z0-9_]+$/.test(String(subscription?.stripe_customer_id || "")) &&
    /^sub_[A-Za-z0-9_]+$/.test(String(subscription?.stripe_subscription_id || ""))
  );
}

export function stripeApiClient() {
  const key = process.env.STRIPE_RESTRICTED_KEY;
  const mode = stripeMode();
  if (!key) throw new Error("Stripe is not configured.");
  if (!key.startsWith(mode === "live" ? "rk_live_" : "rk_test_")) {
    throw new Error(`Stripe ${mode} mode requires a matching restricted key.`);
  }
  if (!stripeApiClientInstance) stripeApiClientInstance = new Stripe(key, { apiVersion: "2026-07-29.dahlia" });
  return stripeApiClientInstance;
}

export function constructStripeEvent(payload, signature, secret) {
  return Stripe.webhooks.constructEvent(payload, signature, secret);
}

export async function stripeClient() {
  const expectedAccountId = process.env.STRIPE_ACCOUNT_ID;
  const priceId = process.env.STRIPE_MONTHLY_PRICE_ID;
  const mode = stripeMode();
  if (!expectedAccountId?.startsWith("acct_")) throw new Error("The expected Stripe account is not configured.");
  if (!priceId?.startsWith("price_")) throw new Error("The Stripe monthly Price is not configured.");
  if (!stripeClientPromise) {
    stripeClientPromise = (async () => {
      const client = stripeApiClient();
      // A Price can only be retrieved with a key from its Stripe account. Its
      // metadata binds that account-specific resource to our explicit account
      // configuration without granting the key Accounts Read permission.
      const price = await client.prices.retrieve(priceId);
      if (!validateConfiguredPrice(price, { accountId: expectedAccountId, priceId, mode })) {
        throw new Error(`Stripe restricted key does not match the configured ${mode} plan and account.`);
      }
      return client;
    })().catch((error) => {
      stripeClientPromise = undefined;
      throw error;
    });
  }
  return stripeClientPromise;
}

export async function stripeWebhookClient() {
  const expectedAccountId = process.env.STRIPE_ACCOUNT_ID;
  const priceId = process.env.STRIPE_MONTHLY_PRICE_ID;
  const mode = stripeMode();
  if (!expectedAccountId?.startsWith("acct_")) throw new Error("The expected Stripe account is not configured.");
  if (!priceId?.startsWith("price_")) throw new Error("The Stripe monthly Price is not configured.");
  if (!stripeWebhookClientPromise) {
    stripeWebhookClientPromise = (async () => {
      const client = stripeApiClient();
      const price = await client.prices.retrieve(priceId);
      if (!validateConfiguredPrice(price, { accountId: expectedAccountId, priceId, mode, requireActive: false })) {
        throw new Error(`Stripe restricted key does not match the configured ${mode} webhook plan and account.`);
      }
      return client;
    })().catch((error) => {
      stripeWebhookClientPromise = undefined;
      throw error;
    });
  }
  return stripeWebhookClientPromise;
}
function adminHeaders(extra = {}) {
  const key = process.env.SUPABASE_SECRET_KEY;
  const headers = { apikey: key, "Content-Type": "application/json", ...extra };
  if (key && !key.startsWith("sb_secret_")) headers.Authorization = `Bearer ${key}`;
  return headers;
}
export async function adminRows(path, options = {}) {
  const response = await fetch(`${process.env.SUPABASE_URL}/rest/v1/${path}`, { ...options, headers: { ...adminHeaders(), ...(options.headers || {}) } });
  if (!response.ok) throw new Error(`Database request failed (${response.status}).`);
  const text = await response.text();
  return text ? JSON.parse(text) : [];
}
export async function authenticatedCafe(req) {
  const token = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!token) return null;
  const auth = await fetch(`${process.env.SUPABASE_URL}/auth/v1/user`, { headers: { apikey: process.env.SUPABASE_PUBLISHABLE_KEY, Authorization: `Bearer ${token}` } });
  if (!auth.ok) return null;
  const user = await auth.json();
  const profiles = await adminRows(`profiles?id=eq.${encodeURIComponent(user.id)}&select=role,cafe_name,display_name,suspended_at&limit=1`);
  return profiles[0]?.role === "cafe_owner_manager" ? { ...user, profile: profiles[0] } : null;
}
export async function subscriptionFor(userId) {
  const rows = await adminRows(`cafe_subscriptions?user_id=eq.${encodeURIComponent(userId)}&select=*&limit=1`);
  return rows[0] || null;
}
export function origin(req) {
  const configured = String(process.env.PUBLIC_SITE_URL || "").replace(/\/$/, "");
  return configured || `${req.headers["x-forwarded-proto"] || "https"}://${req.headers["x-forwarded-host"] || req.headers.host}`;
}
export function json(res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json");
}
