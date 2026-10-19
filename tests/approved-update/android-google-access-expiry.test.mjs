import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTypescript } from './load-typescript.mjs';

let clock = Date.parse('2026-10-18T14:18:00Z');
class ClockDate extends Date { static now() { return clock; } }
const timers = new Set(), controllers = [];
const globals = { Date: ClockDate,
  setTimeout(callback, delay) { const timer = { callback, at: clock + delay }; timers.add(timer); return timer; },
  clearTimeout(timer) { timers.delete(timer); },
};
const load = (path, mocks = {}) => loadTypescript(path, mocks, globals);
const purchases = load('mobile/features/native-subscription/purchaseCoordinator.ts');
const client = load('mobile/features/native-subscription/nativeBillingClient.ts');
const { SubscriptionController } = load('mobile/features/native-subscription/subscriptionController.ts', {
  './purchaseCoordinator': purchases, './nativeBillingClient': client,
});
const jsx = (type, props) => typeof type === 'function' ? type(props) : { type, props };
const { SubscriptionPanel } = load('mobile/features/native-subscription/SubscriptionPanel.tsx', {
  'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'fragment' },
  'react-native': { View: 'view', Text: 'text', Pressable: 'button', ScrollView: 'scroll', StyleSheet: { create: v => v } },
  '../approved-dashboard/DashboardPrimitives': { Icon: () => null, Action: props => ({ type: 'action', props }) },
  '../approved-dashboard/theme': { dashboardTheme: {} }, './purchaseCoordinator': purchases,
});
const paid = { accountId: 'cafe-a', verified: true, access: 'pro', provider: 'google', status: 'active',
  currentPeriodEnd: '2026-10-18T14:22:17Z', autoRenews: true, canPurchase: false, canManage: true };
const expired = { ...paid, access: 'free', status: 'payment_required' };
const flush = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };
const fire = async () => { for (const timer of [...timers]) if (timer.at <= clock) { timers.delete(timer); timer.callback(); } await flush(); };
test.beforeEach(() => { clock = Date.parse('2026-10-18T14:18:00Z'); });
test.afterEach(() => { controllers.splice(0).forEach(c => c.dispose()); timers.clear(); });
function harness(options = {}) {
  let state, status = options.status || paid, account = { id: 'cafe-a', role: 'cafe_owner_manager' };
  const calls = [];
  const c = new SubscriptionController({ accountId: 'cafe-a', platform: options.platform || 'android',
    reviewAccessEnabled: options.reviewAccessEnabled, store: null,
    account: async () => options.account ? options.account(account) : account,
    call: async path => { calls.push(path); return options.call ? options.call(status) : status; },
    changed: next => { state = next; }, accountChanged: () => calls.push('account-changed'),
    openManagement: async () => options.manage?.(),
  });
  controllers.push(c);
  return { c, calls, state: () => state, setStatus: value => { status = value; }, setAccount: value => { account = value; } };
}
function rendered(state, platform = 'android') {
  const tree = SubscriptionPanel({ role: 'cafe_owner_manager', ...state, platform, onRetry() {} });
  const text = [], actions = [];
  const walk = value => { if (typeof value === 'string') text.push(value); else if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === 'object') { if (value.type === 'action') actions.push(value.props); walk(value.props?.children); } };
  walk(tree); return { text: text.join(' '), actions };
}

test('mounted Android Google access refreshes at the verified deadline and uses only the returned access', async () => {
  const h = harness(); await h.c.load(); assert.equal(timers.size, 1);
  h.setStatus(expired); clock = Date.parse(paid.currentPeriodEnd); await fire();
  assert.equal(h.calls.length, 2); assert.equal(h.state().subscription.access, 'free');
  assert.equal(h.state().subscription.canPurchase, false); assert.equal(h.state().googleAccessNeedsConfirmation, false);
});

test('offline expiry preserves the snapshot but hides active/confirmed copy and cannot offer a new charge', async () => {
  let fail = false;
  const h = harness({ call: status => { if (fail) throw Error('private transport error'); return status; } });
  await h.c.load(); fail = true; clock = Date.parse(paid.currentPeriodEnd); await fire();
  assert.equal(h.state().subscription.access, 'pro'); assert.equal(h.state().subscription.canPurchase, false);
  assert.equal(h.state().googleAccessNeedsConfirmation, true); assert.equal(h.state().busy, false);
  const view = rendered({ ...h.state(), notice: 'Your Pro access is confirmed.' });
  assert.match(view.text, /Checking current Google Play access/);
  assert.doesNotMatch(view.text, /Your Pro access is (active|confirmed)/);
  assert.ok(!view.actions.some(a => a.label.startsWith('Subscribe')));
  assert.ok(view.actions.some(a => a.label === 'Manage Google Play subscription'));
});

test('renewal replaces the old timer and a late old timer cannot invalidate the newer period', async () => {
  const h = harness(); await h.c.load(); const oldTimer = [...timers][0];
  const renewed = { ...paid, currentPeriodEnd: '2026-10-18T14:30:00Z' };
  h.setStatus(renewed); await h.c.load(); clock = Date.parse(paid.currentPeriodEnd); oldTimer.callback(); await flush();
  assert.equal(h.state().subscription.currentPeriodEnd, renewed.currentPeriodEnd);
  assert.equal(h.state().googleAccessNeedsConfirmation, false); assert.equal(h.calls.length, 2); assert.equal(timers.size, 1);
});

test('expiry during management masks stale access immediately and queues one refresh without concurrent store actions', async () => {
  let release; const h = harness({ manage: () => new Promise(resolve => { release = resolve; }) });
  await h.c.load(); const managing = h.c.manage('google'); await flush(); assert.ok(release);
  h.setStatus(expired); clock = Date.parse(paid.currentPeriodEnd); await fire();
  assert.equal(h.state().busy, true); assert.equal(h.state().googleAccessNeedsConfirmation, true);
  assert.equal(h.calls.length, 2); await h.c.buy(); assert.equal(h.calls.length, 2);
  release(); await managing; await flush();
  assert.equal(h.state().subscription.access, 'free'); assert.equal(h.state().googleAccessNeedsConfirmation, false);
  assert.equal(h.calls.length, 3); assert.equal(h.state().busy, false);
});

test('expired cached data received from a slow status request stays unconfirmed without a request loop', async () => {
  let release; const h = harness({ call: () => new Promise(resolve => { release = resolve; }) });
  const loading = h.c.load(); await flush(); clock = Date.parse(paid.currentPeriodEnd); release(paid); await loading;
  assert.equal(h.state().googleAccessNeedsConfirmation, true); assert.equal(h.state().subscription.access, 'pro');
  assert.equal(h.calls.length, 1); assert.equal(timers.size, 0);
});

test('grace access is governed by its grace deadline rather than the older paid-period end', async () => {
  const grace = { ...paid, status: 'grace', currentPeriodEnd: '2026-10-18T14:17:00Z', gracePeriodEnd: paid.currentPeriodEnd };
  const h = harness({ status: grace }); await h.c.load(); assert.equal(h.state().googleAccessNeedsConfirmation, false);
  clock = Date.parse(paid.currentPeriodEnd); await fire();
  assert.equal(h.state().googleAccessNeedsConfirmation, true);
  assert.doesNotMatch(rendered(h.state()).text, /access remains active/);
});

test('account replacement and disposal cancel expiry work and prevent old account state from returning', async () => {
  const h = harness(); await h.c.load(); h.setAccount({ id: 'cafe-b', role: 'cafe_owner_manager' });
  clock = Date.parse(paid.currentPeriodEnd); await fire(); assert.equal(h.state().subscription, null);
  assert.equal(h.state().googleAccessNeedsConfirmation, false); assert.equal(h.calls.length, 2); assert.equal(timers.size, 0);
  const disposed = harness({ status: { ...paid, currentPeriodEnd: '2026-10-18T14:30:00Z' } }); await disposed.c.load();
  const before = disposed.calls.length; disposed.c.dispose(); clock = Date.parse('2026-10-18T14:31:00Z'); await fire();
  assert.equal(disposed.calls.length, before); assert.equal(timers.size, 0);
});

test('account-read failure at expiry leaves Android access unconfirmed and cannot leak private errors', async () => {
  let fail = false; const h = harness({ account: account => { if (fail) throw Error('private context'); return account; } });
  await h.c.load(); fail = true; clock = Date.parse(paid.currentPeriodEnd); await fire();
  assert.equal(h.state().googleAccessNeedsConfirmation, true); assert.equal(h.state().busy, false);
  assert.doesNotMatch(h.state().error, /private context/);
});

test('iOS, Stripe, Apple and reviewer access retain their existing expiry behavior', async () => {
  for (const [status, platform, reviewAccessEnabled] of [[paid, 'ios'], [{ ...paid, provider: 'stripe' }, 'android'],
    [{ ...paid, provider: 'apple' }, 'android'], [{ ...paid, reviewAccess: { active: true, expiresAt: '2026-10-18T15:00:00Z' } }, 'android', true]]) {
    const h = harness({ status, platform, reviewAccessEnabled }); await h.c.load();
    assert.equal(h.state().googleAccessNeedsConfirmation, false);
    if (!reviewAccessEnabled) assert.equal(timers.size, 0);
    clock = Date.parse(paid.currentPeriodEnd); await fire();
    assert.equal(h.state().googleAccessNeedsConfirmation, false); assert.equal(h.calls.length, 1); h.c.dispose();
  }
});
