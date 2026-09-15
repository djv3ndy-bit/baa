import { logPaymentFailure, paymentFailureReport } from './diagnostics.mjs';

/** Reuse the existing provider handler without an HTTP request or token forwarding. */
export async function captureBillingStatus(handler, req, {
  wait = ms => new Promise(resolve => setTimeout(resolve, ms)),
} = {}) {
  for (let attempt = 0; ; attempt++) {
    const result = { code: 0, headers: {}, body: undefined };
    const res = {
      setHeader(name, value) { result.headers[name] = value; },
      status(code) { result.code = code; return this; },
      json(body) { result.body = body; return this; },
    };
    await handler({ ...req, headers: req.headers, method: 'GET', query: { action: 'status' } }, res);
    // The preserved status action only reads account/subscription state. Never
    // retry checkout, portal creation, permission denials or rate limiting.
    if (attempt === 2 || ![500, 502, 503, 504].includes(result.code)) return result;
    await wait(attempt === 0 ? 200 : 600);
  }
}

export const nativeManagementUrls = Object.freeze({
  apple: 'https://apps.apple.com/account/subscriptions',
  google: 'https://play.google.com/store/account/subscriptions?package=com.baristajobmatch.app',
});

/** Keep the legacy status contract for every released client. The additional
 * nativeStatus field is verified server data, never a fabricated Stripe record. */
export function accountBillingView(website, combined) {
  const nativeRows = combined.subscriptions.filter(row => row.provider !== 'stripe');
  if (!nativeRows.length && !combined.checkoutPending) return website;
  const primary = combined.subscriptions[0];
  const nativeOwnsAccess = primary && primary.provider !== 'stripe';
  const needsAttention = ['pending', 'payment_required'].includes(combined.status);
  const blocksPurchase = combined.access === 'pro' || combined.checkoutPending || needsAttention;
  return {
    ...website,
    plan: combined.access,
    status: nativeOwnsAccess || combined.checkoutPending
      ? combined.access === 'pro' ? 'active' : needsAttention ? 'incomplete' : 'canceled'
      : website.status,
    connectedToBilling: website.connectedToBilling || nativeRows.length > 0,
    canManageBilling: website.canManageBilling || blocksPurchase,
    // Older clients must not claim the next charge is the end of an expired
    // billing period while verified grace access is still in effect.
    currentPeriodEnd: nativeOwnsAccess
      ? primary.status === 'grace' ? primary.gracePeriodEnd : primary.currentPeriodEnd
      : website.currentPeriodEnd,
    cancelAtPeriodEnd: nativeOwnsAccess ? !primary.autoRenews : website.cancelAtPeriodEnd,
    nativeStatus: combined,
  };
}

export function accountBillingHandler({ existingBilling, authenticateCafe, statusFor, configured, logFailure = logPaymentFailure }) {
  return async (req, res) => {
    const action = req.query?.action || 'status';
    // Turning off new purchases must not turn off verified access. This gate
    // denotes installed native billing, independently of the purchase switch.
    if (!configured() || !['status', 'portal'].includes(action)) return existingBilling(req, res);
    res.setHeader('Cache-Control', 'no-store');
    const method = action === 'status' ? 'GET' : 'POST';
    if (req.method !== method) { res.setHeader('Allow', method); return res.status(405).json({ error: 'Method not allowed.' }); }
    let stage = 'authentication';
    try {
      const captured = await captureBillingStatus(existingBilling, req);
      for (const [key, value] of Object.entries(captured.headers)) res.setHeader(key, value);
      if (captured.code !== 200) return res.status(captured.code || 503).json(captured.body || { error: 'Subscription status is unavailable.' });
      const user = await authenticateCafe(req);
      if (!user) return res.status(401).json({ error: 'Please log in with your café account.' });
      if (user.profile?.role !== 'cafe_owner_manager' || user.profile.suspended_at) return res.status(403).json({ error: 'This account cannot manage café subscriptions.' });
      stage = 'reconciliation';
      const combined = await statusFor({ id: user.id, role: user.profile.role, suspendedAt: user.profile.suspended_at }, captured.body);
      if (combined.accountId !== user.id || combined.verified !== true) throw new Error('Account changed');
      if (action === 'status') return res.status(200).json(accountBillingView(captured.body, combined));
      let body = req.body || {};
      if (Buffer.isBuffer(body)) body = body.toString('utf8');
      if (typeof body === 'string') {
        if (Buffer.byteLength(body) > 4096) return res.status(413).json({ error: 'Request is too large.' });
        try { body = JSON.parse(body); } catch { return res.status(400).json({ error: 'Request is invalid.' }); }
      }
      if (!body || typeof body !== 'object' || Array.isArray(body) || Buffer.byteLength(JSON.stringify(body)) > 4096) return res.status(400).json({ error: 'Request is invalid.' });
      if (body.provider !== undefined && !['stripe', 'apple', 'google'].includes(body.provider)) return res.status(400).json({ error: 'Billing provider is invalid.' });
      // Expired Stripe history can coexist with an Apple subscription whose
      // management page remains available. Select an owned, manageable provider.
      const provider = body.provider || (captured.body.canManageBilling ? 'stripe'
        : combined.subscriptions.find(row => row.canManage)?.provider);
      if (provider === 'stripe' && captured.body.canManageBilling) return existingBilling(req, res);
      if (nativeManagementUrls[provider] && combined.subscriptions.some(row => row.provider === provider && row.canManage)) {
        return res.status(200).json({ url: nativeManagementUrls[provider], provider, systemManagement: true });
      }
      return res.status(409).json({ error: combined.checkoutPending
        ? 'A purchase is still being confirmed. Restore purchases in the app, or contact subscription support.'
        : 'There is no current subscription to manage. Open the café plans to subscribe.' });
    } catch (error) {
      try { logFailure({ ...paymentFailureReport(error, { stage }), event: 'native_billing_status_failed' }); }
      catch { /* Reporting cannot change entitlement or checkout decisions. */ }
      // A ledger outage is not proof of a Free account or permission to charge.
      return res.status(503).json({ error: 'Subscription details are temporarily unavailable. Please try again.' });
    }
  };
}
