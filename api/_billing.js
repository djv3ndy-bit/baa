import Stripe from "stripe";

let stripeClientPromise;

export async function stripeClient() {
  const key = process.env.STRIPE_RESTRICTED_KEY;
  const expectedAccountId = process.env.STRIPE_ACCOUNT_ID;
  const priceId = process.env.STRIPE_MONTHLY_PRICE_ID;
  if (!key) throw new Error("Stripe is not configured.");
  if (!expectedAccountId?.startsWith("acct_")) throw new Error("The expected Stripe account is not configured.");
  if (!priceId?.startsWith("price_")) throw new Error("The Stripe monthly Price is not configured.");
  if (!key.startsWith("rk_test_")) throw new Error("Stripe sandbox requires a restricted test key.");
  if (!stripeClientPromise) {
    stripeClientPromise = (async () => {
      const client = new Stripe(key, { apiVersion: "2026-07-29.dahlia" });
      // A Price can only be retrieved with a key from its Stripe account. Its
      // metadata binds that account-specific resource to our explicit account
      // configuration without granting the key Accounts Read permission.
      const price = await client.prices.retrieve(priceId);
      if (
        price.id !== priceId ||
        price.livemode ||
        price.metadata?.application !== "baristamatch" ||
        price.metadata?.plan !== "cafe_monthly" ||
        price.metadata?.stripe_account_id !== expectedAccountId
      ) {
        throw new Error("Stripe restricted key does not match the configured sandbox plan and account.");
      }
      return client;
    })().catch((error) => {
      stripeClientPromise = undefined;
      throw error;
    });
  }
  return stripeClientPromise;
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
  const profiles = await adminRows(`profiles?id=eq.${encodeURIComponent(user.id)}&select=role,cafe_name,display_name&limit=1`);
  return profiles[0]?.role === "cafe_owner_manager" ? { ...user, profile: profiles[0] } : null;
}
export async function subscriptionFor(userId) {
  const rows = await adminRows(`cafe_subscriptions?user_id=eq.${encodeURIComponent(userId)}&select=*&limit=1`);
  return rows[0] || null;
}
export async function updateSubscription(userId, values) {
  return adminRows(`cafe_subscriptions?user_id=eq.${encodeURIComponent(userId)}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ ...values, updated_at: new Date().toISOString() }) });
}
export function origin(req) {
  const configured = String(process.env.PUBLIC_SITE_URL || "").replace(/\/$/, "");
  return configured || `${req.headers["x-forwarded-proto"] || "https"}://${req.headers["x-forwarded-host"] || req.headers.host}`;
}
export function json(res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json");
}
