import { logPaymentFailure, paymentFailureReport } from './diagnostics.mjs';

/** Verification transport. Enabling this endpoint alone does not enable sales:
 * native checkout and the shared entitlement integration have separate gates. */
export function verificationHandler({ authenticateCafe, runtimeFor, reconcilerFor, logFailure = logPaymentFailure }) {
  return async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'Method not allowed.' }); }
    let stage = 'request', failureProvider;
    try {
      const action = req.query?.action || 'verify';
      if (!['verify','apple-events','google-events'].includes(action)) return res.status(404).json({ error: 'Purchase route not found.' });
      let body = req.body;
      if (Buffer.isBuffer(body)) body = body.toString('utf8');
      if (typeof body === 'string') {
        if (Buffer.byteLength(body) > 262_144) return res.status(413).json({ error: 'Purchase details are too large.' });
        try { body = JSON.parse(body); } catch { return res.status(400).json({ error: 'Purchase details are invalid.' }); }
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)) return res.status(400).json({ error: 'Purchase details are invalid.' });
      if (Buffer.byteLength(JSON.stringify(body)) > 262_144) return res.status(413).json({ error: 'Purchase details are too large.' });
      if (action === 'verify') {
        stage = 'authentication';
        const user = await authenticateCafe(req);
        if (!user) return res.status(401).json({ error: 'Please log in with your café account.' });
        if (user.profile?.suspended_at) return res.status(403).json({ error: 'This café account cannot manage purchases.' });
        if (!['apple','google'].includes(body.provider) || typeof body.proof !== 'string' || !body.proof || body.proof.length > 32_768) {
          return res.status(400).json({ error: 'Purchase details are invalid.' });
        }
        failureProvider = body.provider;
        stage = 'provider-setup';
        const runtime = await runtimeFor(body.provider);
        stage = 'reconciliation';
        const result = await reconcilerFor(body.provider, runtime).reconcile({ provider: body.provider, proof: body.proof, accountId: user.id });
        // This describes the verified purchase, not the account's combined
        // entitlement. The client must refresh shared subscription status before
        // changing account access, including when restoring an expired receipt.
        // Never return provider tokens, opaque bindings, private ledger keys,
        // credentials, or the caller's self-asserted accountId to the device.
        return res.status(200).json({ accountId: user.id, verified: true, purchase: { provider: result.provider,
          access: result.access, status: result.status, currentPeriodEnd: result.currentPeriodEnd,
          autoRenews: result.autoRenews, canManage: result.canManage } });
      }
      const provider = action === 'apple-events' ? 'apple' : 'google';
      failureProvider = provider;
      stage = 'provider-setup';
      const runtime = await runtimeFor(provider);
      // No event may touch the ledger until its store signature or Google's
      // exact Pub/Sub audience and service-account identity have been checked.
      stage = 'signature';
      const event = provider === 'apple' ? await runtime.provider.notification(body.signedPayload)
        : await runtime.notification(req.headers.authorization, body);
      const payload = provider === 'apple' ? body.signedPayload : body.message.data;
      stage = 'reconciliation';
      await reconcilerFor(provider, runtime).notification({ ...event, proof: event.proof || event.providerSubscriptionId, payload });
      return res.status(200).json({ received: true });
    } catch (error) {
      const rejected = ['ACCOUNT_MISMATCH','PURCHASE_MISMATCH','PRODUCT_MISMATCH','ENVIRONMENT_MISMATCH','INVALID_PROOF','INVALID_TRANSACTION','INVALID_EVENT','EVENT_UNAUTHORIZED','ACCOUNT_UNAVAILABLE'].includes(error?.code);
      try { logFailure(paymentFailureReport(error, { provider: failureProvider, stage, rejected })); }
      catch { /* Diagnostics must never change retry or rejection behavior. */ }
      // Failures remain retryable by the store; no false success acknowledgements
      // and no provider error messages or receipt material in logs/responses.
      return res.status(rejected ? 403 : 503).json({ error: rejected
        ? 'This purchase could not be confirmed for this account.'
        : 'Purchase verification is temporarily unavailable. Your purchase will be checked again; do not purchase again.' });
    }
  };
}
