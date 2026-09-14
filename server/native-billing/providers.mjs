import { PurchaseVerificationError, verifiedAppleStatus, verifiedGoogleStatus } from './verifiedStatus.mjs';
import { retryBillingRead } from './retryRead.mjs';

function check(condition, code) { if (!condition) throw new PurchaseVerificationError(code); }
function opaque(value, max = 32_768) { return typeof value === 'string' && value.length > 0 && value.length <= max; }

/** Expects Apple's official AppStoreServerAPIClient and SignedDataVerifier,
 * constructed on the server with pinned app identity, environment and trusted
 * Apple root certificates. Online signature/certificate checks stay enabled. */
export function appleProvider({ client, verifier, bundleId, productId, environment, now = Date.now }) {
  check(bundleId && productId && ['Sandbox', 'Production'].includes(environment), 'SERVER_CONFIGURATION');
  return {
    async identify(proof) {
      check(opaque(proof), 'INVALID_PROOF');
      const transaction = await verifier.verifyAndDecodeTransaction(proof);
      check(transaction.bundleId === bundleId && transaction.productId === productId && transaction.environment === environment, 'PURCHASE_MISMATCH');
      check(opaque(transaction.originalTransactionId, 255) && opaque(transaction.appAccountToken, 255), 'INVALID_TRANSACTION');
      return { providerSubscriptionId: transaction.originalTransactionId, binding: transaction.appAccountToken };
    },
    async verify(proof, binding) {
      check(opaque(proof), 'INVALID_PROOF');
      const presented = await verifier.verifyAndDecodeTransaction(proof);
      check(presented.bundleId === bundleId && presented.productId === productId && presented.environment === environment && presented.appAccountToken === binding, 'PURCHASE_MISMATCH');
      check(opaque(presented.originalTransactionId, 255), 'INVALID_TRANSACTION');
      // A historically valid receipt is not proof that a subscription is still
      // active. Always fetch current status and verify each returned JWS.
      const current = await retryBillingRead(() => client.getAllSubscriptionStatuses(presented.originalTransactionId));
      check(current.bundleId === bundleId && current.environment === environment && Array.isArray(current.data), 'INVALID_RESPONSE');
      const entries = current.data.flatMap(group => group.lastTransactions || []).filter(row => row.originalTransactionId === presented.originalTransactionId);
      check(entries.length === 1, 'AMBIGUOUS_SUBSCRIPTION');
      const row = entries[0];
      check(opaque(row.signedTransactionInfo), 'INVALID_TRANSACTION');
      const transaction = await verifier.verifyAndDecodeTransaction(row.signedTransactionInfo);
      check(transaction.originalTransactionId === presented.originalTransactionId, 'PURCHASE_MISMATCH');
      const renewal = row.signedRenewalInfo ? await verifier.verifyAndDecodeRenewalInfo(row.signedRenewalInfo) : null;
      if ([1, 3, 4].includes(row.status)) check(renewal !== null, 'RENEWAL_UNAVAILABLE');
      return verifiedAppleStatus(transaction, renewal, row.status, { bundleId, productId, environment, binding }, now());
    },
    async notification(signedPayload) {
      check(opaque(signedPayload, 131_072), 'INVALID_EVENT');
      const value = await verifier.verifyAndDecodeNotification(signedPayload);
      check(opaque(value.notificationUUID, 255) && value.data?.bundleId === bundleId && value.data?.environment === environment, 'INVALID_EVENT');
      if (value.notificationType === 'TEST') return { eventId: value.notificationUUID, provider: 'apple', test: true };
      // The event schedules authoritative reconciliation; it does not directly
      // grant/revoke access from an event name or client-supplied timestamp.
      check(opaque(value.data.signedTransactionInfo), 'INVALID_EVENT');
      const transaction = await verifier.verifyAndDecodeTransaction(value.data.signedTransactionInfo);
      check(transaction.bundleId === bundleId && transaction.productId === productId && transaction.environment === environment && opaque(transaction.originalTransactionId, 255), 'INVALID_EVENT');
      return { eventId: value.notificationUUID, provider: 'apple', providerSubscriptionId: transaction.originalTransactionId, proof: value.data.signedTransactionInfo };
    },
  };
}

/** authClient is Google's server-side authenticated client. The package and
 * product are trusted configuration, never values copied from a request. */
export function googleProvider({ authClient, packageName, productId, basePlanId, environment, now = Date.now }) {
  check(packageName && productId && basePlanId && ['Sandbox', 'Production'].includes(environment), 'SERVER_CONFIGURATION');
  const root = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${encodeURIComponent(packageName)}/purchases`;
  return {
    async identify(purchaseToken) {
      check(opaque(purchaseToken, 8192), 'INVALID_PROOF');
      const response = await authClient.request({ url: `${root}/subscriptionsv2/tokens/${encodeURIComponent(purchaseToken)}`, method: 'GET', timeout: 15_000 });
      const binding = response.data?.externalAccountIdentifiers?.obfuscatedExternalAccountId;
      // Validate identity with an authenticated provider response, then read the
      // ledger revision before fetching current state again for reconciliation.
      const verified = verifiedGoogleStatus(response.data, { productId, basePlanId, environment, binding, purchaseToken }, now());
      return { providerSubscriptionId: verified.providerSubscriptionId, binding };
    },
    async verify(purchaseToken, binding) {
      check(opaque(purchaseToken, 8192), 'INVALID_PROOF');
      const response = await authClient.request({ url: `${root}/subscriptionsv2/tokens/${encodeURIComponent(purchaseToken)}`, method: 'GET', timeout: 15_000 });
      return verifiedGoogleStatus(response.data, { productId, basePlanId, environment, binding, purchaseToken }, now());
    },
    async acknowledge(purchaseToken) {
      check(opaque(purchaseToken, 8192), 'INVALID_PROOF');
      // Caller must first durably record verified access. An acknowledgement
      // timeout must be retried against the same token, never another purchase.
      await authClient.request({ url: `${root}/subscriptions/${encodeURIComponent(productId)}/tokens/${encodeURIComponent(purchaseToken)}:acknowledge`, method: 'POST', data: {}, timeout: 15_000 });
    },
  };
}

/** Requires Google OAuth2Client.verifyIdToken for the exact Pub/Sub audience. */
export async function verifiedGoogleNotification({ authorization, body, oauthClient, audience, serviceAccountEmail, packageName }) {
  const bearer = /^Bearer ([^\s]+)$/.exec(authorization || '');
  check(bearer && audience && serviceAccountEmail && packageName, 'EVENT_UNAUTHORIZED');
  const ticket = await oauthClient.verifyIdToken({ idToken: bearer[1], audience });
  const identity = ticket.getPayload();
  check(identity?.email === serviceAccountEmail && identity.email_verified === true && ['accounts.google.com', 'https://accounts.google.com'].includes(identity.iss), 'EVENT_UNAUTHORIZED');
  check(opaque(body?.message?.messageId, 255) && opaque(body?.message?.data, 65_536), 'INVALID_EVENT');
  let event;
  try { event = JSON.parse(Buffer.from(body.message.data, 'base64').toString('utf8')); } catch { throw new PurchaseVerificationError('INVALID_EVENT'); }
  check(event.packageName === packageName, 'INVALID_EVENT');
  if (event.testNotification) return { eventId: body.message.messageId, provider: 'google', test: true };
  check(opaque(event.subscriptionNotification?.purchaseToken, 8192), 'INVALID_EVENT');
  return { eventId: body.message.messageId, provider: 'google', providerSubscriptionId: event.subscriptionNotification.purchaseToken };
}
