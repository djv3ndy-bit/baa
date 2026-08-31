import { authenticatedCafe, json, subscriptionFor } from "./_billing.js";
export default async function handler(req, res) {
  json(res);
  if (req.method !== "GET") { res.setHeader("Allow", "GET"); return res.status(405).json({ error: "Method not allowed." }); }
  try {
    const user = await authenticatedCafe(req);
    if (!user) return res.status(401).json({ error: "Please log in with a café account." });
    const s = await subscriptionFor(user.id);
    if (!s) return res.status(404).json({ error: "Start your free month first." });
    return res.status(200).json({ status:s.status, trialEndsAt:s.trial_ends_at, currentPeriodEnd:s.current_period_end, cancelAtPeriodEnd:Boolean(s.cancel_at_period_end), complimentaryAccess:Boolean(s.complimentary_access), connectedToBilling:Boolean(s.stripe_subscription_id) });
  } catch (error) { console.error("Billing status failed", error?.message || error); return res.status(503).json({ error: "Subscription details are temporarily unavailable." }); }
}
