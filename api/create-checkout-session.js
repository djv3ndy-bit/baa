import { authenticatedCafe, json, origin, stripeClient, subscriptionFor, updateSubscription } from "./_billing.js";
export default async function handler(req, res) {
  json(res);
  if (req.method !== "POST") { res.setHeader("Allow", "POST"); return res.status(405).json({ error: "Method not allowed." }); }
  if (!process.env.STRIPE_MONTHLY_PRICE_ID) return res.status(503).json({ error: "The café plan is not configured yet." });
  try {
    const user = await authenticatedCafe(req);
    if (!user) return res.status(401).json({ error: "Please log in with a café account." });
    const billing = await subscriptionFor(user.id);
    if (!billing) return res.status(409).json({ error: "Start your free month before subscribing." });
    if (billing.stripe_subscription_id && ["active","trialing","past_due"].includes(billing.status)) return res.status(409).json({ error: "This café already has a subscription. Open billing management instead." });
    const stripe = await stripeClient();
    let customerId = billing.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({ email:user.email, name:user.profile.cafe_name || user.profile.display_name || undefined, metadata:{cafe_user_id:user.id} }, { idempotencyKey:`baristamatch-customer-${user.id}` });
      customerId = customer.id;
      await updateSubscription(user.id, { stripe_customer_id:customerId });
    }
    const site = origin(req), mobile = req.body?.channel === "mobile", trialEnd = Math.floor(new Date(billing.trial_ends_at || 0).getTime()/1000), subscriptionData = { metadata:{cafe_user_id:user.id} };
    if (trialEnd > Math.floor(Date.now()/1000) + 48*60*60) subscriptionData.trial_end = trialEnd;
    const successUrl = mobile ? `${site}/mobile-billing-return.html?billing=success` : `${site}/dashboard.html?billing=success`;
    const cancelUrl = mobile ? `${site}/mobile-billing-return.html?billing=canceled` : `${site}/dashboard.html?billing=canceled`;
    const session = await stripe.checkout.sessions.create({ mode:"subscription", customer:customerId, client_reference_id:user.id, line_items:[{price:process.env.STRIPE_MONTHLY_PRICE_ID,quantity:1}], success_url:successUrl, cancel_url:cancelUrl, integration_identifier:mobile?"baristamatch_app_yhvkqjpw":"baristamatch_web_qtmzjvka", metadata:{cafe_user_id:user.id}, subscription_data:subscriptionData, allow_promotion_codes:true }, { idempotencyKey:`baristamatch-checkout-${mobile?'app':'web'}-${user.id}-${Math.floor(Date.now()/300000)}` });
    return res.status(200).json({ url:session.url });
  } catch (error) { console.error("Stripe Checkout failed", error?.type || error?.message || error); return res.status(502).json({ error:"Secure checkout could not be opened. Please try again." }); }
}
