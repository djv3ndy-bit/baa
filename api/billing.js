import { randomUUID } from "node:crypto";
import { adminRows, authenticatedCafe, constructStripeEvent, json, origin, stripeApiClient, stripeClient, stripeMode, stripeWebhookClient, subscriptionCanBeManaged, subscriptionFor, subscriptionHasPaidAccess, subscriptionIsConnected, subscriptionUsesConfiguredPrice } from "./_billing.js";

export const config = { api: { bodyParser: false } };
const BILLING_PAUSED_MESSAGE = "Billing is not active. Café accounts will not be charged during the plan preview.";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BILLING_EVENT_TYPES = new Set([
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
  "checkout.session.async_payment_failed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "invoice.paid",
  "invoice.payment_failed",
  "charge.refunded"
]);
const billingPaused = () => process.env.BILLING_ENABLED !== "true";

async function rawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function requestBody(req) {
  const payload = await rawBody(req);
  if (!payload.length) return {};
  try { return JSON.parse(payload.toString("utf8")); }
  catch { throw new Error("Invalid JSON body."); }
}

function actionFor(req) {
  const direct = Array.isArray(req.query?.action) ? req.query.action[0] : req.query?.action;
  if (direct) return direct;
  return new URL(req.url || "/", "https://baristajobmatch.com").searchParams.get("action");
}

export function checkoutSessionCanFulfill(session) {
  const subscription = typeof session?.subscription === "string" ? session.subscription : session?.subscription?.id;
  return Boolean(
    session?.mode === "subscription" &&
    subscription &&
    session?.status === "complete" &&
    ["paid", "no_payment_required"].includes(session?.payment_status)
  );
}

export function checkoutSessionBelongsToCafe(session, userId, customerId) {
  const sessionCustomer = typeof session?.customer === "string" ? session.customer : session?.customer?.id;
  return Boolean(
    session?.mode === "subscription" &&
    session?.client_reference_id === userId &&
    session?.metadata?.cafe_user_id === userId &&
    customerId && sessionCustomer === customerId
  );
}

function checkoutSessionUsesPrice(session, priceId) {
  return Boolean(session?.line_items?.data?.some((item) => {
    const price = item?.price;
    return (typeof price === "string" ? price : price?.id) === priceId;
  }));
}

async function openSubscriptionCheckoutSessions(stripe, customerId) {
  const sessions = [];
  let startingAfter;
  for (let page = 0; page < 10; page += 1) {
    const result = await stripe.checkout.sessions.list({
      customer: customerId,
      status: "open",
      limit: 100,
      expand: ["data.line_items"],
      ...(startingAfter ? { starting_after: startingAfter } : {})
    });
    sessions.push(...result.data.filter((session) => session.mode === "subscription"));
    if (!result.has_more) return sessions;
    startingAfter = result.data.at(-1)?.id;
    if (!startingAfter || page === 9) throw new Error("Too many open Stripe Checkout Sessions.");
  }
  throw new Error("Open Stripe Checkout Session pagination failed.");
}

async function customerSubscriptions(stripe, customerId) {
  const subscriptions = [];
  let startingAfter;
  for (let page = 0; page < 10; page += 1) {
    const result = await stripe.subscriptions.list({
      customer: customerId,
      status: "all",
      limit: 100,
      ...(startingAfter ? { starting_after: startingAfter } : {})
    });
    subscriptions.push(...result.data);
    if (!result.has_more) return subscriptions;
    startingAfter = result.data.at(-1)?.id;
    if (!startingAfter || page === 9) throw new Error("Too many Stripe subscriptions.");
  }
  throw new Error("Stripe subscription pagination failed.");
}

function subscriptionSelectionRank(subscription) {
  if (["active", "trialing"].includes(subscription?.status)) return 3;
  if (["past_due", "unpaid", "incomplete", "paused"].includes(subscription?.status)) return 2;
  return 1;
}

function subscriptionBelongsToCafe(subscription, userId, customerId) {
  const candidateCustomer = typeof subscription?.customer === "string" ? subscription.customer : subscription?.customer?.id;
  return Boolean(
    UUID.test(String(userId || "")) &&
    /^cus_[A-Za-z0-9_]+$/.test(String(customerId || "")) &&
    /^sub_[A-Za-z0-9_]+$/.test(String(subscription?.id || "")) &&
    subscription?.metadata?.cafe_user_id === userId &&
    candidateCustomer === customerId
  );
}

function preferredConfiguredSubscription(subscriptions, userId, customerId) {
  return subscriptions
    .filter(subscription =>
      subscriptionBelongsToCafe(subscription, userId, customerId) &&
      subscriptionUsesConfiguredPrice(subscription, process.env.STRIPE_MONTHLY_PRICE_ID)
    )
    .sort((left, right) => {
      const byAccess = subscriptionSelectionRank(right) - subscriptionSelectionRank(left);
      if (byAccess) return byAccess;
      const byCreation = Number(right.created || 0) - Number(left.created || 0);
      if (byCreation) return byCreation;
      const leftId = String(left.id || "");
      const rightId = String(right.id || "");
      return leftId === rightId ? 0 : leftId > rightId ? -1 : 1;
    })[0] || null;
}

async function reconcileCurrentCustomerSubscription(stripe, userId, customerId, observedSubscription) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const billing = await subscriptionFor(userId);
    if (!billing || (billing.stripe_customer_id && billing.stripe_customer_id !== customerId)) return false;
    const subscriptions = await customerSubscriptions(stripe, customerId);
    if (observedSubscription?.id && !subscriptions.some(candidate => candidate.id === observedSubscription.id)) {
      const currentObservedSubscription = await stripe.subscriptions.retrieve(observedSubscription.id);
      if (!subscriptionBelongsToCafe(currentObservedSubscription, userId, customerId)) {
        throw new Error("The observed Stripe subscription changed ownership during reconciliation.");
      }
      subscriptions.push(currentObservedSubscription);
    }
    const preferred = preferredConfiguredSubscription(subscriptions, userId, customerId);
    let synced;
    if (preferred) {
      synced = await syncSubscription(
        preferred,
        undefined,
        billing.stripe_subscription_event_created_at ?? null,
        billing.stripe_subscription_sync_revision ?? 0
      );
    } else {
      const ownedSubscription = subscriptions.find(candidate => candidate.id === billing.stripe_subscription_id);
      if (!ownedSubscription || !subscriptionBelongsToCafe(ownedSubscription, userId, customerId)) {
        throw new Error("The owned Stripe subscription could not be reconciled.");
      }
      synced = await syncSubscriptionState(
        ownedSubscription,
        undefined,
        billing.stripe_subscription_event_created_at ?? null,
        billing.stripe_subscription_sync_revision ?? 0,
        "expired"
      );
    }
    if (synced) return true;
  }
  throw new Error("Stripe subscription state changed repeatedly during reconciliation.");
}

async function syncPreferredCustomerSubscription(subscription, stripe, eventCreated, expectedEventCreatedAt = null, expectedRevision = null) {
  const userId = subscription?.metadata?.cafe_user_id;
  const customerId = typeof subscription?.customer === "string" ? subscription.customer : subscription?.customer?.id;
  if (!subscriptionBelongsToCafe(subscription, userId, customerId)) return false;
  let ownedBilling;
  if (!subscriptionUsesConfiguredPrice(subscription, process.env.STRIPE_MONTHLY_PRICE_ID)) {
    ownedBilling = await subscriptionFor(userId);
    if (
      !ownedBilling ||
      ownedBilling.stripe_customer_id !== customerId ||
      ownedBilling.stripe_subscription_id !== subscription.id
    ) return false;
  }
  const subscriptions = await customerSubscriptions(stripe, customerId);
  if (!subscriptions.some(candidate => candidate.id === subscription.id)) subscriptions.push(subscription);
  const preferred = preferredConfiguredSubscription(subscriptions, userId, customerId);
  let observedSubscription = preferred;
  let synced;
  if (preferred) {
    synced = await syncSubscription(preferred, eventCreated, expectedEventCreatedAt, expectedRevision);
  } else {
    const currentSubscription = subscriptions.find(candidate => candidate.id === subscription.id) || subscription;
    const billing = ownedBilling || await subscriptionFor(userId);
    if (
      !billing ||
      billing.stripe_customer_id !== customerId ||
      billing.stripe_subscription_id !== currentSubscription.id ||
      !subscriptionBelongsToCafe(currentSubscription, userId, customerId)
    ) return false;
    // Price replacement is an ownership-sensitive fail-closed transition.
    // Use the freshly read row as an atomic revision fence instead of an
    // event-time cross-ID write that could race another subscription.
    synced = await syncSubscriptionState(
      currentSubscription,
      undefined,
      billing.stripe_subscription_event_created_at ?? null,
      billing.stripe_subscription_sync_revision ?? 0,
      "expired"
    );
    if (!synced) throw new Error("The incompatible owned Stripe subscription could not be disabled.");
    return true;
  }
  if (!synced || eventCreated == null) return synced;
  // Event timestamps have one-second precision. Re-read both sides and use a
  // revision-fenced authoritative write so equal-second recovery/delinquency
  // races and resent older events converge to Stripe's current state.
  return reconcileCurrentCustomerSubscription(stripe, userId, customerId, observedSubscription);
}

async function recoverOwnedStripeCustomers(stripe, userId, email) {
  const ids = new Set();
  const collect = rows => {
    if (!Array.isArray(rows) || rows.length > 100) throw new Error("Stripe Customer recovery returned an invalid page.");
    for (const customer of rows) {
      if (customer?.metadata?.cafe_user_id !== userId) continue;
      if (!/^cus_[A-Za-z0-9_]+$/.test(String(customer.id || ""))) throw new Error("Stripe Customer recovery returned an invalid Customer.");
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
    if (!searchPage || page === 9) throw new Error("Stripe Customer recovery exceeded its search bound.");
  }
  if (email) {
    let startingAfter;
    for (let page = 0; page < 10; page += 1) {
      const result = await stripe.customers.list({ email, limit: 100, ...(startingAfter ? { starting_after: startingAfter } : {}) });
      collect(result.data);
      if (!result.has_more) break;
      startingAfter = result.data.at(-1)?.id;
      if (!startingAfter || page === 9) throw new Error("Stripe Customer recovery exceeded its list bound.");
    }
  }
  return [...ids];
}

async function claimCheckoutCreation(userId, requestedChannel) {
  const claimId = randomUUID();
  const requestedAttemptId = randomUUID();
  const claimed = await adminRows("rpc/claim_stripe_checkout", {
    method: "POST",
    body: JSON.stringify({
      p_user_id: userId,
      p_claim_id: claimId,
      p_attempt_id: requestedAttemptId,
      p_channel: requestedChannel
    })
  });
  if (!claimed || !UUID.test(String(claimed.attemptId || "")) || !["web", "app"].includes(claimed.channel) || typeof claimed.recovered !== "boolean") return null;
  return { claimId, attemptId: claimed.attemptId, channel: claimed.channel, recovered: claimed.recovered };
}

async function releaseCheckoutCreation(userId, claimId, clearAttempt) {
  return adminRows("rpc/release_stripe_checkout", {
    method: "POST",
    body: JSON.stringify({ p_user_id: userId, p_claim_id: claimId, p_clear_attempt: clearAttempt })
  });
}

async function checkoutClaimIsCurrent(userId, claimId) {
  return await adminRows("rpc/stripe_checkout_claim_is_current", {
    method: "POST",
    body: JSON.stringify({ p_user_id: userId, p_claim_id: claimId })
  }) === true;
}

async function attachCheckoutCustomer(userId, claimId, customerId) {
  return adminRows("rpc/attach_stripe_checkout_customer", {
    method: "POST",
    body: JSON.stringify({ p_user_id: userId, p_claim_id: claimId, p_customer_id: customerId })
  });
}

async function attachCheckoutCustomerReliably(userId, claimId, customerId) {
  try {
    return await attachCheckoutCustomer(userId, claimId, customerId);
  } catch (attachmentError) {
    // The first RPC may have committed even if its response was lost. Re-read
    // before doing anything to the Customer, then retry only while our lease
    // still owns the billing row.
    let current;
    try { current = await subscriptionFor(userId); }
    catch { throw attachmentError; }
    if (!current) return "missing";
    if (current.stripe_customer_id === customerId) return "owned";
    if (current.stripe_customer_id) return "conflict";
    let claimIsCurrent;
    try { claimIsCurrent = await checkoutClaimIsCurrent(userId, claimId); }
    catch { throw attachmentError; }
    if (!claimIsCurrent) return "recovering";
    try { return await attachCheckoutCustomer(userId, claimId, customerId); }
    catch { throw attachmentError; }
  }
}

async function billingStatus(req, res) {
  json(res);
  if (req.method !== "GET") { res.setHeader("Allow", "GET"); return res.status(405).json({ error: "Method not allowed." }); }
  try {
    const user = await authenticatedCafe(req);
    if (!user) return res.status(401).json({ error: "Please log in with a café account." });
    const subscription = await subscriptionFor(user.id);
    const connectedToBilling = subscriptionIsConnected(subscription);
    const paidStatus = connectedToBilling && subscriptionHasPaidAccess(subscription);
    const canManageBilling = connectedToBilling && subscriptionCanBeManaged(subscription);
    if (billingPaused()) return res.status(200).json({
      status: subscription?.status || "free",
      currentPeriodEnd: subscription?.current_period_end || null,
      cancelAtPeriodEnd: Boolean(subscription?.cancel_at_period_end),
      complimentaryAccess: Boolean(subscription?.complimentary_access ?? true),
      connectedToBilling,
      canManageBilling,
      billingPaused: true,
      plan: paidStatus ? "pro" : "free",
      monthlyPriceCents: 999,
      maxActiveJobs: 3,
      message: BILLING_PAUSED_MESSAGE
    });
    if (!subscription) return res.status(200).json({
      status: "free",
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
      complimentaryAccess: false,
      connectedToBilling: false,
      canManageBilling: false,
      billingPaused: false,
      plan: "free",
      monthlyPriceCents: 999,
      maxActiveJobs: 3
    });
    return res.status(200).json({
      status: subscription.status || "free",
      currentPeriodEnd: subscription.current_period_end,
      cancelAtPeriodEnd: Boolean(subscription.cancel_at_period_end),
      complimentaryAccess: Boolean(subscription.complimentary_access),
      connectedToBilling,
      canManageBilling,
      billingPaused: false,
      plan: paidStatus ? "pro" : "free",
      monthlyPriceCents: 999,
      maxActiveJobs: 3
    });
  } catch (error) {
    console.error("Billing status failed", error?.message || error);
    return res.status(503).json({ error: "Subscription details are temporarily unavailable." });
  }
}

async function createCheckout(req, res) {
  json(res);
  if (req.method !== "POST") { res.setHeader("Allow", "POST"); return res.status(405).json({ error: "Method not allowed." }); }
  if (billingPaused()) return res.status(503).json({ error: BILLING_PAUSED_MESSAGE, billingPaused: true });
  if (!process.env.STRIPE_MONTHLY_PRICE_ID) return res.status(503).json({ error: "The café plan is not configured yet." });
  try {
    const payload = await requestBody(req);
    const user = await authenticatedCafe(req);
    if (!user) return res.status(401).json({ error: "Please log in with a café account." });
    if (user.profile.suspended_at) return res.status(403).json({ error: "This café account cannot start checkout." });
    const requestedChannel = payload.channel === "mobile" ? "app" : "web";
    const billing = await subscriptionFor(user.id);
    if (!billing) return res.status(409).json({ error: "Open your Free café plan before subscribing." });
    if (billing.stripe_subscription_id && subscriptionCanBeManaged(billing)) {
      return res.status(409).json({
        error: subscriptionIsConnected(billing)
          ? "This café already has a subscription. Open billing management instead."
          : "This café's Stripe subscription link is incomplete. Contact support before starting another subscription."
      });
    }
    const checkoutClaim = await claimCheckoutCreation(user.id, requestedChannel);
    if (!checkoutClaim) return res.status(409).json({ error: "Secure checkout is already opening for this café. Please try again shortly." });
    let checkoutAttemptSettled = false;
    let customerCreateStarted = false;
    let checkoutCreateStarted = false;
    try {
      // A reclaimed worker deliberately keeps the original attempt and channel.
      // That gives every worker the exact same Stripe idempotency key and payload.
      const checkoutChannel = checkoutClaim.channel;
      const mobile = checkoutChannel === "app";
      const stripe = await stripeClient();
      if (!await checkoutClaimIsCurrent(user.id, checkoutClaim.claimId)) {
        return res.status(409).json({ error: "Secure checkout was interrupted. Please try again." });
      }
      let customerId = billing.stripe_customer_id;
      if (!customerId) {
        if (checkoutClaim.recovered) {
          const recoveredCustomers = await recoverOwnedStripeCustomers(stripe, user.id, user.email || "");
          if (recoveredCustomers.length > 1) throw new Error("Multiple Stripe Customers require support reconciliation.");
          customerId = recoveredCustomers[0];
        }
        if (!customerId) {
          customerCreateStarted = true;
          let customer;
          try {
            customer = await stripe.customers.create({
              email: user.email,
              name: user.profile.cafe_name || user.profile.display_name || undefined,
              metadata: { cafe_user_id: user.id }
            }, { idempotencyKey: `baristamatch-customer-${user.id}` });
          } catch (customerError) {
            // These errors conclusively reject the request before Customer
            // creation. Transport, rate-limit, and server errors stay marked as
            // ambiguous so account deletion must reconcile them.
            if (["StripeInvalidRequestError", "StripeAuthenticationError", "StripePermissionError", "StripeIdempotencyError"].includes(customerError?.type)) {
              customerCreateStarted = false;
            }
            throw customerError;
          }
          customerId = customer.id;
        }
        const attachment = await attachCheckoutCustomerReliably(user.id, checkoutClaim.claimId, customerId);
        if (!["attached", "owned"].includes(attachment)) {
          // A deletion worker discovers metadata-owned Customers itself. Leave
          // this Customer visible for that cleanup; only a missing database row
          // makes immediate removal both necessary and race-free.
          if (attachment === "missing") {
            try {
              const removed = await stripe.customers.del(customerId);
              checkoutAttemptSettled = removed?.deleted === true && removed.id === customerId;
            }
            catch (cleanupError) { console.error("Interrupted Stripe Customer cleanup failed", cleanupError?.message || cleanupError); }
          }
          throw new Error("The café billing record is no longer available.");
        }
      }
      const subscriptions = await customerSubscriptions(stripe, customerId);
      // This is a dedicated BaristaMatch Customer. Any renewable subscription
      // must block another Checkout, including a legacy Price, to prevent double billing.
      const existingSubscription = subscriptions.find(subscriptionCanBeManaged);
      if (existingSubscription) {
        const preferredSubscription = preferredConfiguredSubscription(subscriptions, user.id, customerId);
        const connected = preferredSubscription
          ? await syncSubscription(
              preferredSubscription,
              undefined,
              billing.stripe_subscription_event_created_at ?? null,
              billing.stripe_subscription_sync_revision ?? 0
            )
          : false;
        checkoutAttemptSettled = true;
        return res.status(409).json({
          error: connected && subscriptionCanBeManaged(preferredSubscription)
            ? "This café already has a subscription. Open billing management instead."
            : "This café already has a Stripe subscription on a different plan. Contact support before starting another."
        });
      }
      const openSessions = await openSubscriptionCheckoutSessions(stripe, customerId);
      const matchingSessions = openSessions.filter((session) =>
        session.url &&
        session.client_reference_id === user.id &&
        session.metadata?.cafe_user_id === user.id &&
        checkoutSessionUsesPrice(session, process.env.STRIPE_MONTHLY_PRICE_ID)
      );
      const reusableSession = matchingSessions.find((session) => session.metadata?.checkout_channel === checkoutChannel);
      const verifiedUser = await authenticatedCafe(req);
      if (!verifiedUser || verifiedUser.id !== user.id || verifiedUser.profile.suspended_at) {
        return res.status(409).json({ error: "This café account can no longer start checkout." });
      }
      if (!await checkoutClaimIsCurrent(user.id, checkoutClaim.claimId)) {
        return res.status(409).json({ error: "Secure checkout was interrupted. Please try again." });
      }
      await Promise.all(openSessions
        .filter((session) => session.id !== reusableSession?.id)
        .map((session) => stripe.checkout.sessions.expire(session.id)));
      if (reusableSession) {
        checkoutAttemptSettled = true;
        return res.status(200).json({ url: reusableSession.url, reused: true });
      }
      const site = origin(req);
      const subscriptionData = { metadata: { cafe_user_id: user.id } };
      checkoutCreateStarted = true;
      const session = await stripe.checkout.sessions.create({
        mode: "subscription",
        customer: customerId,
        client_reference_id: user.id,
        line_items: [{ price: process.env.STRIPE_MONTHLY_PRICE_ID, quantity: 1 }],
        success_url: mobile ? `${site}/mobile-billing-return.html?billing=success&session_id={CHECKOUT_SESSION_ID}` : `${site}/dashboard.html?billing=success&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: mobile ? `${site}/mobile-billing-return.html?billing=canceled` : `${site}/dashboard.html?billing=canceled`,
        integration_identifier: mobile ? "baristamatch_app_yhvkqjpw" : "baristamatch_web_qtmzjvka",
        metadata: { cafe_user_id: user.id, checkout_channel: checkoutChannel },
        subscription_data: subscriptionData,
        allow_promotion_codes: true
      }, { idempotencyKey: `baristamatch-checkout-${user.id}-${checkoutClaim.attemptId}` });
      checkoutAttemptSettled = true;
      return res.status(200).json({ url: session.url });
    } finally {
      const clearAttempt = checkoutAttemptSettled || (!checkoutClaim.recovered && !customerCreateStarted && !checkoutCreateStarted);
      try { await releaseCheckoutCreation(user.id, checkoutClaim.claimId, clearAttempt); }
      catch (releaseError) { console.error("Stripe Checkout claim release failed", releaseError?.message || releaseError); }
    }
  } catch (error) {
    console.error("Stripe Checkout failed", error?.type || error?.message || error);
    return res.status(502).json({ error: "Secure checkout could not be opened. Please try again." });
  }
}

async function createPortal(req, res) {
  json(res);
  if (req.method !== "POST") { res.setHeader("Allow", "POST"); return res.status(405).json({ error: "Method not allowed." }); }
  try {
    const payload = await requestBody(req);
    const user = await authenticatedCafe(req);
    if (!user) return res.status(401).json({ error: "Please log in with a café account." });
    const billing = await subscriptionFor(user.id);
    if (billing?.user_id !== user.id || !subscriptionIsConnected(billing) || !subscriptionCanBeManaged(billing)) {
      return res.status(409).json({ error: "There is no current subscription to manage. Open the café plans to subscribe." });
    }
    const mobile = payload.channel === "mobile";
    // Existing subscribers must retain access to cancellation and payment
    // method management even if the canonical Price is later archived.
    const stripe = await stripeWebhookClient();
    const expectedLivemode = stripeMode() === "live";
    const customer = await stripe.customers.retrieve(billing.stripe_customer_id);
    const subscription = await stripe.subscriptions.retrieve(billing.stripe_subscription_id);
    if (
      customer?.deleted === true ||
      customer?.id !== billing.stripe_customer_id ||
      customer?.livemode !== expectedLivemode ||
      customer?.metadata?.cafe_user_id !== user.id ||
      subscription?.id !== billing.stripe_subscription_id ||
      subscription?.livemode !== expectedLivemode ||
      !subscriptionBelongsToCafe(subscription, user.id, billing.stripe_customer_id) ||
      !subscriptionUsesConfiguredPrice(subscription, process.env.STRIPE_MONTHLY_PRICE_ID) ||
      !subscriptionCanBeManaged(subscription)
    ) {
      return res.status(409).json({ error: "There is no current subscription to manage. Open the café plans to subscribe." });
    }
    const session = await stripe.billingPortal.sessions.create({
      customer: customer.id,
      return_url: mobile ? `${origin(req)}/mobile-billing-return.html?billing=portal` : `${origin(req)}/dashboard.html`
    });
    return res.status(200).json({ url: session.url });
  } catch (error) {
    console.error("Stripe portal failed", error?.type || error?.message || error);
    return res.status(502).json({ error: "Billing management could not be opened. Please try again." });
  }
}

async function confirmCheckout(req, res) {
  json(res);
  if (req.method !== "POST") { res.setHeader("Allow", "POST"); return res.status(405).json({ error: "Method not allowed." }); }
  try {
    const payload = await requestBody(req);
    const sessionId = String(payload.sessionId || "");
    if (!/^cs_(?:test_|live_)?[A-Za-z0-9]+$/.test(sessionId)) return res.status(400).json({ error: "The checkout confirmation is invalid." });
    const user = await authenticatedCafe(req);
    if (!user) return res.status(401).json({ error: "Please log in with a café account." });
    const billing = await subscriptionFor(user.id);
    if (!billing?.stripe_customer_id) return res.status(409).json({ error: "The checkout does not match this café account." });
    const stripe = stripeApiClient();
    const session = await stripe.checkout.sessions.retrieve(sessionId, { expand: ["subscription"] });
    if (!checkoutSessionBelongsToCafe(session, user.id, billing.stripe_customer_id)) {
      return res.status(404).json({ error: "The checkout does not match this café account." });
    }
    if (!checkoutSessionCanFulfill(session)) return res.status(202).json({ confirmed: false, pending: true });
    if (!await syncCheckoutSession(
      session,
      stripe,
      undefined,
      billing.stripe_subscription_event_created_at ?? null,
      billing.stripe_subscription_sync_revision ?? 0
    )) {
      return res.status(409).json({ error: "The checkout does not match the current BaristaMatch café plan." });
    }
    const updated = await subscriptionFor(user.id);
    return res.status(200).json({ confirmed: subscriptionHasPaidAccess(updated), status: updated?.status || "pending" });
  } catch (error) {
    console.error("Stripe Checkout confirmation failed", error?.type || error?.message || error);
    return res.status(502).json({ error: "Your payment is still being confirmed. Refresh your subscription status shortly." });
  }
}

function periodEnd(subscription) {
  const unix = subscription.current_period_end || subscription.items?.data?.[0]?.current_period_end;
  return unix ? new Date(unix * 1000).toISOString() : null;
}

function eventCreatedAt(eventCreated) {
  const seconds = Number(eventCreated);
  return Number.isFinite(seconds) && seconds > 0
    ? new Date(seconds * 1000).toISOString()
    : null;
}

async function syncSubscriptionState(subscription, eventCreated, expectedEventCreatedAt = null, expectedRevision = null, forcedStatus = null) {
  const userId = subscription.metadata?.cafe_user_id;
  const customerId = typeof subscription.customer === "string" ? subscription.customer : subscription.customer?.id;
  if (!subscriptionBelongsToCafe(subscription, userId, customerId) || (forcedStatus && forcedStatus !== "expired")) return false;
  const status = forcedStatus || (["active", "trialing", "canceled"].includes(subscription.status)
    ? subscription.status
    : ["past_due", "unpaid", "incomplete", "paused"].includes(subscription.status) ? "past_due" : "expired");
  const providerEventCreatedAt = eventCreatedAt(eventCreated ?? subscription.created);
  const subscriptionCreatedAt = eventCreatedAt(subscription.created);
  if (!providerEventCreatedAt || !subscriptionCreatedAt) return false;
  const synced = await adminRows("rpc/sync_stripe_subscription", {
    method: "POST",
    body: JSON.stringify({
      p_user_id: userId,
      p_customer_id: customerId,
      p_subscription_id: subscription.id,
      p_subscription_created_at: subscriptionCreatedAt,
      p_status: status,
      p_current_period_end: periodEnd(subscription),
      p_cancel_at_period_end: Boolean(subscription.cancel_at_period_end),
      p_event_created_at: providerEventCreatedAt,
      p_authoritative: eventCreated == null,
      p_expected_event_created_at: expectedEventCreatedAt,
      p_expected_revision: expectedRevision
    })
  });
  return synced === true;
}

export async function syncSubscription(subscription, eventCreated, expectedEventCreatedAt = null, expectedRevision = null) {
  if (!subscriptionUsesConfiguredPrice(subscription, process.env.STRIPE_MONTHLY_PRICE_ID)) return false;
  return syncSubscriptionState(subscription, eventCreated, expectedEventCreatedAt, expectedRevision);
}

export async function syncCheckoutSession(session, stripe = stripeApiClient(), eventCreated, expectedEventCreatedAt = null, expectedRevision = null) {
  if (!checkoutSessionCanFulfill(session)) return false;
  const source = session.subscription;
  const subscriptionId = typeof source === "string" ? source : source?.id;
  // Webhook payload expansions are event-time snapshots. Always retrieve the
  // current Subscription for event-driven writes; authenticated confirmation
  // can reuse the object expanded by its just-completed API request.
  const subscription = eventCreated == null && typeof source === "object" && source?.items
    ? source
    : await stripe.subscriptions.retrieve(subscriptionId);
  const userId = session.metadata?.cafe_user_id;
  const sessionCustomer = typeof session.customer === "string" ? session.customer : session.customer?.id;
  const subscriptionCustomer = typeof subscription.customer === "string" ? subscription.customer : subscription.customer?.id;
  if (!userId || session.client_reference_id !== userId || subscription.metadata?.cafe_user_id !== userId || !sessionCustomer || sessionCustomer !== subscriptionCustomer) {
    return false;
  }
  return syncPreferredCustomerSubscription(subscription, stripe, eventCreated, expectedEventCreatedAt, expectedRevision);
}

export async function syncSubscriptionEvent(source, stripe = stripeApiClient(), eventCreated) {
  if (!source?.id) return false;
  const subscription = await stripe.subscriptions.retrieve(source.id);
  return syncPreferredCustomerSubscription(subscription, stripe, eventCreated);
}

export function invoicePaymentRecord(invoice, fallbackStatus, eventCreated = invoice?.created) {
  const succeeded = invoice?.paid === true || invoice?.status === "paid";
  const status = succeeded ? "succeeded" : fallbackStatus === "failed" ? "failed" : "pending";
  const eventCreatedSeconds = Number(eventCreated);
  return {
    amount_cents: succeeded ? invoice.amount_paid || 0 : invoice.amount_due || 0,
    currency: invoice.currency || "usd",
    status,
    paid_at: succeeded ? new Date((invoice.status_transitions?.paid_at || eventCreatedSeconds) * 1000).toISOString() : null,
    provider_event_created_at: new Date(eventCreatedSeconds * 1000).toISOString()
  };
}

export async function recordInvoicePayment(invoice, fallbackStatus, eventCreated, stripe = stripeApiClient()) {
  if (!invoice?.id) return false;
  const source = invoice.subscription || invoice.parent?.subscription_details?.subscription;
  const subscriptionId = typeof source === "string" ? source : source?.id;
  if (!subscriptionId) return false;
  const subscription = await stripe.subscriptions.retrieve(subscriptionId);
  const usesConfiguredPrice = subscriptionUsesConfiguredPrice(subscription, process.env.STRIPE_MONTHLY_PRICE_ID);
  const userId = subscription.metadata?.cafe_user_id;
  if (!await syncPreferredCustomerSubscription(subscription, stripe, eventCreated)) return false;
  if (!usesConfiguredPrice) return true;
  const payment = invoicePaymentRecord(invoice, fallbackStatus, eventCreated);
  await adminRows("rpc/record_stripe_subscription_payment", {
    method: "POST",
    body: JSON.stringify({
      p_cafe_user_id: userId,
      p_provider_payment_id: invoice.id,
      p_amount_cents: payment.amount_cents,
      p_currency: payment.currency,
      p_status: payment.status,
      p_paid_at: payment.paid_at,
      p_event_created_at: payment.provider_event_created_at
    })
  });
  return true;
}

async function recordRefund(eventCharge, eventCreated, stripe = stripeApiClient()) {
  const chargeId = String(eventCharge?.id || "");
  if (!/^ch_[A-Za-z0-9_]+$/.test(chargeId)) return false;
  const charge = await stripe.charges.retrieve(chargeId);
  const customerId = typeof charge?.customer === "string" ? charge.customer : charge?.customer?.id;
  const paymentIntentId = typeof charge?.payment_intent === "string" ? charge.payment_intent : charge?.payment_intent?.id;
  const amountRefunded = Number(charge?.amount_refunded);
  const expectedLivemode = stripeMode() === "live";
  if (
    charge?.id !== chargeId ||
    charge?.livemode !== expectedLivemode ||
    charge?.paid !== true ||
    !/^cus_[A-Za-z0-9_]+$/.test(String(customerId || "")) ||
    !/^pi_[A-Za-z0-9_]+$/.test(String(paymentIntentId || "")) ||
    !Number.isSafeInteger(amountRefunded) ||
    amountRefunded <= 0 ||
    charge?.currency !== "usd"
  ) return false;

  const invoicePayments = await stripe.invoicePayments.list({
    payment: { type: "payment_intent", payment_intent: paymentIntentId },
    status: "paid",
    limit: 2
  });
  if (invoicePayments?.has_more || invoicePayments?.data?.length !== 1) return false;
  const invoicePayment = invoicePayments.data[0];
  const linkedPaymentIntentId = typeof invoicePayment?.payment?.payment_intent === "string"
    ? invoicePayment.payment.payment_intent
    : invoicePayment?.payment?.payment_intent?.id;
  const invoiceId = typeof invoicePayment?.invoice === "string" ? invoicePayment.invoice : invoicePayment?.invoice?.id;
  if (
    invoicePayment?.status !== "paid" ||
    invoicePayment?.livemode !== expectedLivemode ||
    invoicePayment?.currency !== charge.currency ||
    invoicePayment?.payment?.type !== "payment_intent" ||
    linkedPaymentIntentId !== paymentIntentId ||
    !/^in_[A-Za-z0-9_]+$/.test(String(invoiceId || "")) ||
    !Number.isSafeInteger(invoicePayment?.amount_paid) ||
    invoicePayment.amount_paid < amountRefunded
  ) return false;

  const invoice = await stripe.invoices.retrieve(invoiceId);
  const invoiceCustomerId = typeof invoice?.customer === "string" ? invoice.customer : invoice?.customer?.id;
  const source = invoice?.subscription || invoice?.parent?.subscription_details?.subscription;
  const subscriptionId = typeof source === "string" ? source : source?.id;
  if (
    invoice?.id !== invoiceId ||
    invoice?.livemode !== expectedLivemode ||
    invoice?.currency !== charge.currency ||
    invoiceCustomerId !== customerId ||
    !/^sub_[A-Za-z0-9_]+$/.test(String(subscriptionId || ""))
  ) return false;

  const subscription = await stripe.subscriptions.retrieve(subscriptionId);
  const subscriptions = await adminRows(
    `cafe_subscriptions?stripe_customer_id=eq.${encodeURIComponent(customerId)}&stripe_subscription_id=eq.${encodeURIComponent(subscriptionId)}&select=user_id,stripe_customer_id,stripe_subscription_id&limit=2`
  );
  if (subscriptions.length !== 1) return false;
  const billing = subscriptions[0];
  const userId = billing?.user_id;
  if (
    !UUID.test(String(userId || "")) ||
    billing?.stripe_customer_id !== customerId ||
    billing?.stripe_subscription_id !== subscriptionId ||
    subscription?.id !== subscriptionId ||
    subscription?.livemode !== expectedLivemode ||
    !subscriptionBelongsToCafe(subscription, userId, customerId) ||
    !subscriptionUsesConfiguredPrice(subscription, process.env.STRIPE_MONTHLY_PRICE_ID)
  ) return false;

  const providerEventCreatedAt = eventCreatedAt(eventCreated);
  if (!providerEventCreatedAt) return false;
  await adminRows("rpc/record_stripe_subscription_payment", {
    method: "POST",
    body: JSON.stringify({
      p_cafe_user_id: userId,
      p_provider_payment_id: `refund:${charge.id}`,
      p_amount_cents: amountRefunded,
      p_currency: charge.currency,
      p_status: "refunded",
      p_paid_at: providerEventCreatedAt,
      p_event_created_at: providerEventCreatedAt
    })
  });
  return true;
}

async function stripeWebhook(req, res) {
  if (req.method !== "POST") { res.setHeader("Allow", "POST"); return res.status(405).send("Method not allowed"); }
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret?.startsWith("whsec_")) {
    console.error("Stripe webhook signing secret is not configured");
    return res.status(500).send("Webhook configuration error");
  }
  let event;
  try {
    event = constructStripeEvent(await rawBody(req), req.headers["stripe-signature"], secret);
  } catch (error) {
    console.error("Stripe webhook signature rejected", error?.message || error);
    return res.status(400).send("Webhook signature rejected");
  }
  const webhookClaimId = randomUUID();
  let claimed = false;
  try {
    const claim = await adminRows("rpc/claim_stripe_webhook_event", {
      method: "POST",
      body: JSON.stringify({ p_event_id: event.id, p_event_type: event.type, p_claim_id: webhookClaimId })
    });
    if (claim === "duplicate") return res.status(200).json({ received: true, duplicate: true });
    if (claim === "busy") return res.status(503).send("Webhook already processing");
    if (claim !== "claimed") throw new Error("Webhook event claim failed.");
    claimed = true;
    const stripe = BILLING_EVENT_TYPES.has(event.type) ? await stripeWebhookClient() : null;
    if (["checkout.session.completed", "checkout.session.async_payment_succeeded"].includes(event.type) && checkoutSessionCanFulfill(event.data.object)) {
      await syncCheckoutSession(event.data.object, stripe, event.created);
    }
    if (["customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted"].includes(event.type)) await syncSubscriptionEvent(event.data.object, stripe, event.created);
    if (event.type === "invoice.paid") await recordInvoicePayment(event.data.object, "succeeded", event.created, stripe);
    if (event.type === "invoice.payment_failed") await recordInvoicePayment(event.data.object, "failed", event.created, stripe);
    if (event.type === "charge.refunded") await recordRefund(event.data.object, event.created, stripe);
    const completed = await adminRows("rpc/complete_stripe_webhook_event", {
      method: "POST",
      body: JSON.stringify({ p_event_id: event.id, p_claim_id: webhookClaimId })
    });
    if (completed !== true) throw new Error("Webhook event completion failed.");
    return res.status(200).json({ received: true });
  } catch (error) {
    if (claimed) {
      try {
        await adminRows("rpc/fail_stripe_webhook_event", {
          method: "POST",
          body: JSON.stringify({ p_event_id: event.id, p_claim_id: webhookClaimId })
        });
      } catch (claimError) {
        console.error("Stripe webhook claim cleanup failed", claimError?.message || claimError);
      }
    }
    console.error("Stripe webhook processing failed", error?.message || error);
    return res.status(500).send("Webhook processing failed");
  }
}

export default async function handler(req, res) {
  const action = actionFor(req);
  if (action === "status") return billingStatus(req, res);
  if (action === "checkout") return createCheckout(req, res);
  if (action === "portal") return createPortal(req, res);
  if (action === "confirm") return confirmCheckout(req, res);
  if (action === "webhook") return stripeWebhook(req, res);
  return res.status(404).json({ error: "Billing route not found." });
}
