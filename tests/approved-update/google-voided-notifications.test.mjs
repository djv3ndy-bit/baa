import test from 'node:test';
import assert from 'node:assert/strict';
import { googleProvider, verifiedGoogleNotification } from '../../server/native-billing/providers.mjs';
import { createReconciler } from '../../server/native-billing/reconcile.mjs';
import { verificationHandler } from '../../server/native-billing/verificationHandler.mjs';

const packageName = 'com.baristajobmatch.app';
const purchaseToken = 'subscription/token';
const binding = 'saved-account-binding';
const ignoredReason = 'google-one-time-voided-purchase';
const now = Date.parse('2026-10-08T12:00:00Z');
const active = {
  kind: 'androidpublisher#subscriptionPurchaseV2', testPurchase: {},
  externalAccountIdentifiers: { obfuscatedExternalAccountId: binding },
  subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE', acknowledgementState: 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED',
  latestOrderId: 'GPA.current-renewal',
  lineItems: [{ productId: 'pro.monthly', offerDetails: { basePlanId: 'monthly' },
    expiryTime: '2026-11-08T12:00:00Z', autoRenewingPlan: { autoRenewEnabled: true } }],
};
const voided = (overrides = {}) => ({ purchaseToken, orderId: 'GPA.earlier-renewal', productType: 1, refundType: 1, ...overrides });

function fixture() {
  const calls = { provider: [], owner: 0, read: 0, apply: [], claim: 0, finish: [] };
  const events = new Map();
  let current = structuredClone(active), saved = { userId: 'saved-account', revision: 1, access: 'pro' };
  let providerError = null, ownerAvailable = true;
  const provider = googleProvider({ packageName, productId: 'pro.monthly', basePlanId: 'monthly', environment: 'Sandbox', now: () => now,
    authClient: { request: async request => {
      calls.provider.push(request);
      assert.equal(request.method, 'GET', 'these acknowledged purchase fixtures never issue a provider mutation');
      assert.equal(request.url, `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${packageName}/purchases/subscriptionsv2/tokens/subscription%2Ftoken`);
      if (providerError) throw providerError;
      return { data: structuredClone(current) };
    } },
  });
  const repository = {
    owner: async value => { calls.owner++; assert.equal(value, binding); return ownerAvailable ? { userId: 'saved-account' } : null; },
    read: async (store, environment, token) => { calls.read++; assert.deepEqual([store, environment, token], ['google', 'Sandbox', purchaseToken]); return saved; },
    apply: async status => {
      calls.apply.push(status); assert.equal(status.userId, 'saved-account'); assert.equal(status.expectedRevision, saved.revision);
      saved = { ...status, revision: saved.revision + 1 }; return 'applied';
    },
    claimEvent: async event => {
      calls.claim++;
      const previous = events.get(event.eventId);
      if (previous && previous.payloadHash !== event.payloadHash) throw Object.assign(Error('event identity conflict'), { code: 'INVALID_EVENT' });
      if (previous?.success) return 'duplicate';
      events.set(event.eventId, { ...event, success: false }); return 'claimed';
    },
    finishEvent: async event => { calls.finish.push(event); events.get(event.eventId).success = event.success; return true; },
  };
  const reconciler = createReconciler({ repository, providers: { google: provider, apple: {} }, environment: 'Sandbox' });
  const identity = { iss: 'https://accounts.google.com', email: 'push@test.invalid', email_verified: true };
  const parser = body => verifiedGoogleNotification({ authorization: 'Bearer signed-token', body, packageName,
    audience: 'https://android-test.invalid/api/native-purchases?action=google-events', serviceAccountEmail: 'push@test.invalid',
    oauthClient: { verifyIdToken: async options => {
      assert.equal(options.idToken, 'signed-token');
      assert.equal(options.audience, 'https://android-test.invalid/api/native-purchases?action=google-events');
      return { getPayload: () => identity };
    } },
  });
  const handler = verificationHandler({ authenticateCafe: async () => { assert.fail('event transport must use Pub/Sub identity'); },
    runtimeFor: async store => { assert.equal(store, 'google'); return { notification: (_authorization, body) => parser(body) }; },
    reconcilerFor: () => reconciler, logFailure: () => {},
  });
  async function send(notification, { eventId = 'event-id', appPackage = packageName } = {}) {
    const event = { version: '1.0', packageName: appPackage, eventTimeMillis: String(now), ...notification };
    const body = { message: { messageId: eventId, data: Buffer.from(JSON.stringify(event)).toString('base64') } };
    const res = { code: 200, headers: {}, setHeader(key, value) { this.headers[key] = value; }, status(code) { this.code = code; return this; }, json(value) { this.body = value; return this; } };
    await handler({ method: 'POST', query: { action: 'google-events' }, headers: { authorization: 'Bearer signed-token' }, body }, res);
    return res;
  }
  return { calls, events, identity, parser, reconciler, send, saved: () => saved,
    setCurrent: value => { current = value; }, setProviderError: value => { providerError = value; }, setOwnerAvailable: value => { ownerAvailable = value; } };
}

test('a voided earlier subscription order rechecks current Google state and retains active Pro', async () => {
  const f = fixture();
  assert.equal((await f.send({ voidedPurchaseNotification: voided() })).code, 200);
  assert.equal(f.calls.provider.length, 2, 'identify and current verification both query Google');
  assert.equal(f.calls.apply.length, 1);
  assert.equal(f.saved().access, 'pro');
  assert.equal(f.saved().transactionId, 'GPA.current-renewal', 'the voided historical order is not used as current transaction state');
  assert.equal(f.calls.finish[0].success, true);
});

test('a voided subscription whose authoritative state is expired removes Pro', async () => {
  const f = fixture();
  f.setCurrent({ ...active, subscriptionState: 'SUBSCRIPTION_STATE_EXPIRED' });
  assert.equal((await f.send({ voidedPurchaseNotification: voided() })).code, 200);
  assert.equal(f.saved().access, 'free'); assert.equal(f.saved().status, 'expired');
  assert.equal(f.calls.apply.length, 1);
});

test('duplicate subscription voids do not repeat provider reads or subscription updates', async () => {
  const f = fixture(), notification = { voidedPurchaseNotification: voided() };
  assert.equal((await f.send(notification)).code, 200);
  assert.equal((await f.send(notification)).code, 200);
  assert.equal(f.calls.provider.length, 2); assert.equal(f.calls.apply.length, 1); assert.equal(f.calls.finish.length, 1);
  assert.equal((await f.send({ voidedPurchaseNotification: voided({ orderId: 'GPA.changed-payload' }) })).code, 403);
  assert.equal(f.calls.apply.length, 1, 'event ID cannot be reused with another payload');
});

test('a Google outage leaves access unchanged and requests a retry of the same voided event', async () => {
  const f = fixture(), notification = { voidedPurchaseNotification: voided() };
  f.setProviderError(Error('offline provider'));
  assert.equal((await f.send(notification)).code, 503);
  assert.equal(f.saved().access, 'pro'); assert.equal(f.calls.apply.length, 0); assert.equal(f.calls.finish[0].success, false);
  f.setProviderError(null); f.setCurrent({ ...active, subscriptionState: 'SUBSCRIPTION_STATE_EXPIRED' });
  assert.equal((await f.send(notification)).code, 200); assert.equal(f.saved().access, 'free');
});

test('voided tokens still enforce the provider Sandbox marker and saved account ownership', async () => {
  const production = fixture(), response = structuredClone(active); delete response.testPurchase;
  production.setCurrent(response);
  assert.equal((await production.send({ voidedPurchaseNotification: voided() })).code, 403);
  assert.equal(production.calls.apply.length, 0);
  const unknownOwner = fixture(); unknownOwner.setOwnerAvailable(false);
  assert.equal((await unknownOwner.send({ voidedPurchaseNotification: voided() })).code, 403);
  assert.equal(unknownOwner.calls.apply.length, 0);
  const wrongProduct = fixture(); response.testPurchase = {}; response.lineItems[0].productId = 'other-product'; wrongProduct.setCurrent(response);
  assert.equal((await wrongProduct.send({ voidedPurchaseNotification: voided() })).code, 403);
  assert.equal(wrongProduct.calls.apply.length, 0);
});

for (const refundType of [1, 2]) test(`valid one-time void (${refundType}) is acknowledged and deduplicated without subscription access`, async () => {
  const f = fixture(), notification = { voidedPurchaseNotification: voided({ productType: 2, refundType }) };
  assert.equal((await f.send(notification)).code, 200); assert.equal((await f.send(notification)).code, 200);
  assert.equal(f.calls.provider.length, 0); assert.equal(f.calls.owner, 0); assert.equal(f.calls.read, 0); assert.equal(f.calls.apply.length, 0);
  assert.equal(f.saved().access, 'pro'); assert.equal(f.calls.finish.length, 1); assert.equal(f.calls.finish[0].success, true);
});

test('the ignored marker is strictly limited to Google one-time voids without a purchase proof or test bypass', async () => {
  const f = fixture(), input = { provider: 'google', eventId: 'ignored', payload: 'verified-event', ignored: ignoredReason };
  for (const mutation of [{ provider: 'apple' }, { ignored: true }, { ignored: 'future-event' }, { proof: purchaseToken }, { test: true }]) {
    await assert.rejects(f.reconciler.notification({ ...input, ...mutation }), { code: 'INVALID_EVENT' });
  }
  assert.equal(f.calls.claim, 0); assert.equal(f.calls.apply.length, 0);
});

for (const mutation of [
  { purchaseToken: '' }, { purchaseToken: ' ' }, { purchaseToken: 'x'.repeat(8193) },
  { orderId: undefined }, { orderId: '' }, { orderId: 'GPA. with space' }, { orderId: 'x'.repeat(256) },
  { productType: 0 }, { productType: 3 }, { productType: '1' }, { productType: undefined },
  { refundType: undefined }, { refundType: 0 }, { refundType: '1' }, { refundType: 2 },
]) test(`malformed or unsupported subscription void is rejected: ${JSON.stringify(mutation).slice(0, 100)}`, async () => {
  const f = fixture(); assert.equal((await f.send({ voidedPurchaseNotification: voided(mutation) })).code, 403);
  assert.equal(f.calls.claim, 0); assert.equal(f.calls.apply.length, 0);
});

for (const extra of [
  { testNotification: { version: '1.0' } }, { subscriptionNotification: { purchaseToken } },
  { pendingRefundReviewNotification: { pendingRefundToken: 'review-token' } },
  { oneTimeProductNotification: { purchaseToken, sku: 'one-time', notificationType: 1 } },
  { futureNotification: {} }, { subscriptionNotification: null },
]) test(`mixed voided event cannot hide another payload: ${Object.keys(extra)[0]}`, async () => {
  const f = fixture(); assert.equal((await f.send({ voidedPurchaseNotification: voided({ productType: 2 }), ...extra })).code, 403);
  assert.equal(f.calls.claim, 0); assert.equal(f.calls.apply.length, 0);
});

test('wrong package and unverified Pub/Sub identities cannot acknowledge even an ignored one-time void', async () => {
  const wrongPackage = fixture();
  assert.equal((await wrongPackage.send({ voidedPurchaseNotification: voided({ productType: 2 }) }, { appPackage: 'another.app' })).code, 403);
  assert.equal(wrongPackage.calls.claim, 0);
  for (const mutation of [{ email: 'other@test.invalid' }, { email_verified: false }, { iss: 'https://attacker.invalid' }]) {
    const f = fixture(); Object.assign(f.identity, mutation);
    assert.equal((await f.send({ voidedPurchaseNotification: voided({ productType: 2 }) })).code, 403);
    assert.equal(f.calls.claim, 0); assert.equal(f.calls.apply.length, 0);
  }
});

test('subscription revocation and Play Console test messages retain the existing paths', async () => {
  const revoked = fixture(); revoked.setCurrent({ ...active, subscriptionState: 'SUBSCRIPTION_STATE_EXPIRED' });
  assert.equal((await revoked.send({ subscriptionNotification: { notificationType: 12, purchaseToken } })).code, 200);
  assert.equal(revoked.saved().access, 'free');
  const ping = fixture(); assert.equal((await ping.send({ testNotification: { version: '1.0' } })).code, 200);
  assert.equal(ping.calls.provider.length, 0); assert.equal(ping.calls.apply.length, 0);
});

test('unknown and pending-refund-review events remain an explicit unsupported public-release limitation', async () => {
  for (const notification of [{}, { futureNotification: {} }, { voidedPurchaseNotification: null },
    { pendingRefundReviewNotification: { pendingRefundToken: 'review-token', orderId: 'GPA.order', refundReason: 7 } }]) {
    const f = fixture(); assert.equal((await f.send(notification)).code, 403); assert.equal(f.calls.claim, 0); assert.equal(f.calls.apply.length, 0);
  }
});
