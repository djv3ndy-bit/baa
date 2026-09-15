import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTypescript } from './load-typescript.mjs';
const timeout = loadTypescript('mobile/features/native-subscription/storeTimeout.ts');
const { ExpoStoreGateway } = loadTypescript('mobile/features/native-subscription/expoStoreGateway.ts', {
  './storeTimeout': { storeResponse: (request, ms = 5) => timeout.storeResponse(request, Math.min(ms, 5)) },
});
const plan = { id: 'test.monthly', provider: 'apple', storefront: 'US', prices: { USD: 9.99 } };
const product = { id: plan.id, platform: 'ios', type: 'subs', currency: 'USD', price: 9.99, displayPrice: '$9.99', subscriptionPeriodNumberIOS: '1', subscriptionPeriodUnitIOS: 'month' };
const purchase = { id: 'restore-test', productId: plan.id, store: 'apple', purchaseState: 'purchased', purchaseToken: 'synthetic-signed-proof' };
const flush = async () => { for (let n = 0; n < 20; n++) await Promise.resolve(); };
function harness() {
  let release, calls = 0, reads = 0;
  const recovered = [];
  const gate = new Promise(resolve => { release = resolve; });
  const api = {
    initConnection: async () => true, endConnection: async () => {}, getStorefront: async () => 'USA',
    purchaseUpdatedListener: () => ({ remove() {} }), purchaseErrorListener: () => ({ remove() {} }),
    fetchProducts: async () => [product], requestPurchase: async () => { throw Error('must not start checkout during restore'); },
    restorePurchases: async () => { calls++; await gate; },
    getAvailablePurchases: async () => { reads++; return [purchase]; },
  };
  const gateway = new ExpoStoreGateway(api, plan, p => recovered.push(p), 100, 5);
  return { gateway, recovered, release, calls: () => calls, reads: () => reads };
}
test('a restore completed after its UI timeout still reaches secure recovery', async () => {
  const h = harness();
  await assert.rejects(h.gateway.restore(), /store did not respond/);
  assert.equal(h.recovered.length, 0);
  h.release(); await flush();
  assert.equal(h.recovered.length, 1); assert.equal(h.recovered[0].proof, purchase.purchaseToken);
  assert.equal(h.calls(), 1); await h.gateway.dispose();
});
test('repeated restore taps share the pending Apple sign-in and block another checkout', async () => {
  const h = harness(); const p = await h.gateway.product();
  await assert.rejects(h.gateway.restore(), /store did not respond/);
  assert.equal((await h.gateway.buy(p, '11111111-1111-4111-8111-111111111111')).kind, 'pending');
  const retry = h.gateway.restore(); await flush();
  h.release();
  assert.equal((await retry).length, 1); assert.equal(h.calls(), 1); assert.equal(h.reads(), 1);
  await h.gateway.dispose();
});
test('finishing Apple sign-in after account-screen disposal cannot recover into a new account', async () => {
  const h = harness();
  await assert.rejects(h.gateway.restore(), /store did not respond/);
  await h.gateway.dispose(); h.release(); await flush();
  assert.equal(h.recovered.length, 0); assert.equal(h.reads(), 0);
});
