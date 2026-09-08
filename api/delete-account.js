import { stripeWebhookClient } from "./_billing.js";
import { randomUUID } from "node:crypto";

const jsonHeaders = { "Cache-Control": "no-store", "Content-Type": "application/json" };
const DELETE_CONFIRMATION = "DELETE";
const UPLOAD_BUCKETS = ["coffee-videos", "cafe-images"];
const PAGE_SIZE = 100;
const MAX_OBJECTS = 5000;
const MAX_FOLDERS = 100;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function ownedObjectPath(value, userId) {
  const path = String(value || "").trim();
  if (!path.startsWith(`${userId}/`) || /[\\\u0000-\u001f]/.test(path)) return null;
  const parts = path.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) return null;
  return path;
}

export function storedObjectsForProfile(profile, userId, supabaseUrl) {
  const objects = new Map();
  const add = (bucket, path) => {
    const ownedPath = ownedObjectPath(path, userId);
    if (ownedPath) objects.set(`${bucket}:${ownedPath}`, [bucket, ownedPath]);
  };
  add("coffee-videos", profile?.video_path);
  for (const imageUrl of [profile?.avatar_url, profile?.bar_picture_url]) {
    if (!imageUrl) continue;
    try {
      const parsed = new URL(imageUrl);
      if (parsed.origin !== new URL(supabaseUrl).origin) continue;
      const marker = "/storage/v1/object/public/cafe-images/";
      if (!parsed.pathname.startsWith(marker)) continue;
      add("cafe-images", decodeURIComponent(parsed.pathname.slice(marker.length)));
    } catch {
      // Never trust external URLs or another member's paths as deletion targets.
    }
  }
  return [...objects.values()];
}

class CleanupError extends Error {
  constructor(message = "We could not safely remove your account data. Please try again or contact support.", status = 502) {
    super(message);
    this.name = "CleanupError";
    this.status = status;
  }
}

// Enumerate before deleting: mutating a paginated list while reading it skips files.
// Prefix ownership is checked again even though the listing is server-authenticated.
export async function listOwnedUploads(userId, request) {
  const objects = [];
  let folderCount = 0;
  for (const bucket of UPLOAD_BUCKETS) {
    const folders = [`${userId}/`];
    for (let index = 0; index < folders.length; index += 1) {
      if (++folderCount > MAX_FOLDERS) throw new CleanupError();
      const prefix = folders[index];
      for (let offset = 0; offset <= MAX_OBJECTS; offset += PAGE_SIZE) {
        const response = await request(`/storage/v1/object/list/${bucket}`, {
          method: "POST",
          body: JSON.stringify({ prefix, limit: PAGE_SIZE, offset, sortBy: { column: "name", order: "asc" } })
        });
        if (!response.ok) throw new CleanupError();
        const rows = await response.json();
        if (!Array.isArray(rows) || rows.length > PAGE_SIZE) throw new CleanupError();
        for (const row of rows) {
          if (!row || typeof row.name !== "string" || !row.name || /[/\\\u0000-\u001f]/.test(row.name)) throw new CleanupError();
          const path = ownedObjectPath(`${prefix}${row.name}`, userId);
          if (!path) throw new CleanupError();
          if (row.id === null && row.metadata === null) {
            const folder = `${path}/`;
            if (folders.includes(folder)) throw new CleanupError();
            folders.push(folder);
          } else if (typeof row.id === "string" && row.id) {
            objects.push([bucket, path]);
            if (objects.length > MAX_OBJECTS) throw new CleanupError();
          } else {
            throw new CleanupError();
          }
        }
        if (rows.length < PAGE_SIZE) break;
        if (offset === MAX_OBJECTS) throw new CleanupError();
      }
    }
  }
  return objects;
}

// The current Supabase OAuth flow has no retained Apple provider token.
// Apple's TN3194 says to fulfill deletion and direct these users to manual
// revocation, not to block deletion or claim that a Supabase token is an Apple token.
export function appleDisconnectRequired(user) {
  return (Array.isArray(user?.identities) && user.identities.some(identity => identity?.provider === "apple")) ||
    user?.app_metadata?.provider === "apple" ||
    (Array.isArray(user?.app_metadata?.providers) && user.app_metadata.providers.includes("apple"));
}

async function expireOpenCheckoutSessions(stripe, customerId) {
  const sessionIds = [];
  let startingAfter;
  for (let page = 0; page < 10; page += 1) {
    const result = await stripe.checkout.sessions.list({ customer: customerId, status: "open", limit: 100, ...(startingAfter ? { starting_after: startingAfter } : {}) });
    sessionIds.push(...result.data.map(session => session.id));
    if (!result.has_more) break;
    startingAfter = result.data.at(-1)?.id;
    if (!startingAfter) throw new CleanupError();
    if (page === 9) throw new CleanupError();
  }
  await Promise.allSettled(sessionIds.map(sessionId => stripe.checkout.sessions.expire(sessionId)));
}

async function deleteOwnedStripeCustomer(stripe, customerId, userId) {
  let customer;
  try { customer = await stripe.customers.retrieve(customerId); }
  catch (error) {
    if (error?.code === "resource_missing") return;
    throw error;
  }
  if (customer.deleted) return;
  if (customer.metadata?.cafe_user_id !== userId) throw new CleanupError();
  await expireOpenCheckoutSessions(stripe, customerId);
  const deleted = await stripe.customers.del(customerId);
  if (!deleted?.deleted || deleted.id !== customerId) throw new CleanupError();
}

async function discoverOwnedStripeCustomers(stripe, userId, email) {
  const ids = new Set();
  const collect = rows => {
    if (!Array.isArray(rows) || rows.length > 100) throw new CleanupError();
    for (const customer of rows) {
      if (customer?.metadata?.cafe_user_id !== userId) continue;
      if (!/^cus_[A-Za-z0-9_]+$/.test(String(customer.id || ""))) throw new CleanupError();
      ids.add(customer.id);
    }
  };

  let searchPage;
  for (let page = 0; page < 10; page += 1) {
    const result = await stripe.customers.search({
      query: `metadata['cafe_user_id']:'${userId}'`,
      limit: 100,
      ...(searchPage ? { page: searchPage } : {})
    });
    collect(result.data);
    if (!result.has_more) break;
    searchPage = result.next_page;
    if (!searchPage || page === 9) throw new CleanupError();
  }

  // Metadata search is eventually consistent. Exact-email listing plus an
  // ownership check covers a just-created Customer whose index is still stale.
  if (email) {
    let startingAfter;
    for (let page = 0; page < 10; page += 1) {
      const result = await stripe.customers.list({
        email,
        limit: 100,
        ...(startingAfter ? { starting_after: startingAfter } : {})
      });
      collect(result.data);
      if (!result.has_more) break;
      startingAfter = result.data.at(-1)?.id;
      if (!startingAfter || page === 9) throw new CleanupError();
    }
  }
  return ids;
}

export async function endStripeBillingForDeletion(stripe, billing, userId, email = "", discoverAll = false, settleCheckoutAttempt) {
  if (!UUID.test(String(userId || ""))) throw new CleanupError();
  const customerIds = new Set();
  let discoveredCustomerIds = new Set();
  if (billing?.stripe_customer_id) {
    if (!/^cus_[A-Za-z0-9_]+$/.test(billing.stripe_customer_id)) throw new CleanupError();
    customerIds.add(billing.stripe_customer_id);
  }

  if (!billing?.stripe_customer_id && billing?.stripe_subscription_id) {
    if (!/^sub_[A-Za-z0-9_]+$/.test(billing.stripe_subscription_id)) throw new CleanupError();
    const subscription = await stripe.subscriptions.retrieve(billing.stripe_subscription_id);
    if (subscription.metadata?.cafe_user_id !== userId) throw new CleanupError();
    const customerId = typeof subscription.customer === "string" ? subscription.customer : subscription.customer?.id;
    if (!/^cus_[A-Za-z0-9_]+$/.test(String(customerId || ""))) throw new CleanupError();
    customerIds.add(customerId);
  }

  if (discoverAll || billing?.stripe_checkout_attempt_id) {
    discoveredCustomerIds = await discoverOwnedStripeCustomers(stripe, userId, email);
    for (const customerId of discoveredCustomerIds) customerIds.add(customerId);
    if (billing?.stripe_checkout_attempt_id && !discoveredCustomerIds.size) {
      // An unfinished Customer create may have succeeded even if its response
      // was lost. Never delete the member identity until Stripe can prove that
      // no owned Customer remains; a later retry or support can reconcile it.
      throw new CleanupError();
    }
  }
  if (billing?.stripe_checkout_attempt_id) {
    // Clear the recovered attempt while this request still owns the deletion
    // lease, before mutating Stripe. A retry always performs full discovery,
    // so it can still finish any Customer deletion interrupted after this point.
    if (!discoveredCustomerIds.size || typeof settleCheckoutAttempt !== "function") throw new CleanupError();
    await settleCheckoutAttempt();
  }
  for (const customerId of customerIds) await deleteOwnedStripeCustomer(stripe, customerId, userId);
}

export default async function handler(req, res) {
  Object.entries(jsonHeaders).forEach(([name, value]) => res.setHeader(name, value));
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed." });
  }
  const supabaseUrl = process.env.SUPABASE_URL?.replace(/\/$/, "");
  const publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY;
  const secretKey = process.env.SUPABASE_SECRET_KEY;
  if (!supabaseUrl || !publishableKey || !secretKey) {
    return res.status(503).json({ error: "Account management is temporarily unavailable." });
  }
  if (String(req.body?.confirmation || "").trim() !== DELETE_CONFIRMATION) {
    return res.status(400).json({ error: `Type ${DELETE_CONFIRMATION} exactly to confirm account deletion.` });
  }
  const authorization = String(req.headers?.authorization || "");
  const accessToken = /^Bearer\s+(\S+)$/i.exec(authorization)?.[1];
  if (!accessToken) return res.status(401).json({ error: "Your session expired. Please log in again." });

  const deadline = AbortSignal.timeout(25000);
  let restoreDeletionLock;
  let releaseDeletionBillingClaim;
  let deletionBillingClaimId;
  let stripeBillingAttempted = false;
  try {
    const userResponse = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: { apikey: publishableKey, Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.any([deadline, AbortSignal.timeout(10000)])
    });
    if (userResponse.status === 401 || userResponse.status === 403) {
      return res.status(401).json({ error: "Your session expired. Please log in again." });
    }
    if (!userResponse.ok) throw new CleanupError();
    const user = await userResponse.json();
    if (!UUID.test(String(user?.id || ""))) throw new CleanupError();

    const adminHeaders = { apikey: secretKey, "Content-Type": "application/json" };
    if (!secretKey.startsWith("sb_secret_")) adminHeaders.Authorization = `Bearer ${secretKey}`;
    const request = (path, options = {}) => fetch(`${supabaseUrl}${path}`, {
      ...options,
      headers: { ...adminHeaders, ...(options.headers || {}) },
      signal: AbortSignal.any([deadline, AbortSignal.timeout(10000)])
    });
    const profileResponse = await request(`/rest/v1/profiles?id=eq.${encodeURIComponent(user.id)}&select=role,video_path,avatar_url,bar_picture_url,suspended_at,is_discoverable&limit=1`);
    // A failed lookup is not an empty profile. Never delete the identity on error.
    if (!profileResponse.ok) throw new CleanupError();
    const profiles = await profileResponse.json();
    if (!Array.isArray(profiles) || profiles.length > 1) throw new CleanupError();
    const profile = profiles[0];

    // Claim the shared billing lease before changing profile visibility. This
    // orders concurrent deletions and Checkout workers without letting a losing
    // deletion request restore another request's suspension lock.
    if (profile?.role === "cafe_owner_manager") {
      const deletionClaimId = randomUUID();
      const claimResponse = await request("/rest/v1/rpc/claim_stripe_deletion", {
        method: "POST",
        body: JSON.stringify({
          p_user_id: user.id,
          p_claim_id: deletionClaimId
        })
      });
      if (!claimResponse.ok) throw new CleanupError();
      const claim = await claimResponse.json();
      if (claim === "busy") {
        throw new CleanupError("Secure checkout is still closing. Wait a moment, then try deleting your account again.", 409);
      }
      if (!['claimed', 'missing'].includes(claim)) throw new CleanupError();
      if (claim === "claimed") {
        deletionBillingClaimId = deletionClaimId;
        releaseDeletionBillingClaim = async () => {
          const response = await fetch(`${supabaseUrl}/rest/v1/rpc/release_stripe_checkout`, {
            method: "POST",
            headers: adminHeaders,
            body: JSON.stringify({ p_user_id: user.id, p_claim_id: deletionClaimId, p_clear_attempt: false }),
            signal: AbortSignal.timeout(5000)
          });
          if (!response.ok) throw new Error("Deletion billing claim release failed.");
        };
      }
    }

    // Once deletion owns the billing lease, suspend the café so Checkout's
    // authentication checks also stop before destructive cleanup begins.
    if (profile?.role === "cafe_owner_manager" && !profile.suspended_at) {
      const deletionLock = new Date().toISOString();
      const lockResponse = await request(`/rest/v1/profiles?id=eq.${encodeURIComponent(user.id)}&suspended_at=is.null&select=id`, {
        method: "PATCH",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify({ suspended_at: deletionLock })
      });
      if (!lockResponse.ok) throw new CleanupError();
      const locked = await lockResponse.json();
      if (!Array.isArray(locked) || locked.length !== 1 || locked[0]?.id !== user.id) throw new CleanupError();
      restoreDeletionLock = async () => {
        const response = await fetch(`${supabaseUrl}/rest/v1/profiles?id=eq.${encodeURIComponent(user.id)}&suspended_at=eq.${encodeURIComponent(deletionLock)}`, {
          method: "PATCH",
          headers: adminHeaders,
          body: JSON.stringify({ suspended_at: null, is_discoverable: Boolean(profile.is_discoverable) }),
          signal: AbortSignal.timeout(5000)
        });
        if (!response.ok) throw new Error("Deletion lock restoration failed.");
      };
    }

    const subscriptionResponse = await request(`/rest/v1/cafe_subscriptions?user_id=eq.${encodeURIComponent(user.id)}&select=stripe_customer_id,stripe_subscription_id,stripe_checkout_attempt_id,status,cancel_at_period_end&limit=1`);
    if (!subscriptionResponse.ok) throw new CleanupError();
    const subscriptions = await subscriptionResponse.json();
    if (!Array.isArray(subscriptions) || subscriptions.length > 1) throw new CleanupError();
    const billing = subscriptions[0];
    if (billing) {
      // Bind destructive cleanup to the configured BaristaMatch account and
      // canonical Price before treating a missing resource as already deleted.
      const stripe = await stripeWebhookClient();
      stripeBillingAttempted = true;
      const settleCheckoutAttempt = billing.stripe_checkout_attempt_id ? async () => {
        if (!deletionBillingClaimId) throw new CleanupError();
        const response = await request("/rest/v1/rpc/settle_stripe_checkout_attempt_for_deletion", {
          method: "POST",
          body: JSON.stringify({ p_user_id: user.id, p_claim_id: deletionBillingClaimId })
        });
        if (!response.ok || await response.json() !== true) throw new CleanupError();
      } : undefined;
      await endStripeBillingForDeletion(stripe, billing, user.id, user.email || "", true, settleCheckoutAttempt);
    }

    const objects = new Map();
    for (const item of [...await listOwnedUploads(user.id, request), ...storedObjectsForProfile(profile, user.id, supabaseUrl)]) {
      objects.set(`${item[0]}:${item[1]}`, item);
    }
    for (const bucket of UPLOAD_BUCKETS) {
      const paths = [...objects.values()].filter(([name]) => name === bucket).map(([, path]) => path);
      for (let offset = 0; offset < paths.length; offset += PAGE_SIZE) {
        // Storage API removes physical objects, not just storage.objects SQL rows.
        const response = await request(`/storage/v1/object/${bucket}`, {
          method: "DELETE", body: JSON.stringify({ prefixes: paths.slice(offset, offset + PAGE_SIZE) })
        });
        if (!response.ok) throw new CleanupError();
      }
    }
    // Confirm cleanup. This also catches uploads arriving during enumeration.
    if ((await listOwnedUploads(user.id, request)).length) throw new CleanupError();
    const deleteResponse = await request(`/auth/v1/admin/users/${encodeURIComponent(user.id)}`, { method: "DELETE" });
    if (!deleteResponse.ok) throw new CleanupError("We could not delete your account. Please try again or contact support.");
    return res.status(200).json({
      success: true,
      appleRevocation: appleDisconnectRequired(user) ? "manual_required" : "not_applicable"
    });
  } catch (error) {
    if (!stripeBillingAttempted) {
      if (restoreDeletionLock) {
        try { await restoreDeletionLock(); }
        catch (restoreError) { console.error("Account deletion lock restoration failed", restoreError?.name || "Error"); }
      }
      if (releaseDeletionBillingClaim) {
        try { await releaseDeletionBillingClaim(); }
        catch (releaseError) { console.error("Account deletion billing claim release failed", releaseError?.name || "Error"); }
      }
    }
    const timeout = error?.name === "TimeoutError" || error?.name === "AbortError";
    console.error("Account deletion request failed", error?.name || "Error");
    return res.status(timeout ? 504 : error instanceof CleanupError ? error.status : 502).json({
      error: timeout ? "Account deletion took too long. Please try again." : error instanceof CleanupError ? error.message : "We could not safely remove your account data. Please try again."
    });
  }
}
