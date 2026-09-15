import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTypescript, plain } from './load-typescript.mjs';
const storeTimeout = loadTypescript('mobile/features/native-subscription/storeTimeout.ts');
const { ExpoStoreGateway, selectMonthlyProduct } = loadTypescript('mobile/features/native-subscription/expoStoreGateway.ts', { './storeTimeout': storeTimeout });
const binding = '11111111-1111-4111-8111-111111111111';
const plan = { id: 'test.monthly', provider: 'apple', storefront: 'US', prices: { USD: 9.99 } };
const product = { id: plan.id, platform: 'ios', type: 'subs', currency: 'USD', price: 9.99, displayPrice: '$9.99', subscriptionPeriodNumberIOS: '1', subscriptionPeriodUnitIOS: 'month' };
const purchase = { id: 'transaction-a', productId: plan.id, store: 'apple', purchaseState: 'purchased', purchaseToken: 'signed-test-proof', appAccountToken: binding };
function harness(options = {}) {
  const calls = [], unfinished = []; let update, error;
  const api = {
    initConnection: async () => { calls.push('connect'); return true; }, endConnection: async () => { calls.push('disconnect'); },
    getStorefront: async () => 'USA',
    purchaseUpdatedListener(fn) { update = fn; return { remove() { calls.push('remove-update'); } }; },
    purchaseErrorListener(fn) { error = fn; return { remove() { calls.push('remove-error'); } }; },
    fetchProducts: async () => [product], requestPurchase: async args => { calls.push(['request', args]); },
    restorePurchases: async () => { calls.push('restore'); }, getAvailablePurchases: async () => [purchase],
    finishTransaction: async args => { calls.push(['finish', args]); }, deepLinkToSubscriptions: async args => calls.push(['manage', args]), ...options.api,
  };
  const gateway = new ExpoStoreGateway(api, options.plan || plan, p => unfinished.push(p), options.waitMs || 1000);
  return { gateway, calls, unfinished, emit: value => update(value), error: value => error(value) };
}
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

test('actual localized monthly store price is used without a hardcoded display price', () => {
  const result = selectMonthlyProduct({ ...product, currency: 'EUR', price: 10.99, displayPrice: '10,99 €' }, { ...plan, prices: { EUR: 10.99 } });
  assert.equal(result.product.displayPrice, '10,99 €'); assert.equal(result.product.period, 'month');
});
for (const mutation of [{ price: 19.99 }, { subscriptionPeriodUnitIOS: 'year' }, { introductoryPriceNumberOfPeriodsIOS: '1' }, { pricingTermsIOS: [{ billingPlanType: 'monthly' }] }, { platform: 'android' }]) {
  test(`unexpected product terms are blocked: ${JSON.stringify(mutation)}`, () => assert.throws(() => selectMonthlyProduct({ ...product, ...mutation }, plan)));
}
test('Google uses the approved monthly base plan and its real offer token/phase price', () => {
  const offer = { basePlanIdAndroid: 'monthly', offerTokenAndroid: 'store-offer', pricingPhasesAndroid: { pricingPhaseList: [{ billingPeriod: 'P1M', recurrenceMode: 1, formattedPrice: '$9.99', priceAmountMicros: '9990000', priceCurrencyCode: 'USD' }] } };
  const row = { ...product, platform: 'android', subscriptionOffers: [offer] }, config = { ...plan, provider: 'google', basePlanId: 'monthly' };
  assert.equal(selectMonthlyProduct(row, config).offerToken, 'store-offer');
  assert.throws(() => selectMonthlyProduct({ ...row, subscriptionOffers: [offer, offer] }, config), /terms/);
  assert.throws(() => selectMonthlyProduct(row, { ...config, basePlanId: 'annual' }), /terms/);
});
test('native request binds the account and leaves finishing to verified backend coordination', async () => {
  const h = harness(); const p = await h.gateway.product(); const result = h.gateway.buy(p, binding); await flush();
  assert.deepEqual(plain(h.calls.find(call => Array.isArray(call))[1]), { type: 'subs', request: { apple: { sku: plan.id, appAccountToken: binding, andDangerouslyFinishTransactionAutomatically: false } } });
  h.emit(purchase); assert.equal((await result).kind, 'purchased'); assert.equal(h.calls.some(call => call[0] === 'finish'), false);
  await h.gateway.dispose();
});
test('repeated taps open at most one native checkout', async () => {
  const h = harness(); const p = await h.gateway.product(); const first = h.gateway.buy(p, binding); await flush();
  assert.equal((await h.gateway.buy(p, binding)).kind, 'pending'); h.error({ code: 'user-cancelled' }); assert.equal((await first).kind, 'cancelled');
  assert.equal(h.calls.filter(call => call[0] === 'request').length, 1); await h.gateway.dispose();
});
test('pending and transport failure never acknowledge and block a second checkout', async () => {
  for (const kind of ['pending', 'network']) {
    const h = harness(); const p = await h.gateway.product(); const result = h.gateway.buy(p, binding); await flush();
    if (kind === 'pending') h.emit({ ...purchase, purchaseState: 'pending' }); else h.error({ code: 'network-error' });
    assert.equal((await result).kind, 'pending'); assert.equal((await h.gateway.buy(p, binding)).kind, 'pending');
    assert.equal(h.calls.some(call => call[0] === 'finish'), false); await h.gateway.dispose();
  }
});
test('late transaction after timeout is delivered for server recovery without a second purchase', async () => {
  const h = harness({ waitMs: 10 }); const p = await h.gateway.product(); assert.equal((await h.gateway.buy(p, binding)).kind, 'pending');
  h.emit(purchase); assert.equal(h.unfinished[0].proof, purchase.purchaseToken); assert.equal((await h.gateway.buy(p, binding)).kind, 'pending'); await h.gateway.dispose();
});
test('another account’s transaction cannot satisfy the open checkout', async () => {
  const h = harness(); const p = await h.gateway.product(); const result = h.gateway.buy(p, binding); await flush();
  h.emit({ ...purchase, appAccountToken: '22222222-2222-4222-8222-222222222222' }); assert.equal(h.unfinished.length, 1);
  h.error({ code: 'user-cancelled' }); assert.equal((await result).kind, 'cancelled'); await h.gateway.dispose();
});
test('restoration returns verifiable proofs and finishing requires the same original transaction', async () => {
  const h = harness(); const restored = await h.gateway.restore(); assert.equal(restored[0].proof, purchase.purchaseToken);
  await assert.rejects(h.gateway.finish({ ...restored[0], proof: 'different' }), /changed/);
  await h.gateway.finish(restored[0]); assert.equal(h.calls.find(call => call[0] === 'finish')[1].isConsumable, false); await h.gateway.dispose();
});
test('a pending restored purchase is not treated as missing access or acknowledged', async () => {
  const h = harness({ api: { getAvailablePurchases: async () => [{ ...purchase, purchaseState: 'pending' }] } });
  await assert.rejects(h.gateway.restore(), /pending/); assert.equal(h.calls.some(call => call[0] === 'finish'), false); await h.gateway.dispose();
});
test('closing the screen settles an open checkout as pending and removes listeners', async () => {
  const h = harness(); const p = await h.gateway.product(); const result = h.gateway.buy(p, binding); await flush(); await h.gateway.dispose();
  assert.equal((await result).kind, 'pending'); assert.ok(h.calls.includes('remove-update')); assert.ok(h.calls.includes('remove-error')); await assert.rejects(h.gateway.product(), /closed/);
});


test('USD products in a non-US storefront cannot be offered or purchased', async () => {
  for (const country of ['CAN', 'BHS', 'PAN', 'GBR']) {
    const h = harness({ api: { getStorefront: async () => country } });
    await assert.rejects(h.gateway.product(), error => error.reason === 'outside_us');
    assert.equal(h.calls.some(call => call[0] === 'request'), false);
    await h.gateway.dispose();
  }
});
test('failed or missing store-country lookup blocks checkout without guessing location', async () => {
  for (const lookup of [async () => '', async () => null, async () => { throw new Error('offline'); }]) {
    const h = harness({ api: { getStorefront: lookup } });
    await assert.rejects(h.gateway.product(), error => error.reason === 'unconfirmed');
    assert.equal(h.calls.some(call => call[0] === 'request'), false);
    await h.gateway.dispose();
  }
});
test('store account change after price loading is checked again before charging', async () => {
  let country = 'USA';
  const h = harness({ api: { getStorefront: async () => country } });
  const p = await h.gateway.product(); country = 'BHS';
  await assert.rejects(h.gateway.buy(p, binding), error => error.reason === 'outside_us');
  assert.equal(h.calls.some(call => call[0] === 'request'), false);
  await h.gateway.dispose();
});
test('restoration and management remain accessible outside the United States', async () => {
  const h = harness({ api: { getStorefront: async () => { throw new Error('must not look up country'); } } });
  const restored = await h.gateway.restore(); assert.equal(restored.length, 1);
  await h.gateway.finish(restored[0]); await h.gateway.manage();
  assert.equal(h.calls.filter(call => call[0] === 'manage').length, 1);
  await h.gateway.dispose();
});
test('concurrent storefront lookups still open only one checkout', async () => {
  let release; let deferred = false;
  const gate = new Promise(resolve => { release = resolve; });
  const h = harness({ api: { getStorefront: async () => { if (deferred) await gate; return 'USA'; } } });
  const p = await h.gateway.product(); deferred = true;
  const first = h.gateway.buy(p, binding), second = h.gateway.buy(p, binding);
  release(); await flush();
  assert.equal((await second).kind, 'pending');
  assert.equal(h.calls.filter(call => call[0] === 'request').length, 1);
  h.error({ code: 'user-cancelled' }); assert.equal((await first).kind, 'cancelled');
  await h.gateway.dispose();
});
test('closing while country lookup is pending cannot open checkout later', async () => {
  let release; let deferred = false;
  const gate = new Promise(resolve => { release = resolve; });
  const h = harness({ api: { getStorefront: async () => { if (deferred) await gate; return 'USA'; } } });
  const p = await h.gateway.product(); deferred = true;
  const pending = h.gateway.buy(p, binding); await flush();
  await h.gateway.dispose(); release();
  await assert.rejects(pending, /closed/);
  assert.equal(h.calls.some(call => call[0] === 'request'), false);
});
test('Google uses the Play account country code rather than the Apple code', async () => {
  const googlePlan = { ...plan, provider: 'google', basePlanId: 'monthly' };
  const row = { ...product, platform: 'android', subscriptionOffers: [{ basePlanIdAndroid: 'monthly', offerTokenAndroid: 'store-offer', pricingPhasesAndroid: { pricingPhaseList: [{ billingPeriod: 'P1M', recurrenceMode: 1, formattedPrice: '$9.99', priceAmountMicros: '9990000', priceCurrencyCode: 'USD' }] } }] };
  for (const [country, allowed] of [['US', true], ['CA', false], ['USA', false]]) {
    const h = harness({ plan: googlePlan, api: { getStorefront: async () => country, fetchProducts: async () => [row] } });
    if (allowed) assert.equal((await h.gateway.product()).provider, 'google');
    else await assert.rejects(h.gateway.product(), error => error.reason === 'outside_us');
    await h.gateway.dispose();
  }
});
test('only the actual U.S. Apple product is enabled in the app catalog', () => {
  const { approvedStorePlan } = loadTypescript('mobile/features/native-subscription/storeCatalog.ts');
  assert.deepEqual(plain(approvedStorePlan('ios')), { id: 'com.baristajobmatch.cafe.pro.monthly', provider: 'apple', storefront: 'US', prices: { USD: 9.99 } });
  assert.equal(approvedStorePlan('android'), null); assert.equal(approvedStorePlan('web'), null);
  const mutable = approvedStorePlan('ios'); mutable.prices.USD = 99;
  assert.equal(approvedStorePlan('ios').prices.USD, 9.99);
});
