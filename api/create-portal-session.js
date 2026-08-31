import { authenticatedCafe, json, origin, stripeClient, subscriptionFor } from "./_billing.js";
export default async function handler(req, res) {
  json(res);
  if (req.method !== "POST") { res.setHeader("Allow", "POST"); return res.status(405).json({ error:"Method not allowed." }); }
  try {
    const user = await authenticatedCafe(req);
    if (!user) return res.status(401).json({ error:"Please log in with a café account." });
    const billing = await subscriptionFor(user.id);
    if (!billing?.stripe_customer_id) return res.status(409).json({ error:"Subscribe first to manage billing." });
    const mobile = req.body?.channel === "mobile";
    const session = await stripeClient().billingPortal.sessions.create({ customer:billing.stripe_customer_id, return_url:mobile?`${origin(req)}/mobile-billing-return.html?billing=portal`:`${origin(req)}/dashboard.html` });
    return res.status(200).json({ url:session.url });
  } catch (error) { console.error("Stripe portal failed", error?.type || error?.message || error); return res.status(502).json({ error:"Billing management could not be opened. Please try again." }); }
}
