import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTypescript } from './load-typescript.mjs';
const timeout = loadTypescript('mobile/features/native-subscription/storeTimeout.ts');
const { ExpoStoreGateway } = loadTypescript('mobile/features/native-subscription/expoStoreGateway.ts', { './storeTimeout': timeout });
const { SubscriptionController } = loadTypescript('mobile/features/native-subscription/subscriptionController.ts', {
  './purchaseCoordinator': loadTypescript('mobile/features/native-subscription/purchaseCoordinator.ts'),
  './nativeBillingClient': loadTypescript('mobile/features/native-subscription/nativeBillingClient.ts'),
});
const free = { accountId: 'test-cafe', verified: true, access: 'free', provider: null, status: 'free', canManage: false, canPurchase: true, currentPeriodEnd: null, autoRenews: false };
const paid = { ...free, access: 'pro', provider: 'apple', status: 'active', canManage: true, canPurchase: false, autoRenews: true };
const flush = async () => { for (let n = 0; n < 100; n++) await Promise.resolve(); };
function harness(delayed = false) {
  let release, current = free, state, verifyCalls = 0, finishCalls = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const plan = { id: 'synthetic.monthly', provider: 'apple', storefront: 'US', prices: { USD: 9.99 } };
  const api = {
    initConnection: async () => true, endConnection: async () => {}, getStorefront: async () => 'USA',
    purchaseUpdatedListener: () => ({ remove() {} }), purchaseErrorListener: () => ({ remove() {} }),
    fetchProducts: async () => [{ id: plan.id, platform: 'ios', type: 'subs', currency: 'USD', price: 9.99, displayPrice: '$9.99', subscriptionPeriodNumberIOS: '1', subscriptionPeriodUnitIOS: 'month' }],
    restorePurchases: async () => { if (delayed) await gate; },
    getAvailablePurchases: async () => [{ id: 'synthetic-restore', productId: plan.id, store: 'apple', purchaseState: 'purchased', purchaseToken: 'test-proof' }],
    finishTransaction: async () => { finishCalls++; },
  };
  const store = new ExpoStoreGateway(api, plan, purchase => { void controller.recover(purchase); }, 100, 5);
  const controller = new SubscriptionController({
    accountId: free.accountId, account: async () => ({ id: free.accountId, role: 'cafe_owner_manager' }), store,
    changed: value => { state = value; }, accountChanged: () => { throw Error('Unexpected account change'); }, openManagement: async () => {},
    call: async (path, body, method, accountId) => {
      assert.equal(accountId, free.accountId);
      if (path.endsWith('status')) return current;
      assert.equal(path, '/native-purchases'); assert.equal(body.proof, 'test-proof');
      verifyCalls++; current = paid;
      return { accountId, verified: true, purchase: { provider: 'apple', status: 'active' } };
    },
  });
  return { controller, release, state: () => state, counts: () => ({ verifyCalls, finishCalls }) };
}
test('normal restore plus recovery callback verifies and finishes only once', async () => {
  const h = harness(); await h.controller.load(); await h.controller.restore(); await flush();
  assert.deepEqual(h.counts(), { verifyCalls: 1, finishCalls: 1 });
  assert.equal(h.state().subscription.access, 'pro'); assert.equal(h.state().notice, 'Your Pro access is confirmed.');
  h.controller.dispose();
});
test('finishing sign-in after the UI timeout automatically confirms restoration without another tap', async () => {
  const h = harness(true); await h.controller.load(); await h.controller.restore();
  assert.equal(h.state().subscription.access, 'free'); assert.equal(h.state().busy, false);
  h.release(); await flush();
  assert.deepEqual(h.counts(), { verifyCalls: 1, finishCalls: 1 });
  assert.equal(h.state().subscription.access, 'pro'); assert.equal(h.state().notice, 'Your Pro access is confirmed.');
  h.controller.dispose();
});
test('a disposed account controller cannot receive a late restored purchase', async () => {
  const h = harness(true); await h.controller.load(); await h.controller.restore();
  h.controller.dispose(); h.release(); await flush();
  assert.deepEqual(h.counts(), { verifyCalls: 0, finishCalls: 0 });
});
