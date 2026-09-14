import test from 'node:test';
import assert from 'node:assert/strict';
import { verifiedAppleStatus, verifiedGoogleStatus } from '../../server/native-billing/verifiedStatus.mjs';
import { appleProvider, googleProvider, verifiedGoogleNotification } from '../../server/native-billing/providers.mjs';
const now = Date.parse('2026-09-11T00:00:00Z'), later = now + 86_400_000, before = now - 1000;
const expected = { binding: 'account-binding', bundleId: 'com.baristajobmatch.app', productId: 'test.monthly', environment: 'Sandbox' };
const txn = { ...expected, appAccountToken: expected.binding, type: 'Auto-Renewable Subscription', inAppOwnershipType: 'PURCHASED', originalTransactionId: 'original', transactionId: 'latest', expiresDate: later };
const renewal = { originalTransactionId: 'original', productId: expected.productId, environment: 'Sandbox', autoRenewStatus: 1 };
test('Apple active, grace, expiry, billing failure and revocation derive access from verified current state', () => {
  assert.equal(verifiedAppleStatus(txn, renewal, 1, expected, now).access, 'pro');
  assert.equal(verifiedAppleStatus({ ...txn, expiresDate: before }, { ...renewal, gracePeriodExpiresDate: later }, 4, expected, now).status, 'grace');
  for (const state of [2, 3, 5]) assert.equal(verifiedAppleStatus(txn, renewal, state, expected, now).access, 'free');
  assert.equal(verifiedAppleStatus({ ...txn, revocationDate: before }, renewal, 1, expected, now).status, 'revoked');
  assert.equal(verifiedAppleStatus({ ...txn, expiresDate: before }, renewal, 1, expected, now).access, 'free');
});
for (const mutation of [{ appAccountToken: 'another-account' }, { bundleId: 'another-app' }, { productId: 'annual' }, { environment: 'Production' }, { inAppOwnershipType: 'FAMILY_SHARED' }, { isUpgraded: true }, { expiresDate: null }]) test(`Apple rejects mismatched or unsupported purchase: ${JSON.stringify(mutation)}`, () => assert.throws(() => verifiedAppleStatus({ ...txn, ...mutation }, renewal, 1, expected, now)));
test('a valid historical Apple receipt is rechecked with the server and cannot hide revocation', async () => {
  const seen = [];
  const provider = appleProvider({ ...expected, now: () => now,
    verifier: { verifyAndDecodeTransaction: async proof => { seen.push(proof); return proof === 'old-proof' ? txn : { ...txn, revocationDate: before }; }, verifyAndDecodeRenewalInfo: async () => renewal },
    client: { getAllSubscriptionStatuses: async id => { assert.equal(id, 'original'); return { bundleId: expected.bundleId, environment: 'Sandbox', data: [{ lastTransactions: [{ originalTransactionId: id, signedTransactionInfo: 'fresh-proof', signedRenewalInfo: 'renewal-proof', status: 5 }] }] }; } },
  });
  assert.equal((await provider.verify('old-proof', expected.binding)).access, 'free'); assert.deepEqual(seen, ['old-proof', 'fresh-proof']);
});
test('invalid signatures stop before any Apple status request', async () => {
  let queried = false;
  const provider = appleProvider({ ...expected, verifier: { verifyAndDecodeTransaction: async () => { throw Error('Invalid signature'); } }, client: { getAllSubscriptionStatuses: async () => { queried = true; } } });
  await assert.rejects(provider.verify('forged', expected.binding)); assert.equal(queried, false);
});
const googleExpected = { ...expected, basePlanId: 'monthly', purchaseToken: 'test-token' };
const google = { kind: 'androidpublisher#subscriptionPurchaseV2', testPurchase: {}, externalAccountIdentifiers: { obfuscatedExternalAccountId: expected.binding }, subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE', acknowledgementState: 'ACKNOWLEDGEMENT_STATE_PENDING', lineItems: [{ productId: expected.productId, offerDetails: { basePlanId: 'monthly' }, expiryTime: new Date(later).toISOString(), autoRenewingPlan: { autoRenewEnabled: true } }] };
test('Google cancellation keeps already paid access until expiry; hold, pause and expiration do not', () => {
  for (const state of ['ACTIVE', 'IN_GRACE_PERIOD', 'CANCELED']) assert.equal(verifiedGoogleStatus({ ...google, subscriptionState: `SUBSCRIPTION_STATE_${state}` }, googleExpected, now).access, 'pro');
  for (const state of ['PENDING', 'ON_HOLD', 'PAUSED', 'EXPIRED', 'PENDING_PURCHASE_CANCELED']) assert.equal(verifiedGoogleStatus({ ...google, subscriptionState: `SUBSCRIPTION_STATE_${state}` }, googleExpected, now).access, 'free');
  assert.equal(verifiedGoogleStatus(google, googleExpected, now).needsAcknowledgement, true);
});
test('Google rejects different accounts, environments, products and base plans', () => {
  for (const config of [{ ...googleExpected, binding: 'another' }, { ...googleExpected, environment: 'Production' }, { ...googleExpected, productId: 'other' }, { ...googleExpected, basePlanId: 'annual' }]) assert.throws(() => verifiedGoogleStatus(google, config, now));
  assert.throws(() => verifiedGoogleStatus({ ...google, subscriptionState: 'NEW_UNKNOWN_STATE' }, googleExpected, now));
});
test('Google verification queries only the configured package and encodes the purchase token', async () => {
  const calls = []; const provider = googleProvider({ ...googleExpected, packageName: expected.bundleId, now: () => now, authClient: { request: async args => { calls.push(args); return { data: google }; } } });
  assert.equal((await provider.verify('opaque/token', expected.binding)).access, 'pro');
  assert.equal(calls[0].url, `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${expected.bundleId}/purchases/subscriptionsv2/tokens/opaque%2Ftoken`);
  assert.equal(calls.length, 1, 'verification does not prematurely acknowledge');
});
test('Pub/Sub notifications require exact audience, verified service-account identity and app package', async () => {
  const context = { authorization: 'Bearer signed-token', audience: 'https://test.invalid/native-events', serviceAccountEmail: 'events@test.invalid', packageName: expected.bundleId,
    oauthClient: { verifyIdToken: async options => { assert.equal(options.audience, 'https://test.invalid/native-events'); return { getPayload: () => ({ iss: 'https://accounts.google.com', email: 'events@test.invalid', email_verified: true }) }; } },
    body: { message: { messageId: 'message-id', data: Buffer.from(JSON.stringify({ packageName: expected.bundleId, subscriptionNotification: { purchaseToken: 'test-token' } })).toString('base64') } } };
  assert.equal((await verifiedGoogleNotification(context)).providerSubscriptionId, 'test-token');
  await assert.rejects(verifiedGoogleNotification({ ...context, serviceAccountEmail: 'other@test.invalid' }));
  await assert.rejects(verifiedGoogleNotification({ ...context, authorization: '' }));
  await assert.rejects(verifiedGoogleNotification({ ...context, packageName: 'another.app' }));
});
