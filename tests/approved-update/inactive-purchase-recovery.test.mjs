import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTypescript, plain } from './load-typescript.mjs';
const timeout = loadTypescript('mobile/features/native-subscription/storeTimeout.ts');
const { ExpoStoreGateway } = loadTypescript('mobile/features/native-subscription/expoStoreGateway.ts', { './storeTimeout': timeout });
const { nativePurchaseDependencies } = loadTypescript('mobile/features/native-subscription/nativeBillingClient.ts');
const plan = { id: 'synthetic.monthly', provider: 'apple', storefront: 'US', prices: { USD: 9.99 } };
const binding = '11111111-1111-4111-8111-111111111111';
const account = { id: binding, role: 'cafe_owner_manager' };
const product = { id: plan.id, platform: 'ios', type: 'subs', currency: 'USD', price: 9.99, displayPrice: '$9.99', subscriptionPeriodNumberIOS: '1', subscriptionPeriodUnitIOS: 'month' };
const purchase = { id: 'new-synthetic-transaction', productId: plan.id, store: 'apple', purchaseState: 'purchased', purchaseToken: 'synthetic-proof', appAccountToken: binding };
const inactive = () => Object.assign(new Error('Finished an inactive subscription transaction. Please retry the purchase.'), { code: 'purchase-error', productId: plan.id });
const flush = async () => { for (let n = 0; n < 40; n++) await Promise.resolve(); };
function harness(request, waitMs = 1000) {
  const requests = [], callbacks = [], finished = []; let country = 'USA';
  const api = {
    initConnection: async () => true, endConnection: async () => {}, getStorefront: async () => country,
    purchaseUpdatedListener: () => ({ remove() {} }), purchaseErrorListener: () => ({ remove() {} }),
    fetchProducts: async () => [product],
    requestPurchase: async input => { requests.push(plain(input)); return request(requests.length); },
    restorePurchases: async () => {}, getAvailablePurchases: async () => [],
    finishTransaction: async input => { finished.push(input); },
  };
  const store = new ExpoStoreGateway(api, plan, value => callbacks.push(value), waitMs);
  return { store, requests, callbacks, finished, setCountry: value => { country = value; } };
}
test('an inactive StoreKit replay permits one new confirmation with the same account and reservation', async () => {
  const h = harness(async count => { if (count === 1) throw inactive(); return purchase; });
  const calls = [], selected = await h.store.product();
  const deps = nativePurchaseDependencies({ account: async () => account, store: h.store, call: async (path, body) => {
    calls.push({ path, body });
    if (path.endsWith('prepare')) return { attemptId: binding, accountBinding: binding };
    if (path.endsWith('start')) return { started: true };
    throw new Error('No verification or cancellation before a store result');
  } });
  await deps.preflight(binding, selected);
  const result = await deps.purchase(selected, binding);
  assert.equal(result.kind, 'purchased');
  assert.equal(h.requests.length, 2);
  assert.deepEqual(h.requests[0], h.requests[1]);
  assert.equal(calls.filter(call => call.path.endsWith('prepare')).length, 1);
  assert.equal(calls.filter(call => call.path.endsWith('start')).length, 1);
  assert.equal(h.finished.length, 0, 'new access still requires server verification before finishing');
  await h.store.dispose();
});
test('inactive cleanup is retried at most once, even if the store repeats it', async () => {
  const h = harness(async () => { throw inactive(); }); const selected = await h.store.product();
  assert.equal((await h.store.buy(selected, binding)).kind, 'pending');
  assert.equal(h.requests.length, 2);
  assert.equal((await h.store.buy(selected, binding)).kind, 'pending');
  assert.equal(h.requests.length, 2); await h.store.dispose();
});
test('canceling the actual confirmation after cleanup releases the original reservation once', async () => {
  const h = harness(async count => { throw count === 1 ? inactive() : { code: 'user-cancelled' }; });
  const selected = await h.store.product(), calls = [];
  const deps = nativePurchaseDependencies({ account: async () => account, store: h.store, call: async (path, body) => {
    calls.push({ path, body });
    if (path.endsWith('prepare')) return { attemptId: binding, accountBinding: binding };
    if (path.endsWith('start')) return { started: true };
    if (path.endsWith('cancel')) return { cancelled: true };
    throw new Error('Unexpected request');
  } });
  await deps.preflight(binding, selected);
  assert.equal((await deps.purchase(selected, binding)).kind, 'cancelled');
  assert.equal(h.requests.length, 2);
  assert.equal(calls.filter(call => call.path.endsWith('cancel')).length, 1);
  assert.equal(calls.at(-1).body.reason, 'user-cancelled'); await h.store.dispose();
});
for (const error of [
  { code: 'network-error', message: inactive().message, productId: plan.id },
  { code: 'deferred-payment', message: inactive().message, productId: plan.id },
  { code: 'purchase-error', message: 'Unknown payment failure', productId: plan.id },
  { code: 'purchase-error', message: inactive().message, productId: 'other.product' },
]) {
  test(`unconfirmed failure remains blocked without another request: ${error.code}/${error.productId}/${error.message}`, async () => {
    const h = harness(async () => { throw error; }); const selected = await h.store.product();
    assert.equal((await h.store.buy(selected, binding)).kind, 'pending');
    assert.equal(h.requests.length, 1); await h.store.dispose();
  });
}
test('leaving the screen during cleanup never opens a later confirmation', async () => {
  let reject; const h = harness(() => new Promise((_, fail) => { reject = fail; }));
  const selected = await h.store.product(), pending = h.store.buy(selected, binding); await flush();
  await h.store.dispose(); reject(inactive()); await flush();
  assert.equal((await pending).kind, 'pending'); assert.equal(h.requests.length, 1);
});
test('the existing timeout also limits inactive-transaction recovery', async () => {
  let reject; const h = harness(() => new Promise((_, fail) => { reject = fail; }), 5);
  const selected = await h.store.product(); assert.equal((await h.store.buy(selected, binding)).kind, 'pending');
  reject(inactive()); await flush(); assert.equal(h.requests.length, 1); await h.store.dispose();
});
test('a changed storefront prevents the second request', async () => {
  const h = harness(async () => { h.setCountry('CAN'); throw inactive(); });
  const selected = await h.store.product(); assert.equal((await h.store.buy(selected, binding)).kind, 'pending');
  assert.equal(h.requests.length, 1); await h.store.dispose();
});
test('repeated taps during cleanup cannot open another purchase', async () => {
  let reject; const h = harness(count => count === 1 ? new Promise((_, fail) => { reject = fail; }) : purchase);
  const selected = await h.store.product(), first = h.store.buy(selected, binding); await flush();
  assert.equal((await h.store.buy(selected, binding)).kind, 'pending');
  reject(inactive()); assert.equal((await first).kind, 'purchased');
  assert.equal(h.requests.length, 2); await h.store.dispose();
});
