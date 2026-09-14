/** Converts already verified provider responses into account entitlements.
 * Never call these reducers on a decoded-but-unverified client receipt. */
export class PurchaseVerificationError extends Error {
  constructor(code = 'PURCHASE_UNVERIFIED') { super('The purchase could not be confirmed.'); this.code = code; }
}
function requireValue(condition, code) { if (!condition) throw new PurchaseVerificationError(code); }
function expiry(value) { const result = typeof value === 'number' ? value : Date.parse(value); return Number.isFinite(result) && result > 0 ? result : null; }
const iso = value => value ? new Date(value).toISOString() : null;

export function verifiedAppleStatus(transaction, renewal, providerStatus, expected, now = Date.now()) {
  requireValue(transaction?.bundleId === expected.bundleId && transaction.productId === expected.productId && transaction.environment === expected.environment, 'PRODUCT_MISMATCH');
  requireValue(transaction.appAccountToken === expected.binding && typeof expected.binding === 'string' && expected.binding.length > 0, 'ACCOUNT_MISMATCH');
  requireValue(transaction.type === 'Auto-Renewable Subscription' && transaction.inAppOwnershipType === 'PURCHASED' && !transaction.isUpgraded, 'UNSUPPORTED_PURCHASE');
  requireValue(typeof transaction.originalTransactionId === 'string' && transaction.originalTransactionId && typeof transaction.transactionId === 'string' && transaction.transactionId, 'INVALID_TRANSACTION');
  requireValue([1, 2, 3, 4, 5].includes(providerStatus), 'UNKNOWN_STATE');
  if (renewal) {
    requireValue(renewal.originalTransactionId === transaction.originalTransactionId && renewal.productId === expected.productId && renewal.environment === expected.environment, 'RENEWAL_MISMATCH');
  }
  const end = expiry(transaction.expiresDate), grace = expiry(renewal?.gracePeriodExpiresDate);
  requireValue(end !== null, 'INVALID_EXPIRY');
  const revoked = transaction.revocationDate != null || providerStatus === 5;
  const access = !revoked && ((providerStatus === 1 && end > now) || (providerStatus === 4 && grace > now)) ? 'pro' : 'free';
  const status = revoked ? 'revoked' : providerStatus === 4 && access === 'pro' ? 'grace' : access === 'pro' ? 'active' : providerStatus === 3 ? 'payment_required' : 'expired';
  return { provider: 'apple', providerSubscriptionId: transaction.originalTransactionId, transactionId: transaction.transactionId,
    binding: expected.binding, productId: transaction.productId, environment: expected.environment, access, status,
    currentPeriodEnd: iso(end), gracePeriodEnd: iso(grace), autoRenews: renewal?.autoRenewStatus === 1,
    canManage: ['active', 'grace', 'payment_required'].includes(status) };
}

export function verifiedGoogleStatus(subscription, expected, now = Date.now()) {
  requireValue(subscription?.kind === 'androidpublisher#subscriptionPurchaseV2', 'INVALID_RESPONSE');
  requireValue(subscription.externalAccountIdentifiers?.obfuscatedExternalAccountId === expected.binding && typeof expected.binding === 'string' && expected.binding.length > 0, 'ACCOUNT_MISMATCH');
  requireValue(Boolean(subscription.testPurchase) === (expected.environment === 'Sandbox'), 'ENVIRONMENT_MISMATCH');
  requireValue(Array.isArray(subscription.lineItems) && subscription.lineItems.length === 1, 'UNSUPPORTED_PURCHASE');
  const line = subscription.lineItems[0];
  requireValue(line.productId === expected.productId && line.offerDetails?.basePlanId === expected.basePlanId && !line.prepaidPlan, 'PRODUCT_MISMATCH');
  const state = subscription.subscriptionState;
  requireValue(['SUBSCRIPTION_STATE_PENDING', 'SUBSCRIPTION_STATE_ACTIVE', 'SUBSCRIPTION_STATE_PAUSED', 'SUBSCRIPTION_STATE_IN_GRACE_PERIOD', 'SUBSCRIPTION_STATE_ON_HOLD', 'SUBSCRIPTION_STATE_CANCELED', 'SUBSCRIPTION_STATE_EXPIRED', 'SUBSCRIPTION_STATE_PENDING_PURCHASE_CANCELED'].includes(state), 'UNKNOWN_STATE');
  const end = expiry(line.expiryTime), pending = state === 'SUBSCRIPTION_STATE_PENDING';
  if (!pending && state !== 'SUBSCRIPTION_STATE_PENDING_PURCHASE_CANCELED') requireValue(end !== null, 'INVALID_EXPIRY');
  const access = ['SUBSCRIPTION_STATE_ACTIVE', 'SUBSCRIPTION_STATE_IN_GRACE_PERIOD', 'SUBSCRIPTION_STATE_CANCELED'].includes(state) && end > now ? 'pro' : 'free';
  const status = pending ? 'pending' : access === 'pro' ? (state === 'SUBSCRIPTION_STATE_IN_GRACE_PERIOD' ? 'grace' : 'active') : ['SUBSCRIPTION_STATE_PAUSED', 'SUBSCRIPTION_STATE_ON_HOLD'].includes(state) ? 'payment_required' : 'expired';
  return { provider: 'google', providerSubscriptionId: expected.purchaseToken, transactionId: line.latestSuccessfulOrderId || subscription.latestOrderId || expected.purchaseToken,
    binding: expected.binding, productId: line.productId, basePlanId: expected.basePlanId, environment: expected.environment, access, status,
    currentPeriodEnd: iso(end), gracePeriodEnd: state === 'SUBSCRIPTION_STATE_IN_GRACE_PERIOD' ? iso(end) : null,
    autoRenews: line.autoRenewingPlan?.autoRenewEnabled === true,
    canManage: ['active', 'grace', 'payment_required'].includes(status),
    linkedPurchaseToken: !['SUBSCRIPTION_STATE_PENDING', 'SUBSCRIPTION_STATE_PENDING_PURCHASE_CANCELED'].includes(state) && typeof subscription.linkedPurchaseToken === 'string' && subscription.linkedPurchaseToken.length > 0 ? subscription.linkedPurchaseToken : null,
    needsAcknowledgement: subscription.acknowledgementState === 'ACKNOWLEDGEMENT_STATE_PENDING' && access === 'pro' };
}
