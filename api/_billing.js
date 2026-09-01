import Stripe from "stripe";

let cachedStripeClient;

export async function stripeClient() {
  const key = process.env.STRIPE_RESTRICTED_KEY;
  const expectedAccountId = process.env.STRIPE_ACCOUNT_ID;
  if (!key) throw new Error("Stripe is not configured.");
  if (!expectedAccountId?.startsWith("acct_")) throw new Error("The expected Stripe account is not configured.");
  if (!key.startsWith("rk_test_")) throw new Error("Stripe sandbox requires a restricted test key.");
  if (!cachedStripeClient) {
    // Restricted keys are account-bound. Avoid requiring Accounts Read solely
    // to rediscover the account that issued this least-privileged sandbox key.
    cachedStripeClient = new Stripe(key, { apiVersion: "2026-07-29.dahlia" });
  }
  return cachedStripeClient;
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
