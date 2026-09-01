import { adminRows, authenticatedCafe, json, origin, stripeClient, subscriptionFor, updateSubscription } from "./_billing.js";

export const config = { api: { bodyParser: false } };
const BILLING_PAUSED = process.env.BILLING_ENABLED !== "true";
const BILLING_PAUSED_MESSAGE = "Payments are paused. Café accounts currently have full complimentary access.";

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

async function billingStatus(req, res) {
  json(res);
  if (req.method !== "GET") { res.setHeader("Allow", "GET"); return res.status(405).json({ error: "Method not allowed." }); }
  try {
    const user = await authenticatedCafe(req);
    if (!user) return res.status(401).json({ error: "Please log in with a café account." });
    const subscription = await subscriptionFor(user.id);
    if (BILLING_PAUSED) return res.status(200).json({
      status: "complimentary",
      trialEndsAt: null,
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
      complimentaryAccess: true,
      connectedToBilling: false,
      billingPaused: true,
      message: BILLING_PAUSED_MESSAGE
    });
    // The database flag is the temporary blanket grant used while billing is
    // paused. Once the explicit launch switch is on, expose the real trial or
    // subscription state so the supported UI can open sandbox Checkout.
    const complimentaryAccess = false;
    return res.status(200).json({
      status: complimentaryAccess ? "complimentary" : (subscription?.status || "not_started"),
      trialEndsAt: subscription?.trial_ends_at || null,
      currentPeriodEnd: subscription?.current_period_end || null,
      cancelAtPeriodEnd: Boolean(subscription?.cancel_at_period_end),
      complimentaryAccess,
      connectedToBilling: Boolean(subscription?.stripe_subscription_id),
      billingPaused: false,
      message: complimentaryAccess ? "Your café has complimentary access." : null
    });
  } catch (error) {
    console.error("Billing status failed", error?.message || error);
    return res.status(503).json({ error: "Subscription details are temporarily unavailable." });
  }
}

async function createCheckout(req, res) {
  json(res);
  if (req.method !== "POST") { res.setHeader("Allow", "POST"); return res.status(405).json({ error: "Method not allowed." }); }
  if (BILLING_PAUSED) return res.status(503).json({ error: BILLING_PAUSED_MESSAGE, billingPaused: true });
  if (!process.env.STRIPE_MONTHLY_PRICE_ID) return res.status(503).json({ error: "The café plan is not configured yet." });
  try {
    const payload = await requestBody(req);
    const user = await authenticatedCafe(req);
    if (!user) return res.status(401).json({ error: "Please log in with a café account." });
    const billing = await subscriptionFor(user.id);
    if (!billing) return res.status(409).json({ error: "Start your free month before subscribing." });
    if (billing.stripe_subscription_id && ["active", "trialing", "past_due"].includes(billing.status)) {
      return res.status(409).json({ error: "This café already has a subscription. Open billing management instead." });
    }
    const stripe = await stripeClient();
    let customerId = billing.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: user.email,
        name: user.profile.cafe_name || user.profile.display_name || undefined,
        metadata: { cafe_user_id: user.id }
      }, { idempotencyKey: `baristamatch-customer-${user.id}` });
      customerId = customer.id;
      await updateSubscription(user.id, { stripe_customer_id: customerId });
    }
    const site = origin(req);
    const mobile = payload.channel === "mobile";
    const trialEnd = Math.floor(new Date(billing.trial_ends_at || 0).getTime() / 1000);
    const subscriptionData = { metadata: { cafe_user_id: user.id } };
    if (trialEnd > Math.floor(Date.now() / 1000) + 48 * 60 * 60) subscriptionData.trial_end = trialEnd;
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customerId,
      client_reference_id: user.id,
      line_items: [{ price: process.env.STRIPE_MONTHLY_PRICE_ID, quantity: 1 }],
      success_url: mobile ? `${site}/mobile-billing-return.html?billing=success` : `${site}/dashboard.html?billing=success`,
      cancel_url: mobile ? `${site}/mobile-billing-return.html?billing=canceled` : `${site}/dashboard.html?billing=canceled`,
      integration_identifier: mobile ? "baristamatch_app_yhvkqjpw" : "baristamatch_web_qtmzjvka",
      metadata: { cafe_user_id: user.id },
      subscription_data: subscriptionData,
      allow_promotion_codes: true
    }, { idempotencyKey: `baristamatch-checkout-${mobile ? "app" : "web"}-${user.id}-${Math.floor(Date.now() / 300000)}` });
    return res.status(200).json({ url: session.url });
  } catch (error) {
    console.error("Stripe Checkout failed", error?.type || error?.message || error);
    return res.status(502).json({ error: "Secure checkout could not be opened. Please try again." });
  }
}

async function createPortal(req, res) {
  json(res);
  if (req.method !== "POST") { res.setHeader("Allow", "POST"); return res.status(405).json({ error: "Method not allowed." }); }
  if (BILLING_PAUSED) return res.status(503).json({ error: BILLING_PAUSED_MESSAGE, billingPaused: true });
  try {
    const payload = await requestBody(req);
    const user = await authenticatedCafe(req);
    if (!user) return res.status(401).json({ error: "Please log in with a café account." });
    const billing = await subscriptionFor(user.id);
    if (!billing?.stripe_customer_id) return res.status(409).json({ error: "Subscribe first to manage billing." });
    const mobile = payload.channel === "mobile";
    const stripe = await stripeClient();
    const session = await stripe.billingPortal.sessions.create({
      customer: billing.stripe_customer_id,
      return_url: mobile ? `${origin(req)}/mobile-billing-return.html?billing=portal` : `${origin(req)}/dashboard.html`
    });
    return res.status(200).json({ url: session.url });
  } catch (error) {
    console.error("Stripe portal failed", error?.type || error?.message || error);
    return res.status(502).json({ error: "Billing management could not be opened. Please try again." });
  }
}

function periodEnd(subscription) {
  const unix = subscription.current_period_end || subscription.items?.data?.[0]?.current_period_end;
  return unix ? new Date(unix * 1000).toISOString() : null;
}

async function syncSubscription(subscription) {
  const userId = subscription.metadata?.cafe_user_id;
  if (!userId) throw new Error("Subscription is missing cafe_user_id metadata.");
  const status = ["active", "trialing", "canceled"].includes(subscription.status)
    ? subscription.status
    : ["past_due", "unpaid", "incomplete"].includes(subscription.status) ? "past_due" : "expired";
  await updateSubscription(userId, {
    stripe_customer_id: String(subscription.customer),
    stripe_subscription_id: subscription.id,
    status,
    complimentary_access: BILLING_PAUSED,
    current_period_end: periodEnd(subscription),
    cancel_at_period_end: Boolean(subscription.cancel_at_period_end)
  });
}

async function recordInvoicePayment(invoice, status) {
  const source = invoice.subscription || invoice.parent?.subscription_details?.subscription;
  const subscriptionId = typeof source === "string" ? source : source?.id;
  if (!subscriptionId) return;
  const stripe = await stripeClient();
  const subscription = await stripe.subscriptions.retrieve(subscriptionId);
  const userId = subscription.metadata?.cafe_user_id;
  if (!userId) return;
  await adminRows("subscription_payments?on_conflict=provider_payment_id", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({
      cafe_user_id: userId,
      provider: "stripe",
      provider_payment_id: invoice.id,
      amount_cents: invoice.amount_paid || invoice.amount_due || 0,
      currency: invoice.currency || "usd",
      status,
      paid_at: status === "succeeded" ? new Date((invoice.status_transitions?.paid_at || Math.floor(Date.now() / 1000)) * 1000).toISOString() : null
    })
  });
}

async function recordRefund(charge) {
  const customerId = typeof charge.customer === "string" ? charge.customer : charge.customer?.id;
  if (!customerId) return;
  const subscriptions = await adminRows(`cafe_subscriptions?stripe_customer_id=eq.${encodeURIComponent(customerId)}&select=user_id&limit=1`);
  const userId = subscriptions[0]?.user_id;
  if (!userId) return;
  await adminRows("subscription_payments?on_conflict=provider_payment_id", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({
      cafe_user_id: userId,
      provider: "stripe",
      provider_payment_id: `refund:${charge.id}`,
      amount_cents: charge.amount_refunded || 0,
      currency: charge.currency || "usd",
      status: "refunded",
      paid_at: new Date((charge.created || Math.floor(Date.now() / 1000)) * 1000).toISOString()
    })
  });
}

async function stripeWebhook(req, res) {
  if (req.method !== "POST") { res.setHeader("Allow", "POST"); return res.status(405).send("Method not allowed"); }
  try {
    const stripe = await stripeClient();
    const event = stripe.webhooks.constructEvent(await rawBody(req), req.headers["stripe-signature"], process.env.STRIPE_WEBHOOK_SECRET);
    const previous = await adminRows(`stripe_webhook_events?event_id=eq.${encodeURIComponent(event.id)}&select=event_id&limit=1`);
    if (previous.length) return res.status(200).json({ received: true, duplicate: true });
    if (["customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted"].includes(event.type)) await syncSubscription(event.data.object);
    if (event.type === "invoice.paid") await recordInvoicePayment(event.data.object, "succeeded");
    if (event.type === "invoice.payment_failed") await recordInvoicePayment(event.data.object, "failed");
    if (event.type === "charge.refunded") await recordRefund(event.data.object);
    await adminRows("stripe_webhook_events", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ event_id: event.id, event_type: event.type }) });
    return res.status(200).json({ received: true });
  } catch (error) {
    console.error("Stripe webhook rejected", error?.message || error);
    return res.status(400).send("Webhook rejected");
  }
}

export default async function handler(req, res) {
  const action = actionFor(req);
  if (action === "status") return billingStatus(req, res);
  if (action === "checkout") return createCheckout(req, res);
  if (action === "portal") return createPortal(req, res);
  if (action === "webhook") return stripeWebhook(req, res);
  return res.status(404).json({ error: "Billing route not found." });
}
