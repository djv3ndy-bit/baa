import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTypescript } from './load-typescript.mjs';
const coordinator = loadTypescript('mobile/features/native-subscription/purchaseCoordinator.ts');
const client = loadTypescript('mobile/features/native-subscription/nativeBillingClient.ts');
const { SubscriptionController } = loadTypescript('mobile/features/native-subscription/subscriptionController.ts', {
  './purchaseCoordinator': coordinator, './nativeBillingClient': client,
});
const receipt = { id: 'fixture-tx', provider: 'apple', productId: 'fixture.monthly', proof: 'synthetic-not-a-receipt' };
const stripe = { accountId: 'website-cafe', verified: true, access: 'pro', provider: 'stripe', status: 'active', canPurchase: false, canManage: true, autoRenews: true, currentPeriodEnd: '2026-10-13T01:53:10Z' };
function setup({ failure = 'account', provider = 'stripe', storeFailure = false, switchAccount = false } = {}) {
  const calls = [];
  let state, account = { id: stripe.accountId, role: 'cafe_owner_manager' };
  const c = new SubscriptionController({
    accountId: stripe.accountId, account: async () => account,
    call: async path => {
      calls.push(path);
      if (path.endsWith('status')) return { ...stripe, provider };
      if (path === '/native-purchases') {
        if (switchAccount) account = { id: 'different-cafe', role: 'cafe_owner_manager' };
        if (failure) throw new Error(failure === 'account' ? 'This purchase could not be confirmed for this account.' : 'Network unavailable');
        return { accountId: stripe.accountId, verified: true, purchase: { provider: 'apple', status: 'expired' } };
      }
      throw Error('Unexpected payment mutation');
    },
    store: {
      connect: async () => {}, dispose: async () => {}, manage: async () => {},
      country: async () => 'USA', product: async () => { throw Error('Existing subscriber must not load a checkout'); },
      buy: async () => { calls.push('buy'); throw Error('Must not buy'); },
      restore: async () => { calls.push('restore'); if (storeFailure) throw Error('Store sign-in timeout'); return [receipt]; },
      finish: async () => { calls.push('finish'); },
    },
    openManagement: async provider => calls.push(`manage-${provider}`),
    changed: next => { state = next; }, accountChanged: () => calls.push('account-changed'),
  });
  return { c, calls, state: () => state };
}
function preserved(h) {
  assert.deepEqual(JSON.parse(JSON.stringify(h.state().subscription)), stripe);
  assert.equal(h.state().busy, false);
  assert.ok(!h.calls.includes('buy'));
}
test('foreign Apple receipt cannot replace, finish, or repurchase an active website plan; message names account recovery', async () => {
  const h = setup(); await h.c.load(); await h.c.restore(); await h.c.restore(); await h.c.buy(); await h.c.manage();
  preserved(h); assert.ok(!h.calls.includes('finish')); assert.ok(h.calls.includes('manage-stripe'));
  assert.match(h.state().notice, /website subscription is active/);
  assert.match(h.state().notice, /BaristaMatch account originally used/);
  assert.doesNotMatch(h.state().notice, /Complete any store sign-in|access is confirmed|success|belongs to another/);
});
test('background receipt rejection uses the same truthful message and retains verified website access', async () => {
  const h = setup(); await h.c.load(); await h.c.recover(receipt);
  preserved(h); assert.ok(!h.calls.includes('restore')); assert.ok(!h.calls.includes('finish'));
  assert.match(h.state().notice, /website subscription is active/);
});
test('transient verification error does not claim a different owner or successful restoration', async () => {
  const h = setup({ failure: 'network' }); await h.c.load(); await h.c.restore();
  preserved(h); assert.ok(!h.calls.includes('finish'));
  assert.match(h.state().notice, /try again or contact support/);
  assert.doesNotMatch(h.state().notice, /belongs to another|confirmed|successful/);
});
test('interactive store timeout still offers store sign-in recovery to website subscribers', async () => {
  const h = setup({ storeFailure: true }); await h.c.load(); await h.c.restore();
  preserved(h); assert.match(h.state().notice, /Complete any store sign-in/);
  assert.ok(!h.calls.includes('/native-purchases')); assert.ok(!h.calls.includes('finish'));
});
test('Apple subscriber verification failures retain their existing recovery instructions', async () => {
  const h = setup({ provider: 'apple' }); await h.c.load(); await h.c.restore();
  assert.equal(h.state().subscription.provider, 'apple');
  assert.match(h.state().notice, /Complete any store sign-in/); assert.ok(!h.calls.includes('finish'));
});
test('verified expired Apple receipt preserves Stripe and finishes with actual confirmation', async () => {
  const h = setup({ failure: null }); await h.c.load(); await h.c.restore();
  preserved(h); assert.equal(h.state().notice, 'Your Pro access is confirmed.');
  assert.equal(h.calls.filter(v => v === 'finish').length, 1);
});
test('account switch during reconciliation never publishes old paid access or finishes receipt', async () => {
  const h = setup({ failure: null, switchAccount: true }); await h.c.load(); await h.c.restore();
  assert.equal(h.state().subscription, null); assert.ok(h.calls.includes('account-changed'));
  assert.ok(!h.calls.includes('finish')); assert.ok(!h.calls.includes('buy'));
});
