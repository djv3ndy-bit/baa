import test from 'node:test';
import assert from 'node:assert/strict';
import {loadTypescript, plain} from './load-typescript.mjs';
const coordinator = loadTypescript('mobile/features/native-subscription/purchaseCoordinator.ts');
const client = loadTypescript('mobile/features/native-subscription/nativeBillingClient.ts');
const {SubscriptionController} = loadTypescript('mobile/features/native-subscription/subscriptionController.ts', {
  './purchaseCoordinator': coordinator, './nativeBillingClient': client,
});
const product = {id: 'synthetic.monthly', provider: 'google', basePlanId: 'monthly', displayPrice: '$9.99', currency: 'USD', period: 'month'};
const receipt = {id: 'synthetic-expired', productId: product.id, provider: 'google', proof: 'synthetic-only-proof'};
const expired = {accountId: 'cafe-a', verified: true, access: 'free', provider: 'google', status: 'expired', canManage: true,
  canPurchase: true, currentPeriodEnd: '2020-01-01T00:00:00Z', autoRenews: false};
const blocked = {...expired, status: 'payment_required', canPurchase: false};
const deferred = () => {let resolve; const promise = new Promise(r => {resolve = r;}); return {promise, resolve};};
const flush = () => new Promise(resolve => setImmediate(resolve));

function harness(options = {}) {
  let account = {id: 'cafe-a', role: 'cafe_owner_manager'}, status = options.initial ?? blocked, state;
  const calls = [], states = [];
  const provider = options.provider ?? 'google';
  const selectedProduct = {...product, provider}, purchase = {...receipt, provider};
  const store = {
    async connect() {calls.push('connect');},
    async country() {return provider === 'google' ? 'US' : 'USA';},
    async product() {calls.push('product'); return options.product ? options.product() : selectedProduct;},
    async restore() {calls.push('restore'); if (options.restoreThrow) throw Error('PRIVATE_STORE_ERROR'); return options.empty ? [] : [purchase];},
    async finish() {calls.push('finish');},
    async buy() {calls.push('buy'); throw Error('must not buy during Restore');},
    async manage() {}, async dispose() {calls.push('dispose');},
  };
  const c = new SubscriptionController({accountId: 'cafe-a', platform: options.platform ?? 'android', store,
    account: async () => account,
    call: async (path, body, method, expected) => {
      calls.push(path); assert.equal(expected, 'cafe-a');
      if (path.endsWith('status')) return status;
      if (path === '/native-purchases') {
        if (options.verifyThrow) throw Error('PRIVATE_PROVIDER_ERROR');
        status = {...(options.after ?? expired), provider};
        return {accountId: 'cafe-a', verified: true, purchase: {provider, status: 'expired'}};
      }
      throw Error('unexpected checkout mutation');
    },
    changed: value => {state = value; states.push(value);},
    accountChanged: () => calls.push('account-changed'), openManagement: async () => {},
  });
  return {c, calls, states, state: () => state, setAccount: value => {account = value;}, setStatus: value => {status = value;}};
}
const count = (h, name) => h.calls.filter(call => call === name).length;
function noCheckout(h) {
  assert.equal(count(h, 'buy'), 0);
  assert.equal(h.calls.some(call => /prepare|start|cancel/.test(call)), false);
}

test('Android blocked-to-expired Restore loads current price without a second screen entry or checkout', async () => {
  const h = harness(); await h.c.load(); assert.equal(h.state().product, null); assert.equal(count(h, 'product'), 0);
  await h.c.restore();
  assert.equal(h.state().subscription.status, 'expired'); assert.equal(h.state().subscription.access, 'free');
  assert.deepEqual(plain(h.state().product), product); assert.equal(h.state().busy, false); assert.equal(h.state().error, '');
  assert.equal(h.state().notice, 'No active in-app subscription was confirmed for this BaristaMatch account.');
  assert.equal(count(h, 'product'), 1); assert.equal(count(h, 'restore'), 1); assert.equal(count(h, 'finish'), 1);
  assert.ok(h.calls.indexOf('product') > h.calls.indexOf('finish')); noCheckout(h); h.c.dispose();
});

test('catalog refresh remains under the existing lock; repeated Restore and Buy cannot start another operation', async () => {
  const gate = deferred(); const h = harness({product: () => gate.promise}); await h.c.load();
  const restoring = h.c.restore(); await flush(); assert.equal(count(h, 'product'), 1); assert.equal(h.state().busy, true);
  await h.c.restore(); await h.c.buy(); assert.equal(count(h, 'restore'), 1); noCheckout(h);
  gate.resolve(product); await restoring; assert.equal(h.state().busy, false); assert.deepEqual(plain(h.state().product), product); h.c.dispose();
});

for (const after of [{...expired, canPurchase: false, status: 'pending'}, {...expired, canPurchase: false, status: 'payment_required'},
  {...expired, provider: 'google', access: 'pro', status: 'active', canPurchase: false, currentPeriodEnd: '2099-01-01T00:00:00Z'}]) {
  test('still-blocked/currently-paid restored state never fetches a price or enables checkout', async () => {
    const h = harness({after}); await h.c.load(); await h.c.restore();
    assert.equal(count(h, 'product'), 0); assert.equal(h.state().product, null); noCheckout(h); h.c.dispose();
  });
}

test('initially eligible Android screen keeps its existing loaded catalog after Restore', async () => {
  const h = harness({initial: expired}); await h.c.load(); assert.equal(count(h, 'product'), 1);
  await h.c.restore(); assert.equal(count(h, 'product'), 1); assert.deepEqual(plain(h.state().product), product); noCheckout(h); h.c.dispose();
});

for (const options of [{platform: 'ios', provider: 'apple'}, {platform: 'ios', provider: 'google'}, {platform: 'android', provider: 'apple'}]) {
  test('iOS and Apple restoration retain the prior no-catalog-refresh behavior', async () => {
    const h = harness({...options, initial: {...blocked, provider: options.provider}}); await h.c.load(); await h.c.restore();
    assert.equal(count(h, 'product'), 0); assert.equal(h.state().product, null); assert.equal(h.state().subscription.status, 'expired');
    assert.equal(count(h, 'restore'), 1); assert.equal(count(h, 'finish'), 1); noCheckout(h); h.c.dispose();
  });
}

for (const options of [{verifyThrow: true}, {restoreThrow: true}]) test('failed/uncertain restoration does not reload a catalog or invite another buy', async () => {
  const h = harness(options); await h.c.load(); await h.c.restore();
  assert.equal(count(h, 'product'), 0); assert.equal(h.state().product, null); assert.match(h.state().notice, /could not be confirmed/);
  noCheckout(h); h.c.dispose();
});

for (const [reason, expected] of [['outside_us', /United States store/], ['terms_review', /terms that need review/], ['unknown', /current U\.S\. store price/]]) {
  test('price failure preserves verified expired state and uses safe existing retry copy', async () => {
    let fail = true;
    const h = harness({product: () => {if (fail) throw {reason, message: 'PRIVATE_STORE_ERROR'}; return product;}});
    await h.c.load(); await h.c.restore();
    assert.equal(h.state().subscription.status, 'expired'); assert.equal(h.state().subscription.access, 'free');
    assert.equal(h.state().product, null); assert.match(h.state().error, expected); assert.doesNotMatch(h.state().error, /PRIVATE_STORE_ERROR/);
    await h.c.buy(); noCheckout(h);
    fail = false; await h.c.load(); assert.equal(h.state().error, ''); assert.deepEqual(plain(h.state().product), product); h.c.dispose();
  });
}

test('account replacement while restored price is loading cannot publish the prior account product', async () => {
  const gate = deferred(); const h = harness({product: () => gate.promise}); await h.c.load();
  const restoring = h.c.restore(); await flush(); assert.equal(count(h, 'product'), 1);
  h.setAccount({id: 'cafe-b', role: 'cafe_owner_manager'}); gate.resolve(product); await restoring;
  assert.equal(h.state().subscription, null); assert.equal(h.state().product, null); assert.ok(h.calls.includes('account-changed')); noCheckout(h); h.c.dispose();
});

test('screen disposal while restored price is loading suppresses all late product/error updates', async () => {
  const gate = deferred(); const h = harness({product: () => gate.promise}); await h.c.load();
  const restoring = h.c.restore(); await flush(); assert.equal(count(h, 'product'), 1);
  h.c.dispose(); const before = h.states.length; gate.resolve(product); await restoring;
  assert.equal(h.states.length, before); noCheckout(h);
});
