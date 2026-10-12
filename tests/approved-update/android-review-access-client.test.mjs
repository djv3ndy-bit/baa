import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTypescript, plain } from './load-typescript.mjs';

let clock = Date.now();
class ClockDate extends Date { static now() { return clock; } }
const timers = new Set(), controllers = [];
const timedGlobals = { Date: ClockDate,
  setTimeout(callback, delay) { const timer = { callback, at: clock + delay }; timers.add(timer); return timer; },
  clearTimeout(timer) { timers.delete(timer); },
};
const load = (path, mocks = {}) => loadTypescript(path, mocks, timedGlobals);
test.beforeEach(() => { clock = Date.now(); });
test.afterEach(() => { controllers.splice(0).forEach(controller => controller.dispose()); timers.clear(); });
const fireDueTimers = () => { for (const timer of [...timers]) if (timer.at <= clock) { timers.delete(timer); timer.callback(); } };
const purchases = load('mobile/features/native-subscription/purchaseCoordinator.ts');
const client = load('mobile/features/native-subscription/nativeBillingClient.ts');
const { SubscriptionController } = load('mobile/features/native-subscription/subscriptionController.ts', {
  './purchaseCoordinator': purchases, './nativeBillingClient': client,
});
const environment = {
  review: true, apiBase: 'https://android-testing.baristajobmatch.com/api',
  supabaseUrl: 'https://ojvjlvojvozvhktbclcg.supabase.co', publishableKey: 'sb_publishable_fixture',
};
const expiresAt = new Date(Date.now() + 86400000 * 30).toISOString();
const free = { accountId: 'cafe-a', verified: true, access: 'free', provider: null, canPurchase: true, canManage: false, status: 'free', currentPeriodEnd: null, autoRenews: false };
const expired = { ...free, provider: 'google', status: 'expired', canManage: true, currentPeriodEnd: '2020-01-01T00:00:00.000Z', subscriptions: [{ provider: 'google', canManage: true, access: 'free' }] };
const review = { ...expired, access: 'pro', canPurchase: false, reviewAccess: { active: true, expiresAt } };
const product = { id: 'synthetic.monthly', provider: 'google', basePlanId: 'monthly', displayPrice: '$9.99', currency: 'USD', period: 'month' };
const purchase = { id: 'expired-transaction', provider: 'google', productId: product.id, proof: 'synthetic-proof' };
const paid = { ...free, access: 'pro', provider: 'google', status: 'active', canPurchase: false, canManage: true, autoRenews: true };

test('reviewer access requires the exact Android review API, database and public-client configuration', () => {
  assert.equal(client.androidReviewerAccessEnabled('android', environment), true);
  for (const platform of ['ios', 'web', '']) assert.equal(client.androidReviewerAccessEnabled(platform, environment), false);
  for (const changed of [{ review: false }, { apiBase: 'https://www.baristajobmatch.com/api' }, { apiBase: `${environment.apiBase}/` },
    { supabaseUrl: 'https://other.supabase.co' }, { publishableKey: '' }, { publishableKey: 'sb_secret_fixture' }, { publishableKey: 'legacy-jwt' }]) {
    assert.equal(client.androidReviewerAccessEnabled('android', { ...environment, ...changed }), false);
  }
});

test('an authorized reviewer grant is additive and preserves real expired Google history', () => {
  const result = client.checkedSubscription(review, free.accountId, true);
  assert.deepEqual(plain(result), review);
  assert.equal(result.provider, 'google'); assert.equal(result.status, 'expired');
  assert.equal(result.currentPeriodEnd, expired.currentPeriodEnd); assert.equal(result.autoRenews, false);
  assert.deepEqual(plain(result.subscriptions), expired.subscriptions);
  assert.throws(() => client.checkedSubscription(review, free.accountId));
  assert.throws(() => client.checkedSubscription(review, 'other-account', true));
});

test('malformed, expired and contradictory reviewer grants fail closed', () => {
  for (const value of [null, {}, [], { active: false, expiresAt }, { active: true, expiresAt: 'invalid' },
    { active: true, expiresAt: '2020-01-01T00:00:00.000Z' }, { active: true, expiresAt: null }]) {
    assert.throws(() => client.checkedSubscription({ ...review, reviewAccess: value }, free.accountId, true));
  }
  for (const changed of [{ access: 'free' }, { canPurchase: true }, { verified: false }]) {
    assert.throws(() => client.checkedSubscription({ ...review, ...changed }, free.accountId, true));
  }
  assert.deepEqual(plain(client.checkedSubscription(expired, free.accountId)), expired);
});

function controller(options = {}) {
  let status = options.status || review, account = { id: free.accountId, role: 'cafe_owner_manager' }, state;
  const calls = [];
  const store = {
    connect: async () => calls.push('connect'), product: async () => { calls.push('product'); return product; },
    country: async () => 'US', buy: async () => { calls.push('buy'); return { kind: 'purchased', purchase }; },
    restore: async () => { calls.push('restore'); return options.restored || []; },
    finish: async () => calls.push('finish'), manage: async () => {}, dispose: async () => {},
  };
  const c = new SubscriptionController({
    accountId: free.accountId, platform: options.platform || 'android', reviewAccessEnabled: options.enabled !== false,
    account: async () => options.readAccount ? options.readAccount(account) : account, store: options.noStore ? null : store,
    call: async path => {
      calls.push(path);
      if (options.call) { const result = await options.call(path); if (result !== undefined) return result; }
      if (path.endsWith('status')) return status;
      if (path.endsWith('prepare')) return { attemptId: '10000000-0000-4000-8000-000000000001', accountBinding: '20000000-0000-4000-8000-000000000001' };
      if (path.endsWith('start')) return { started: true };
      if (path === '/native-purchases') {
        if (options.afterPurchase) status = options.afterPurchase;
        return { verified: true, accountId: free.accountId, purchase: { provider: 'google', status: options.purchaseStatus || 'expired' } };
      }
      throw Error('Unexpected call');
    },
    changed: next => { state = next; }, accountChanged: () => calls.push('account-changed'),
    openManagement: async provider => calls.push(`manage-${provider}`),
  });
  controllers.push(c);
  return { c, calls, state: () => state, setStatus: next => { status = next; }, setAccount: next => { account = next; } };
}

test('active reviewer access loads without price or new checkout and can restore without claiming a paid purchase', async () => {
  const h = controller(); await h.c.load();
  assert.equal(h.state().subscription.access, 'pro'); assert.equal(h.state().product, null);
  assert.ok(h.calls.includes('connect')); assert.ok(!h.calls.includes('product'));
  await h.c.buy(); assert.ok(!h.calls.some(value => value === 'buy' || value.endsWith('prepare')));
  await h.c.restore(); assert.ok(h.calls.includes('restore'));
  assert.equal(h.state().notice, 'Reviewer Pro access is confirmed. No payment is required.');
});

test('a grant activated after price load blocks the stale buy before preparation or store checkout', async () => {
  const h = controller({ status: free }); await h.c.load(); assert.equal(h.state().product.provider, 'google');
  h.setStatus(review); await h.c.buy();
  assert.equal(h.state().subscription.reviewAccess.active, true);
  assert.match(h.state().notice, /^Reviewer Pro access/);
  assert.ok(!h.calls.some(value => value === 'buy' || value.endsWith('prepare') || value.endsWith('start')));
});

test('restoring an independently verified expired Google proof retains the separate grant and finishes the real proof', async () => {
  const h = controller({ restored: [purchase] }); await h.c.restore();
  assert.equal(h.state().subscription.status, 'expired'); assert.equal(h.state().subscription.reviewAccess.active, true);
  assert.ok(h.calls.indexOf('/native-purchases') < h.calls.indexOf('finish'));
  assert.equal(h.state().notice, 'Reviewer Pro access is confirmed. No payment is required.');
});

test('reviewer access remains truthful without a store and after a failed store restore', async () => {
  const unavailable = controller({ noStore: true }); await unavailable.c.load();
  assert.equal(unavailable.state().notice, 'Reviewer Pro access is confirmed. No payment is required.');
  const failed = controller({ call: async path => { if (path === '/native-purchases') throw Error('offline'); }, restored: [purchase] });
  await failed.c.restore();
  assert.match(failed.state().notice, /^Reviewer Pro access is confirmed\. No payment is required\./);
  assert.match(failed.state().notice, /could not finish checking this store purchase/);
  assert.ok(!failed.calls.includes('finish'));
});

test('grant removal clears reviewer confirmation and retains actual Google management', async () => {
  const h = controller(); await h.c.restore(); assert.match(h.state().notice, /^Reviewer/);
  h.setStatus(expired); await h.c.manage('google');
  assert.equal(h.state().notice, ''); assert.equal(h.state().subscription.access, 'free');
  assert.ok(h.calls.includes('manage-google'));
  await h.c.load(); assert.equal(h.state().product.provider, 'google');
});

test('iOS and disabled client contexts reject grant-bearing responses without changing ordinary paid status', async () => {
  for (const options of [{ platform: 'ios' }, { enabled: false }]) {
    const h = controller(options); await h.c.load();
    assert.equal(h.state().subscription, null); assert.match(h.state().error, /could not confirm/);
    assert.ok(!h.calls.includes('connect'));
  }
  const h = controller({ platform: 'ios', status: { ...paid, provider: 'apple' } }); await h.c.load();
  assert.equal(h.state().subscription.provider, 'apple'); assert.equal(h.state().error, '');
});

test('an account change during reviewer-status loading cannot publish the previous account grant', async () => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const h = controller({ call: async path => path.endsWith('status') ? pending : undefined });
  const loading = h.c.load();
  while (!h.calls.length) await new Promise(resolve => setImmediate(resolve));
  h.setAccount({ id: 'other-account', role: 'cafe_owner_manager' }); release(review); await loading;
  assert.equal(h.state().subscription, null); assert.equal(h.state().product, null);
  assert.ok(h.calls.includes('account-changed'));
});

test('ordinary Google purchase flow remains available when no grant exists', async () => {
  const h = controller({ status: free, afterPurchase: paid, purchaseStatus: 'active' });
  await h.c.load(); await h.c.buy();
  assert.ok(h.calls.includes('buy')); assert.ok(h.calls.includes('finish'));
  assert.equal(h.state().notice, 'Your Pro access is confirmed.');
  assert.equal(h.state().subscription.reviewAccess, undefined);
});

const jsx = (type, props) => typeof type === 'function' ? type(props) : { type, props };
const native = { View: 'view', Text: 'text', Pressable: 'button', ScrollView: 'scroll', StyleSheet: { create: value => value } };
const { SubscriptionPanel } = load('mobile/features/native-subscription/SubscriptionPanel.tsx', {
  'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'fragment' }, 'react-native': native,
  '../approved-dashboard/DashboardPrimitives': { Icon: () => null, Action: props => ({ type: 'action', props }) },
  '../approved-dashboard/theme': { dashboardTheme: {} }, './purchaseCoordinator': purchases,
});
function nodes(tree) {
  const found = [];
  function visit(value) {
    if (Array.isArray(value)) return value.forEach(visit);
    if (value && typeof value === 'object') { found.push(value); visit(value.props?.children); }
  }
  visit(tree); return found;
}
function text(tree) {
  if (Array.isArray(tree)) return tree.map(text).join(' ');
  return typeof tree === 'string' ? tree : tree && typeof tree === 'object' ? text(tree.props?.children) : '';
}
function summary(subscription, { platform = 'android', env = environment, environmentReader, expiryChanged = () => {} } = {}) {
  const { NativeSubscriptionSummary } = load('mobile/features/native-subscription/NativeSubscriptionSummary.tsx', {
    react: { useState: () => [0, expiryChanged], useEffect: callback => { callback(); } },
    'react/jsx-runtime': { jsx, jsxs: jsx }, 'react-native': { ...native, Platform: { OS: platform } },
    '../approved-dashboard/theme': { dashboardTheme: {} }, './purchaseCoordinator': purchases,
    './nativeBillingClient': client, '../review-mode/environment': { getAppEnvironment: environmentReader || (() => env) },
  });
  return text(NativeSubscriptionSummary({ subscription, error: '', opening: false, onPress() {} }));
}

test('reviewer plans show no-payment expiry and preserve real Google manage/restore without a subscribe button', () => {
  const tree = SubscriptionPanel({ role: 'cafe_owner_manager', subscription: review, product, busy: false, reviewAccessEnabled: true });
  const copy = text(tree), actions = nodes(tree).filter(value => value.type === 'action').map(value => value.props.label);
  assert.match(copy, /Reviewer Pro access/); assert.match(copy, /No payment is required/); assert.match(copy, /Reviewer access ends/);
  assert.doesNotMatch(copy, /Current period ends|Access ends.*2020|Your Pro access is active/);
  assert.ok(actions.includes('Manage Google Play subscription')); assert.ok(actions.includes('Restore purchases'));
  assert.ok(!actions.some(label => label.startsWith('Subscribe') || label.includes('Apple')));
});

test('Settings summary labels the reviewer grant without attributing access to Stripe or an expired Google purchase', () => {
  for (const subscription of [review, { ...review, provider: null, status: 'free', subscriptions: [] }]) {
    const copy = summary(subscription);
    assert.match(copy, /Reviewer Pro access/); assert.match(copy, /No payment is required/); assert.match(copy, /Reviewer access ends/);
    assert.doesNotMatch(copy, /verified through|Stripe|Google Play|Pro · Active/);
  }
});

test('Settings rejects invalid, expired and out-of-scope grants rather than falling back to fake paid-provider copy', () => {
  for (const [value, options] of [[{ ...review, reviewAccess: { active: true, expiresAt: 'bad' } }, {}],
    [{ ...review, reviewAccess: { active: true, expiresAt: '2020-01-01T00:00:00.000Z' } }, {}],
    [review, { platform: 'ios' }], [review, { env: { ...environment, review: false } }]]) {
    const copy = summary(value, options); assert.match(copy, /Status unavailable/);
    assert.doesNotMatch(copy, /Reviewer Pro access|verified through|Pro · Active/);
  }
  assert.match(summary({ ...paid, provider: 'apple' }, { platform: 'ios' }), /Your Pro access is verified through Apple\./);
  assert.match(summary(paid), /Your Pro access is verified through Google Play\./);
});

test('a cached reviewer grant expires without paid-provider fallback and a fresh refresh clears its old confirmation', async () => {
  const h = controller(); await h.c.restore();
  assert.match(h.state().notice, /^Reviewer Pro access/);
  clock = Date.parse(expiresAt) + 1;
  assert.equal(purchases.reviewerAccess(h.state().subscription, true), null);
  const tree = SubscriptionPanel({ role: 'cafe_owner_manager', subscription: h.state().subscription, product, busy: false,
    notice: h.state().notice, reviewAccessEnabled: true });
  assert.match(text(tree), /Reviewer access ended/);
  assert.doesNotMatch(text(tree), /Your Pro access is active|Reviewer Pro access is confirmed|verified through/);
  const actions = nodes(tree).filter(value => value.type === 'action').map(value => value.props.label);
  assert.ok(actions.includes('Check access status')); assert.ok(!actions.some(label => label.startsWith('Subscribe')));
  assert.match(summary(h.state().subscription), /Status unavailable/);
  h.setStatus(expired); await h.c.manage('google');
  assert.equal(h.state().notice, ''); assert.equal(h.state().subscription.access, 'free');
});

test('a mounted reviewer plans controller refreshes at expiry and cancels the timer on disposal or account replacement', async () => {
  const h = controller(); await h.c.load(); assert.equal(timers.size, 1);
  h.setStatus(expired); clock = Date.parse(expiresAt) + 1; fireDueTimers();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.state().subscription.access, 'free'); assert.equal(h.state().notice, ''); assert.equal(timers.size, 0);
  clock = Date.now();
  const disposed = controller(); await disposed.c.load(); assert.equal(timers.size, 1);
  disposed.c.dispose(); assert.equal(timers.size, 0);
  const changed = controller(); await changed.c.load(); assert.equal(timers.size, 1);
  changed.setAccount({ id: 'other-account', role: 'cafe_owner_manager' }); await changed.c.load();
  assert.equal(timers.size, 0); assert.equal(changed.state().subscription, null);
});

test('mounted Settings summary schedules an expiry rerender and does not retain active reviewer copy afterward', () => {
  let rerenders = 0;
  assert.match(summary(review, { expiryChanged: () => { rerenders++; } }), /Reviewer Pro access/);
  clock = Date.parse(expiresAt) + 1; fireDueTimers(); assert.equal(rerenders, 1);
  assert.match(summary(review), /Status unavailable/);
  assert.doesNotMatch(summary(review), /Reviewer Pro access|verified through|Pro · Active/);
});

test('a delayed old expiry callback cannot overwrite a freshly renewed reviewer grant', async () => {
  let holdNext = false, release;
  const gate = new Promise(resolve => { release = resolve; });
  const h = controller({ readAccount: current => {
    if (holdNext) { holdNext = false; return gate; }
    return current;
  } });
  await h.c.load(); clock = Date.parse(expiresAt) + 1; holdNext = true; fireDueTimers();
  const renewed = { ...review, reviewAccess: { active: true, expiresAt: new Date(clock + 86400000).toISOString() } };
  h.setStatus(renewed); await h.c.load();
  release({ id: free.accountId, role: 'cafe_owner_manager' }); await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.state().subscription.reviewAccess.expiresAt, renewed.reviewAccess.expiresAt);
  assert.equal(h.state().notice, ''); assert.equal(h.calls.filter(path => path.endsWith('status')).length, 2);
});

test('an account-read failure at expiry is caught, fails closed and cannot overwrite a renewed grant', async () => {
  for (const renew of [false, true]) {
    let holdNext = false, reject;
    const gate = new Promise((resolve, fail) => { reject = fail; });
    const h = controller({ readAccount: current => {
      if (holdNext) { holdNext = false; return gate; }
      return current;
    } });
    clock = Date.now(); await h.c.load(); clock = Date.parse(expiresAt) + 1; holdNext = true; fireDueTimers();
    const renewed = { ...review, reviewAccess: { active: true, expiresAt: new Date(clock + 86400000).toISOString() } };
    if (renew) { h.setStatus(renewed); await h.c.load(); }
    reject(Error('private storage failure')); await new Promise(resolve => setImmediate(resolve));
    if (renew) {
      assert.equal(h.state().subscription.reviewAccess.expiresAt, renewed.reviewAccess.expiresAt);
      assert.equal(h.state().notice, ''); assert.equal(h.state().error, '');
    } else {
      assert.equal(h.state().product, null); assert.match(h.state().notice, /^Reviewer access has ended/);
      assert.match(h.state().error, /could not confirm current access/); assert.doesNotMatch(h.state().error, /private storage/);
    }
    h.c.dispose();
  }
});

test('reviewer expiry timers handle long deadlines and cancellation without early expiration', () => {
  let expired = 0;
  const cancel = purchases.reviewerExpiryTimer(expiresAt, () => { expired++; });
  const first = [...timers][0]; assert.equal(first.at - clock, 2147483647);
  clock = first.at; fireDueTimers(); assert.equal(expired, 0); assert.equal(timers.size, 1);
  cancel(); clock = Date.parse(expiresAt) + 1; fireDueTimers(); assert.equal(expired, 0); assert.equal(timers.size, 0);
});

test('ordinary iOS summary and plans do not evaluate the Android environment accessor', () => {
  const environmentReader = () => { throw Error('iOS must not evaluate Android review configuration'); };
  assert.match(summary({ ...paid, provider: 'apple' }, { platform: 'ios', environmentReader }), /verified through Apple/);
  const effects = [], created = [];
  const { default: Screen } = load('mobile/features/native-subscription/NativeSubscriptionScreen.tsx', {
    react: { useCallback: callback => callback, useRef: value => ({ current: value }), useState: value => [value, () => {}] },
    'react/jsx-runtime': { jsx, jsxs: jsx },
    'react-native': { ...native, Platform: { OS: 'ios' }, AppState: { addEventListener: () => ({ remove() {} }) }, Alert: {}, Linking: {} },
    'react-native-safe-area-context': { SafeAreaView: 'safe' },
    'expo-router': { router: {}, useFocusEffect: callback => { effects.push(callback); } },
    'expo-web-browser': {}, '../../components/CafeAccessCheck': { CafeAccessCheck: () => null },
    '../../lib/useCafeAccess': { useCafeAccess: () => ({ ready: true, accountId: free.accountId }) },
    '../../lib/session': { getCurrentContext: async () => ({ user: { id: free.accountId }, role: 'cafe_owner_manager' }) },
    '../../lib/api': { authenticatedApi: async () => paid, requireAccountSession: async () => {} },
    './SubscriptionPanel': { SubscriptionPanel: props => ({ type: 'panel', props }) },
    './subscriptionController': { initialSubscriptionState: {}, SubscriptionController: class {
      constructor(deps) { created.push(deps); } load() {} dispose() {}
    } },
    '../approved-dashboard/theme': { dashboardTheme: {} },
    '../review-mode/environment': { getAppEnvironment: environmentReader }, './nativeBillingClient': client,
  });
  const tree = Screen({ createStore: () => null });
  assert.equal(nodes(tree).find(value => value.type === 'panel').props.reviewAccessEnabled, false);
  const cleanup = effects[0](); assert.equal(created[0].reviewAccessEnabled, false); cleanup();
});
