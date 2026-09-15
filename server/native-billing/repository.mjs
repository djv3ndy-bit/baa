/** Wraps the existing server-only Supabase transport. No client can select an
 * account, provider, or grant by calling the private ledger directly. */
import { retryBillingRead } from './retryRead.mjs';

const safeReads = new Set(['native_checkout_pending', 'native_billing_summary',
  'native_billing_owner', 'native_billing_read', 'native_checkout_settle_verified']);

export function nativeBillingRepository(adminRows) {
  const rpc = (name, body) => {
    const read = () => adminRows(`rpc/${name}`, { method: 'POST', body: JSON.stringify(body) });
    // settle_verified only settles a reservation using provider status already
    // verified in the ledger; repeating it cannot create a purchase or charge.
    return safeReads.has(name) ? retryBillingRead(read) : read();
  };
  return {
    claimCheckout(userId, provider, environment, attemptId) {
      return rpc('native_checkout_claim', { p_user_id: userId, p_provider: provider, p_environment: environment, p_attempt_id: attemptId });
    },
    startCheckout(userId, environment, attemptId) {
      return rpc('native_checkout_start', { p_user_id: userId, p_environment: environment, p_attempt_id: attemptId });
    },
    cancelCheckout(userId, environment, attemptId, beforeLaunch) {
      return rpc('native_checkout_cancel', { p_user_id: userId, p_environment: environment, p_attempt_id: attemptId, p_before_launch: beforeLaunch });
    },
    recoverAppleCheckout(userId, environment) {
      return rpc('native_checkout_recover_apple', { p_user_id: userId, p_environment: environment });
    },
    checkoutPending(userId, environment) {
      return rpc('native_checkout_pending', { p_user_id: userId, p_environment: environment });
    },
    settleVerifiedCheckout(userId, environment) {
      return rpc('native_checkout_settle_verified', { p_user_id: userId, p_environment: environment });
    },
    summary(userId, environment) {
      return rpc('native_billing_summary', { p_user_id: userId, p_environment: environment });
    },
    async owner(binding) {
      const result = await rpc('native_billing_owner', { p_binding: binding });
      return result ? { userId: result } : null;
    },
    async activeCafe(userId) {
      const rows = await retryBillingRead(() => adminRows(`profiles?id=eq.${encodeURIComponent(userId)}&select=id,role,suspended_at&limit=1`));
      return rows.length === 1 && rows[0].role === 'cafe_owner_manager' && !rows[0].suspended_at;
    },
    async read(provider, environment, subscriptionId) {
      const row = await rpc('native_billing_read', { p_provider: provider, p_environment: environment, p_subscription_id: subscriptionId });
      if (!row) return null;
      const revision = Number(row.revision);
      if (!Number.isSafeInteger(revision) || revision < 0) throw new Error('Invalid billing revision');
      return { userId: row.user_id, revision };
    },
    apply(status) {
      return rpc('native_billing_apply', {
        p_user_id: status.userId, p_binding: status.binding, p_provider: status.provider, p_environment: status.environment,
        p_subscription_id: status.providerSubscriptionId, p_product_id: status.productId, p_transaction_id: status.transactionId,
        p_status: status.status, p_period_end: status.currentPeriodEnd, p_grace_end: status.gracePeriodEnd,
        p_auto_renews: status.autoRenews, p_expected_revision: status.expectedRevision,
        p_linked_subscription_id: status.linkedPurchaseToken ?? null,
      });
    },
    claimEvent({ provider, environment, eventId, payloadHash, claimId }) {
      return rpc('native_billing_claim_event', { p_provider: provider, p_environment: environment, p_event_id: eventId, p_payload_hash: payloadHash, p_claim_id: claimId });
    },
    finishEvent({ provider, environment, eventId, claimId, success }) {
      return rpc('native_billing_finish_event', { p_provider: provider, p_environment: environment, p_event_id: eventId, p_claim_id: claimId, p_success: success });
    },
  };
}
