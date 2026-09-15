import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const context = vm.createContext({});
vm.runInContext(readFileSync(new URL('../../account-billing-presentation.js', import.meta.url), 'utf8'), context);
const { present } = context.BaristaMatchAccountBilling;
const status = { accountId: 'cafe-a', verified: true, access: 'pro', provider: 'apple', status: 'active', currentPeriodEnd: '2099-01-01T00:00:00Z', autoRenews: true,
  subscriptions: [{ provider: 'apple', canManage: true, access: 'pro' }] };
test('website presentation preserves the original Stripe UI when there is no native billing', () => {
  assert.equal(present({ plan: 'pro' }, 'cafe-a'), null);
});
test('Apple access and management are labeled accurately without an invented renewal price', () => {
  const result = present({ nativeStatus: status, canManageBilling: true }, 'cafe-a');
  assert.equal(result.title, 'Pro · Active'); assert.match(result.detail, /through Apple/);
  assert.match(result.detail, /Current period ends/); assert.ok(!result.detail.includes('Next billing date'));
  assert.equal(result.links[0].url, 'https://apps.apple.com/account/subscriptions');
});
test('expired store plans retain management links while allowing Free and Pro plan selection', () => {
  const result = present({ canManageBilling: false, nativeStatus: { ...status, access: 'free', status: 'expired' } }, 'cafe-a');
  assert.equal(result.manageable, false); assert.equal(result.links.length, 1); assert.equal(result.title, 'Free · Active · $0');
});
test('pending, grace and payment recovery cannot claim a successful renewal', () => {
  for (const state of ['pending', 'grace', 'payment_required']) {
    const result = present({ nativeStatus: { ...status, status: state, access: state === 'grace' ? 'pro' : 'free', gracePeriodEnd: '2099-01-04T00:00:00Z' } }, 'cafe-a');
    assert.ok(!result.detail.includes('Next billing date'));
    if (state === 'pending') assert.match(result.detail, /Restore purchases/);
    if (state === 'grace') assert.match(result.detail, /Grace access ends/);
  }
});
test('stale account responses and unverified status cannot render paid access', () => {
  assert.throws(() => present({ nativeStatus: status }, 'cafe-b'), /reload/);
  assert.throws(() => present({ nativeStatus: { ...status, verified: false } }, 'cafe-a'), /reload/);
});
