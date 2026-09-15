import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTypescript } from './load-typescript.mjs';
const { ExpoStoreGateway } = loadTypescript('mobile/features/native-subscription/expoStoreGateway.ts', {
  './storeTimeout': loadTypescript('mobile/features/native-subscription/storeTimeout.ts'),
});
const lower = 'abcdefab-cdef-4abc-8def-abcdefabcdef';
const upper = lower.toUpperCase();
const flush = async () => { for (let n = 0; n < 40; n++) await Promise.resolve(); };
function harness(provider = 'apple', returned) {
  let emit; const recovered = [], requests = [], finished = [];
  const plan = { id: 'synthetic.monthly', provider, storefront: 'US', prices: { USD: 9.99 }, ...(provider === 'google' ? { basePlanId: 'monthly' } : {}) };
  const row = { id: plan.id, platform: provider === 'apple' ? 'ios' : 'android', type: 'subs', currency: 'USD', price: 9.99, displayPrice: '$9.99', subscriptionPeriodNumberIOS: '1', subscriptionPeriodUnitIOS: 'month', subscriptionOffers: [{ basePlanIdAndroid: 'monthly', offerTokenAndroid: 'synthetic-offer', pricingPhasesAndroid: { pricingPhaseList: [{ billingPeriod: 'P1M', recurrenceMode: 1, formattedPrice: '$9.99', priceAmountMicros: '9990000', priceCurrencyCode: 'USD' }] } }] };
  const transaction = token => ({ id: 'synthetic-transaction', productId: plan.id, store: provider, purchaseState: 'purchased', purchaseToken: 'synthetic-proof', ...(provider === 'apple' ? { appAccountToken: token } : { obfuscatedAccountIdAndroid: token }) });
  const api = {
    initConnection: async () => true, endConnection: async () => {}, getStorefront: async () => provider === 'apple' ? 'USA' : 'US',
    purchaseUpdatedListener: fn => { emit = fn; return { remove() {} }; }, purchaseErrorListener: () => ({ remove() {} }),
    fetchProducts: async () => [row], requestPurchase: async input => { requests.push(input); return returned ? transaction(returned) : undefined; },
    finishTransaction: async input => finished.push(input), restorePurchases: async () => {}, getAvailablePurchases: async () => [],
  };
  const store = new ExpoStoreGateway(api, plan, p => recovered.push(p), 30);
  return { store, recovered, requests, finished, emit: token => emit(transaction(token)) };
}
for (const [requested, delivered] of [[lower, upper], [upper, lower], [lower, 'AbCdEfAb-CdEf-4AbC-8DeF-AbCdEfAbCdEf']]) {
  test(`Apple UUID letter case does not send this checkout to background recovery: ${delivered}`, async () => {
    const h = harness(); try {
      const selected = await h.store.product(), pending = h.store.buy(selected, requested); await flush();
      h.emit(delivered); const result = await pending;
      assert.equal(result.kind, 'purchased'); assert.equal(h.recovered.length, 0);
      assert.equal(h.requests.length, 1); assert.equal(h.finished.length, 0, 'server verification still precedes finishing');
    } finally { await h.store.dispose(); }
  });
}
test('a returned Apple transaction with the same uppercase UUID resolves without the timeout', async () => {
  const h = harness('apple', upper); try {
    assert.equal((await h.store.buy(await h.store.product(), lower)).kind, 'purchased');
    assert.equal(h.recovered.length, 0); assert.equal(h.requests.length, 1); assert.equal(h.finished.length, 0);
  } finally { await h.store.dispose(); }
});
test('a genuinely different Apple UUID cannot satisfy the open checkout', async () => {
  const h = harness(); try {
    const pending = h.store.buy(await h.store.product(), lower); await flush();
    h.emit('BBCDEFAB-CDEF-4ABC-8DEF-ABCDEFABCDEF');
    assert.equal((await pending).kind, 'pending'); assert.equal(h.recovered.length, 1); assert.equal(h.finished.length, 0);
  } finally { await h.store.dispose(); }
});
test('Google account IDs retain case-sensitive comparison', async () => {
  const h = harness('google'); try {
    const pending = h.store.buy(await h.store.product(), 'TestAccount'); await flush(); h.emit('testaccount');
    assert.equal((await pending).kind, 'pending'); assert.equal(h.recovered.length, 1); assert.equal(h.finished.length, 0);
  } finally { await h.store.dispose(); }
});
test('exact Google account ID still satisfies the open checkout', async () => {
  const h = harness('google'); try {
    const pending = h.store.buy(await h.store.product(), 'TestAccount'); await flush(); h.emit('TestAccount');
    assert.equal((await pending).kind, 'purchased'); assert.equal(h.recovered.length, 0); assert.equal(h.finished.length, 0);
  } finally { await h.store.dispose(); }
});
