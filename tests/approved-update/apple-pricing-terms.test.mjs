import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTypescript } from './load-typescript.mjs';
const timeout = loadTypescript('mobile/features/native-subscription/storeTimeout.ts');
const { selectMonthlyProduct } = loadTypescript('mobile/features/native-subscription/expoStoreGateway.ts', { './storeTimeout': timeout });
const plan = { id: 'test.monthly', provider: 'apple', storefront: 'US', prices: { USD: 9.99 } };
const product = { id: plan.id, platform: 'ios', type: 'subs', currency: 'USD', price: 9.99, displayPrice: '$9.99', subscriptionPeriodNumberIOS: '1', subscriptionPeriodUnitIOS: 'month' };
// Apple documents one up-front entry even for an ordinary monthly subscription.
// OpenIAP exposes this on iOS26.4+; these are SDK-shaped fixtures, not live receipts.
const standard = { billingPlanType: 'up-front', billingPrice: 9.99, billingDisplayPrice: '$9.99', billingPeriod: { unit: 'month', value: 1 }, commitmentInfo: { price: 9.99, displayPrice: '$9.99', period: { unit: 'month', value: 1 } }, subscriptionOffers: null };
test('new Apple pricing metadata accepts the same approved monthly price and one-month term', () => {
  const result = selectMonthlyProduct({ ...product, pricingTermsIOS: [standard] }, plan);
  assert.equal(result.product.displayPrice, '$9.99'); assert.equal(result.product.period, 'month');
});
for (const [name, change] of [
  ['12-month payment commitment', { billingPlanType: 'monthly', commitmentInfo: { ...standard.commitmentInfo, period: { unit: 'year', value: 1 }, price: 119.88 } }],
  ['annual up-front period', { billingPeriod: { unit: 'year', value: 1 } }],
  ['extended commitment', { commitmentInfo: { ...standard.commitmentInfo, period: { unit: 'month', value: 12 } } }],
  ['different billing price', { billingPrice: 19.99 }],
  ['different commitment price', { commitmentInfo: { ...standard.commitmentInfo, price: 119.88 } }],
  ['different displayed price', { billingDisplayPrice: '$19.99' }],
  ['different displayed commitment', { commitmentInfo: { ...standard.commitmentInfo, displayPrice: '$119.88' } }],
  ['unknown billing plan', { billingPlanType: 'unknown' }],
  ['missing commitment metadata', { commitmentInfo: null }],
  ['unapproved introductory offer', { subscriptionOffers: [{ type: 'introductory', displayPrice: '$0.00' }] }],
]) {
  test(`new Apple pricing metadata rejects ${name}`, () => assert.throws(() => selectMonthlyProduct({ ...product, pricingTermsIOS: [{ ...standard, ...change }] }, plan)));
}
test('ambiguous or malformed Apple pricing terms remain blocked', () => {
  for (const terms of [[standard, standard], 'invalid', [null], [{}]]) assert.throws(() => selectMonthlyProduct({ ...product, pricingTermsIOS: terms }, plan));
});
test('legacy Apple product responses still work without the newer optional pricing metadata', () => {
  for (const terms of [undefined, null, []]) assert.equal(selectMonthlyProduct({ ...product, pricingTermsIOS: terms }, plan).product.displayPrice, '$9.99');
});
