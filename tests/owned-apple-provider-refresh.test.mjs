import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { appleProvider } from '../server/native-billing/providers.mjs';
import { createProviderRuntime } from '../server/native-billing/runtime.mjs';

const now = Date.parse('2026-11-04T13:15:00Z');
const originalId = 'synthetic-original';
const binding = '00000000-0000-4000-8000-000000000010';
const expected = { bundleId: 'com.baristajobmatch.app', productId: 'com.baristajobmatch.cafe.pro.monthly', environment: 'Sandbox' };
const transaction = { ...expected, originalTransactionId: originalId, transactionId: 'synthetic-transaction',
  appAccountToken: binding, type: 'Auto-Renewable Subscription', inAppOwnershipType: 'PURCHASED', expiresDate: now - 60_000 };
const renewal = { originalTransactionId: originalId, productId: expected.productId, environment: 'Sandbox', autoRenewStatus: 0 };
const response = () => ({ bundleId: expected.bundleId, environment: expected.environment,
  data: [{ subscriptionGroupIdentifier: 'synthetic-group', lastTransactions: [{ originalTransactionId: originalId,
    signedTransactionInfo: 'signed-transaction', signedRenewalInfo: 'signed-renewal', status: 2 }] }] });
const copy = value => structuredClone(value);

function fixture({ tx = transaction, renew = renewal, current = response(), read, verifyTransaction, verifyRenewal } = {}) {
  const calls = { reads: 0, transaction: [], renewal: [], ids: [] };
  const provider = appleProvider({ ...expected, now: () => now,
    client: { async getAllSubscriptionStatuses(id) {
      calls.reads++; calls.ids.push(id);
      return read ? read(id) : copy(current);
    } },
    verifier: {
      async verifyAndDecodeTransaction(proof) { calls.transaction.push(proof); return verifyTransaction ? verifyTransaction(proof) : copy(tx); },
      async verifyAndDecodeRenewalInfo(proof) { calls.renewal.push(proof); return verifyRenewal ? verifyRenewal(proof) : copy(renew); },
    },
  });
  return { provider, calls };
}

test('recorded-chain verification uses one current read and both signed values without a client receipt', async () => {
  const { provider, calls } = fixture();
  const status = await provider.verifyExisting(originalId, binding);
  assert.equal(status.status, 'expired'); assert.equal(status.access, 'free'); assert.equal(status.autoRenews, false);
  assert.equal(status.binding, binding); assert.equal(status.providerSubscriptionId, originalId);
  assert.equal(status.currentPeriodEnd, new Date(transaction.expiresDate).toISOString());
  assert.deepEqual(calls, { reads: 1, transaction: ['signed-transaction'], renewal: ['signed-renewal'], ids: [originalId] });
});

test('a signed explicit renewal ON value stays ON, including an expired period', async () => {
  const { provider, calls } = fixture({ renew: { ...renewal, autoRenewStatus: 1 } });
  const status = await provider.verifyExisting(originalId, binding);
  assert.equal(status.autoRenews, true); assert.equal(status.access, 'free'); assert.equal(calls.reads, 1);
});

test('active state comes only from a future verified transaction period', async () => {
  const current = response(); current.data[0].lastTransactions[0].status = 1;
  const { provider } = fixture({ current, tx: { ...transaction, expiresDate: now + 60_000 }, renew: { ...renewal, autoRenewStatus: 1 } });
  const status = await provider.verifyExisting(originalId, binding);
  assert.equal(status.status, 'active'); assert.equal(status.access, 'pro');
});

for (const status of [1, 2, 3, 4, 5]) test(`recorded status ${status} rejects missing signed renewal instead of inferring OFF`, async () => {
  const current = response(); Object.assign(current.data[0].lastTransactions[0], { status, signedRenewalInfo: undefined });
  const { provider, calls } = fixture({ current });
  await assert.rejects(provider.verifyExisting(originalId, binding), { code: 'RENEWAL_UNAVAILABLE' });
  assert.equal(calls.reads, 1); assert.equal(calls.renewal.length, 0);
});

for (const value of [undefined, null, false, true, '0', '1', 2, -1]) test(`unknown renewal value ${String(value)} cannot prove signed renewal OFF`, async () => {
  const { provider, calls } = fixture({ renew: { ...renewal, autoRenewStatus: value } });
  await assert.rejects(provider.verifyExisting(originalId, binding), { code: 'INVALID_RENEWAL' });
  assert.equal(calls.reads, 1);
});

for (const mutation of [{ originalTransactionId: 'foreign-chain' }, { productId: 'foreign-product' },
  { environment: 'Production' }, { autoRenewProductId: 'foreign-product' }, { appAccountToken: 'foreign-binding' }]) {
  test(`signed renewal mismatch rejects ${Object.keys(mutation)[0]}`, async () => {
    const { provider } = fixture({ renew: { ...renewal, ...mutation } });
    await assert.rejects(provider.verifyExisting(originalId, binding));
  });
}

for (const mutation of [{ originalTransactionId: 'foreign-chain' }, { bundleId: 'foreign-app' }, { productId: 'foreign-product' },
  { environment: 'Production' }, { appAccountToken: 'foreign-binding' }, { inAppOwnershipType: 'FAMILY_SHARED' },
  { type: 'Non-Consumable' }, { isUpgraded: true }, { expiresDate: null }]) {
  test(`signed transaction mismatch rejects ${Object.keys(mutation)[0]}`, async () => {
    const { provider } = fixture({ tx: { ...transaction, ...mutation } });
    await assert.rejects(provider.verifyExisting(originalId, binding));
  });
}

test('forged transaction or renewal proof is rejected with no additional current-state read', async () => {
  for (const slot of ['verifyTransaction', 'verifyRenewal']) {
    const { provider, calls } = fixture({ [slot]: async () => { throw new Error('synthetic signature rejection'); } });
    await assert.rejects(provider.verifyExisting(originalId, binding)); assert.equal(calls.reads, 1);
  }
});

test('missing signed transaction cannot be replaced by a signed renewal alone', async () => {
  const current = response(); delete current.data[0].lastTransactions[0].signedTransactionInfo;
  const { provider, calls } = fixture({ current });
  await assert.rejects(provider.verifyExisting(originalId, binding), { code: 'INVALID_TRANSACTION' });
  assert.equal(calls.reads, 1); assert.equal(calls.transaction.length, 0);
});

test('wrong environment, missing or duplicate matching chains fail closed', async () => {
  const variants = [null, { ...response(), environment: 'Production' }, { ...response(), bundleId: 'foreign-app' },
    { ...response(), data: [] }, { ...response(), data: [{ lastTransactions: [] }] }];
  const duplicate = response(); duplicate.data[0].lastTransactions.push(copy(duplicate.data[0].lastTransactions[0])); variants.push(duplicate);
  for (const current of variants) await assert.rejects(fixture({ current }).provider.verifyExisting(originalId, binding));
});

test('invalid recorded input stops before any Apple read', async () => {
  const { provider, calls } = fixture();
  for (const [id, token] of [['', binding], [originalId, ''], [null, binding], [originalId, null], ['x'.repeat(256), binding]]) {
    await assert.rejects(provider.verifyExisting(id, token), { code: 'INVALID_TRANSACTION' });
  }
  assert.equal(calls.reads, 0);
});

test('a transient Apple failure is not automatically retried by verifyExisting', async () => {
  class APIException extends Error { constructor() { super('synthetic outage'); this.httpStatusCode = 503; } }
  const { provider, calls } = fixture({ read: async () => { throw new APIException(); } });
  await assert.rejects(provider.verifyExisting(originalId, binding)); assert.equal(calls.reads, 1);
});

test('legacy receipt verification still allows its expired renewal-absent normalization', async () => {
  const current = response(); delete current.data[0].lastTransactions[0].signedRenewalInfo;
  const { provider, calls } = fixture({ current });
  const status = await provider.verify('historical-client-receipt', binding);
  assert.equal(status.status, 'expired'); assert.equal(status.autoRenews, false);
  assert.equal(calls.reads, 1); assert.deepEqual(calls.transaction, ['historical-client-receipt', 'signed-transaction']);
});

test('external abort before a read or during signature verification never returns a late verified result', async () => {
  const already = new AbortController(); already.abort();
  const first = fixture(); await assert.rejects(first.provider.verifyExisting(originalId, binding, { signal: already.signal }), { code: 'REQUEST_ABORTED' });
  assert.equal(first.calls.reads, 0);
  const controller = new AbortController(); let complete;
  const gate = new Promise(resolve => { complete = resolve; });
  const second = fixture({ verifyTransaction: () => gate });
  const result = second.provider.verifyExisting(originalId, binding, { signal: controller.signal });
  await new Promise(resolve => setImmediate(resolve)); controller.abort(); complete(copy(transaction));
  await assert.rejects(result, { code: 'REQUEST_ABORTED' }); assert.equal(second.calls.renewal.length, 0);
});

test('abort during renewal verification also fences the eventual verified result', async () => {
  const controller = new AbortController(); let complete;
  const gate = new Promise(resolve => { complete = resolve; });
  const { provider, calls } = fixture({ verifyRenewal: () => gate });
  const result = provider.verifyExisting(originalId, binding, { signal: controller.signal });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(calls.renewal.length, 1);
  controller.abort(); complete(copy(renewal));
  await assert.rejects(result, { code: 'REQUEST_ABORTED' });
});

const sdkRequire = createRequire(process.env.NATIVE_BILLING_SDK_ROOT
  ? resolve(process.env.NATIVE_BILLING_SDK_ROOT, 'package.json') : new URL('../package.json', import.meta.url));
const apple = sdkRequire('@apple/app-store-server-library');
const ephemeralKey = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ format: 'pem', type: 'pkcs8' });
const runtimeConfig = { provider: 'apple', ...expected, appAppleId: 6807117736,
  privateKey: ephemeralKey, keyId: 'TESTKEY123', issuerId: '00000000-0000-4000-8000-000000000099' };
const abortError = () => Object.assign(new Error('synthetic aborted transport'), { name: 'AbortError' });
class FixtureVerifier {
  constructor(roots, online, env, bundleId) { assert.equal(roots.length, 3); assert.equal(online, true); assert.equal(env, 'Sandbox'); assert.equal(bundleId, expected.bundleId); }
  async verifyAndDecodeTransaction() { return copy(transaction); }
  async verifyAndDecodeRenewalInfo() { return copy(renewal); }
}
function runtime(options = {}) { return createProviderRuntime(runtimeConfig, { loadApple: async () => ({ ...apple, SignedDataVerifier: FixtureVerifier }), ...options }); }

test('actual pinned SDK subclass makes one bounded GET and retains SDK response validation and online verifier configuration', async () => {
  const requests = [];
  const service = await runtime({ appleExistingStatusFetch: async (url, options) => {
    requests.push({ url, method: options.method, signal: options.signal, redirect: options.redirect });
    assert.equal(typeof options.headers.Authorization, 'string'); assert.ok(options.headers.Authorization.startsWith('Bearer '));
    return { ok: true, json: async () => response() };
  } });
  assert.equal((await service.provider.verifyExisting(originalId, binding)).status, 'expired');
  assert.equal(requests.length, 1); assert.equal(requests[0].url, `https://api.storekit-sandbox.apple.com/inApps/v1/subscriptions/${originalId}`);
  assert.equal(requests[0].method, 'GET'); assert.equal(requests[0].redirect, 'error'); assert.ok(requests[0].signal instanceof AbortSignal);
  const invalid = await runtime({ appleExistingStatusFetch: async () => ({ ok: true, json: async () => ({ data: 'not-an-array' }) }) });
  await assert.rejects(invalid.provider.verifyExisting(originalId, binding));
});

test('default bounded transport resolves the pinned SDK own fetch dependency without a live request', async () => {
  const fromSdk = createRequire(sdkRequire.resolve('@apple/app-store-server-library'));
  const fetchPath = fromSdk.resolve('node-fetch');
  const entry = fromSdk.cache[fetchPath]; assert.ok(entry);
  const original = entry.exports; let reads = 0;
  entry.exports = async (url, options) => {
    reads++; assert.equal(url, `https://api.storekit-sandbox.apple.com/inApps/v1/subscriptions/${originalId}`);
    assert.ok(options.signal instanceof AbortSignal);
    return { ok: true, json: async () => response() };
  };
  try {
    const service = await runtime();
    assert.equal((await service.provider.verifyExisting(originalId, binding)).status, 'expired');
    assert.equal(reads, 1);
  } finally { entry.exports = original; }
});

for (const phase of ['headers', 'body']) test(`owned API timeout aborts while awaiting ${phase}, with no retry`, async () => {
  let calls = 0, aborted = false;
  const service = await runtime({ appleExistingStatusTimeoutMs: 10, appleExistingStatusFetch: async (_url, { signal }) => {
    calls++;
    const wait = () => new Promise((_resolve, reject) => signal.addEventListener('abort', () => { aborted = true; reject(abortError()); }, { once: true }));
    return phase === 'headers' ? wait() : { ok: true, json: wait };
  } });
  await assert.rejects(service.provider.verifyExisting(originalId, binding)); assert.equal(calls, 1); assert.equal(aborted, true);
});

test('foreground AbortSignal wins over the longer standalone transport cap', async () => {
  const controller = new AbortController(); let calls = 0;
  const service = await runtime({ appleExistingStatusTimeoutMs: 1000, appleExistingStatusFetch: async (_url, { signal }) => {
    calls++; return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(abortError()), { once: true }));
  } });
  const result = service.provider.verifyExisting(originalId, binding, { signal: controller.signal });
  setImmediate(() => controller.abort()); await assert.rejects(result); assert.equal(calls, 1);
});

test('SDK transport extension leaves the legacy client path untouched', async () => {
  let legacyReads = 0, boundedReads = 0;
  class OfflineLegacyClient extends apple.AppStoreServerAPIClient {
    async makeFetchRequest() { legacyReads++; return { ok: true, json: async () => response() }; }
  }
  const service = await runtime({ loadApple: async () => ({ ...apple, AppStoreServerAPIClient: OfflineLegacyClient, SignedDataVerifier: FixtureVerifier }),
    appleExistingStatusFetch: async () => { boundedReads++; return { ok: true, json: async () => response() }; } });
  await service.provider.verify('legacy-receipt', binding); assert.equal(legacyReads, 1); assert.equal(boundedReads, 0);
  await service.provider.verifyExisting(originalId, binding); assert.equal(legacyReads, 1); assert.equal(boundedReads, 1);
});
