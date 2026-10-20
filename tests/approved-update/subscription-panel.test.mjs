import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTypescript } from './load-typescript.mjs';
const purchases = loadTypescript('mobile/features/native-subscription/purchaseCoordinator.ts');
const jsx = (type, props) => typeof type === 'function' ? type(props) : { type, props };
const { SubscriptionPanel } = loadTypescript('mobile/features/native-subscription/SubscriptionPanel.tsx', {
  'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'fragment' },
  'react-native': { View: 'view', Text: 'text', Pressable: 'button', ScrollView: 'scroll', StyleSheet: { create: value => value } },
  '../approved-dashboard/DashboardPrimitives': { Icon: () => null, Action: props => ({ type: 'action', props }) },
  '../approved-dashboard/theme': { dashboardTheme: {} }, './purchaseCoordinator': purchases,
});
const subscription = { accountId: 'cafe-a', verified: true, access: 'free', provider: null, canPurchase: true, canManage: false, status: 'free', currentPeriodEnd: null, autoRenews: false };
const product = { id: 'synthetic', displayPrice: '$9.99', currency: 'USD', period: 'month', provider: 'apple' };
function actions(changes) {
  const tree = SubscriptionPanel({ role: 'cafe_owner_manager', subscription, product, busy: false, ...changes });
  const results = [];
  function walk(value) {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) return value.forEach(walk);
    if (value.type === 'action') results.push(value.props);
    walk(value.props?.children);
  }
  walk(tree); return results;
}
test('expired store subscribers retain management and can repurchase only when server allows it', () => {
  const expired = { ...subscription, provider: 'apple', status: 'expired', canManage: true };
  const available = actions({ subscription: expired });
  assert.ok(available.some(value => value.label === 'Subscribe for $9.99/month'));
  assert.ok(available.some(value => value.label === 'Manage Apple subscription'));
  assert.ok(!actions({ subscription: { ...expired, canPurchase: false } }).some(value => value.label.startsWith('Subscribe')));
});
test('paid website subscribers receive provider management instead of a duplicate purchase', () => {
  const paid = actions({ subscription: { ...subscription, access: 'pro', status: 'active', provider: 'stripe', canManage: true, canPurchase: false } });
  assert.ok(paid.some(value => value.label === 'Manage Stripe subscription'));
  assert.ok(!paid.some(value => value.label.startsWith('Subscribe')));
});
test('billing errors and pending status cannot leave a stale purchase button available', () => {
  for (const state of [{ error: 'Offline' }, { subscription: { ...subscription, status: 'pending', canPurchase: false } }, { product: null }]) {
    assert.ok(!actions(state).some(value => value.label.startsWith('Subscribe')));
  }
});
test('restore remains available when account status failed, but disappears without a native store', () => {
  assert.ok(actions({ subscription: null, error: 'Offline' }).some(value => value.label === 'Restore purchases' && !value.disabled));
  assert.ok(!actions({ canRestore: false }).some(value => value.label === 'Restore purchases'));
});
test('barista accounts never render subscription controls', () => {
  assert.equal(SubscriptionPanel({ role: 'barista' }), null);
});

function visibleText(changes = {}) {
  const tree = SubscriptionPanel({ role: 'cafe_owner_manager', subscription, product, busy: false, ...changes });
  const parts = [];
  function walk(value) {
    if (typeof value === 'string' || typeof value === 'number') { parts.push(String(value)); return; }
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) { value.forEach(walk); return; }
    walk(value.props?.children);
  }
  walk(tree);
  return parts.join(' ');
}
test('unconfigured stores identify café-only checkout and do not advertise restore or a guessed price', () => {
  const copy = visibleText({ product: null, canRestore: false });
  assert.match(copy, /Café Pro purchase pricing is not available on this device yet/);
  assert.match(copy, /Café Pro checkout is unavailable/);
  assert.match(copy, /Baristas stay free/);
  assert.doesNotMatch(copy, /\$9\.99|Restore purchases made/);
  assert.ok(!actions({ product: null, canRestore: false }).some(value => /Subscribe|Restore/.test(value.label)));
});
test('configured monthly pricing still comes from the store and annual purchases are not introduced', () => {
  const copy = visibleText({ product: { ...product, displayPrice: 'STORE PRICE' }, canRestore: true });
  assert.match(copy, /STORE PRICE per month/);
  assert.match(copy, /Restore purchases made with your current store account/);
  assert.doesNotMatch(copy, /\$9\.99|annual|yearly/i);
});

test('every existing provider keeps its own management action', () => {
  const called = [];
  const results = actions({ subscription: { ...subscription, access: 'pro', provider: 'apple', canManage: true, canPurchase: false,
    subscriptions: [{ provider: 'apple', canManage: true, access: 'pro' }, { provider: 'stripe', canManage: true, access: 'free' }] }, onManage: provider => called.push(provider) });
  results.find(row => row.label === 'Manage Apple subscription').onPress();
  results.find(row => row.label === 'Manage Stripe subscription').onPress();
  assert.deepEqual(called, ['apple', 'stripe']);
});
