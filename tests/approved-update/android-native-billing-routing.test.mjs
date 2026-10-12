import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTypescript, plain } from './load-typescript.mjs';

const publicBase = 'https://baristamatch-android-baristamatch.vercel.app/api';
const live = { review: false, supabaseUrl: 'https://lmwqrxoitraofaftpwhe.supabase.co',
  publishableKey: 'sb_publishable_SYNTHETIC_PUBLIC', apiBase: 'https://www.baristajobmatch.com/api' };
const review = { review: true, supabaseUrl: 'https://ojvjlvojvozvhktbclcg.supabase.co',
  publishableKey: 'sb_publishable_SYNTHETIC_ANDROID_TEST', apiBase: 'https://android-testing.baristajobmatch.com/api' };
const appleReview = { review: true, supabaseUrl: 'https://iqtpsxxlpncaeabbcxht.supabase.co',
  publishableKey: 'sb_publishable_SYNTHETIC_APPLE_TEST', apiBase: 'https://testing.baristajobmatch.com/api' };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

function harness(options = {}) {
  const state = { environment: { ...(options.environment || live) }, pending: false, user: 'cafe-a',
    token: 'synthetic-account-a-jwt', sessionReads: 0, environmentReads: 0, requests: [], response: { verified: true } };
  const publicConfig = { EXPO_PUBLIC_ANDROID_PUBLIC_RELEASE: 'true',
    EXPO_PUBLIC_ANDROID_PUBLIC_SUPABASE_PUBLISHABLE_KEY: live.publishableKey, EXPO_PUBLIC_ANDROID_NATIVE_BILLING_API_BASE_URL: options.base === undefined ? publicBase : options.base };
  const request = async (url, init) => {
    state.requests.push({ url, init });
    if (options.request) return options.request(state);
    return state.response;
  };
  const api = loadTypescript('mobile/lib/api.ts', {
    './supabase': { APP_API_BASE: state.environment.apiBase, supabase: { auth: { getSession: async () => {
      state.sessionReads++;
      if (options.session) await options.session(state);
      return { data: { session: state.user ? { access_token: state.token, user: { id: state.user } } : null }, error: null };
    } } } }, './request': { requestJson: request },
  });
  const module = loadTypescript('mobile/lib/nativeBillingApi.ts', {
    'react-native': { Platform: { OS: options.platform || 'android' } }, './api': api, './request': { requestJson: request },
    '../features/review-mode/environment': {
      getAppEnvironment: () => { state.environmentReads++; if (options.forbidEnvironment) throw Error('Android environment must not be read'); return state.environment; },
      appEnvironmentChangePending: () => state.pending,
    },
  }, { process: { env: publicConfig } });
  return { state, publicConfig, ordinary: api.authenticatedApi, call: module.authenticatedNativeBillingApi };
}

test('public Android routes native status, checkout and receipts only to the explicitly configured billing origin', async () => {
  const h = harness();
  for (const [path, method, body] of [
    ['/native-billing?action=status', 'GET', {}],
    ['/native-billing?action=prepare', 'POST', { provider: 'google', productId: 'synthetic-pro', basePlanId: 'monthly-us', storefront: 'US' }],
    ['/native-billing?action=start', 'POST', { attemptId: 'synthetic-attempt', provider: 'google' }],
    ['/native-billing?action=cancel', 'POST', { attemptId: 'synthetic-attempt', reason: 'user-cancelled' }],
    ['/native-purchases', 'POST', { provider: 'google', proof: 'synthetic-proof' }],
  ]) {
    assert.equal(await h.call(path, body, method, 'cafe-a'), h.state.response);
    const request = h.state.requests.at(-1);
    assert.equal(request.url, `${publicBase}${path}`);
    assert.deepEqual(plain(request.init.headers), { Authorization: 'Bearer synthetic-account-a-jwt', 'Content-Type': 'application/json' });
    assert.equal(request.init.method, method);
    if (method === 'POST') assert.deepEqual(JSON.parse(request.init.body), body);
    else assert.equal(Object.hasOwn(request.init, 'body'), false);
  }
  assert.equal(h.state.sessionReads, 10);
});

test('ordinary marketplace, account deletion and Stripe management requests keep the existing public API', async () => {
  const h = harness();
  for (const path of ['/apply-job', '/send-message', '/delete-account', '/billing-status', '/create-portal-session']) {
    await h.ordinary(path, { synthetic: true }, 'POST', 'cafe-a');
    assert.equal(h.state.requests.at(-1).url, `${live.apiBase}${path}`);
  }
  assert.equal(h.state.environmentReads, 0);
});

test('iOS configured and Apple review calls retain the original transport without reading Android configuration', async () => {
  for (const environment of [live, appleReview]) {
    const h = harness({ platform: 'ios', environment, base: 'https://wrong.example.invalid/api', forbidEnvironment: true });
    await h.call('/native-billing?action=status', {}, 'GET', 'cafe-a');
    await h.call('/native-billing?action=resume', { attemptId: 'existing-apple-attempt' }, 'POST', 'cafe-a');
    assert.deepEqual(h.state.requests.map(r => r.url), [`${environment.apiBase}/native-billing?action=status`, `${environment.apiBase}/native-billing?action=resume`]);
    assert.equal(h.state.environmentReads, 0); assert.equal(h.state.sessionReads, 2);
  }
});

test('isolated Android Sandbox and reviewer requests retain their exact test origin and account JWT', async () => {
  for (const base of ['', publicBase, 'https://wrong.example.invalid/api']) {
    const h = harness({ environment: review, base });
    await h.call('/native-billing?action=status', {}, 'GET', 'cafe-a');
    await h.call('/native-purchases', { provider: 'google', proof: 'synthetic-proof' }, 'POST', 'cafe-a');
    assert.deepEqual(h.state.requests.map(r => r.url), [`${review.apiBase}/native-billing?action=status`, `${review.apiBase}/native-purchases`]);
    assert.equal(h.state.requests[0].init.headers.Authorization, 'Bearer synthetic-account-a-jwt');
  }
});

test('public Android missing or unapproved billing origins fail before reading credentials or requesting anything', async () => {
  for (const base of ['', ' ', 'http://baristamatch-android-baristamatch.vercel.app/api', `${publicBase}/`, `${publicBase}?x=1`,
    `${publicBase}#fragment`, 'https://baristamatch-android-other.vercel.app/api', 'https://baristamatch-android-baristamatch.vercel.app.evil.invalid/api',
    'https://user@baristamatch-android-baristamatch.vercel.app/api', live.apiBase, review.apiBase]) {
    const h = harness({ base });
    await assert.rejects(h.call('/native-billing?action=status', {}, 'GET', 'cafe-a'), /not configured/);
    assert.equal(h.state.sessionReads, 0); assert.equal(h.state.requests.length, 0);
  }
});

test('public Android rejects mismatched database, normal API and review connections before token access', async () => {
  for (const environment of [
    { ...live, supabaseUrl: review.supabaseUrl }, { ...live, supabaseUrl: appleReview.supabaseUrl },
    { ...live, supabaseUrl: `${live.supabaseUrl}/` }, { ...live, apiBase: publicBase }, { ...live, apiBase: review.apiBase },
    { ...live, apiBase: 'https://other.example.invalid/api' }, { ...live, review: true }, appleReview,
    { ...review, apiBase: live.apiBase }, { ...review, publishableKey: 'sb_secret_SYNTHETIC_NOT_A_CLIENT_KEY' },
  ]) {
    const h = harness({ environment });
    await assert.rejects(h.call('/native-billing?action=status', {}, 'GET', 'cafe-a'), /not configured/);
    assert.equal(h.state.sessionReads, 0); assert.equal(h.state.requests.length, 0);
  }
});

test('Android transport rejects unrelated, noncanonical and Apple-only routes before reading credentials', async () => {
  const h = harness();
  for (const [path, method] of [
    ['/billing-status', 'GET'], ['/delete-account', 'POST'], ['/create-portal-session', 'POST'], ['/native-billing', 'GET'],
    ['/native-billing?action=status&extra=1', 'GET'], ['/native-billing?action=status&action=prepare', 'GET'],
    ['/native-billing?action=resume', 'POST'], ['/native-billing?action=status', 'POST'], ['/native-billing?action=start', 'GET'],
    ['/native-purchases', 'GET'], ['/native-purchases?x=1', 'POST'], ['/native-purchases/../delete-account', 'POST'],
    ['https://wrong.example.invalid/native-purchases', 'POST'], ['/native-purchases#fragment', 'POST'], ['/native-purchases', 'DELETE'],
  ]) await assert.rejects(h.call(path, {}, method, 'cafe-a'), /not supported/);
  assert.equal(h.state.sessionReads, 0); assert.equal(h.state.requests.length, 0);
});

test('Android requires a reviewed account and rejects expired or changed sessions without a request', async () => {
  const h = harness();
  for (const account of [undefined, '']) await assert.rejects(h.call('/native-billing?action=status', {}, 'GET', account), /reopen your account/);
  assert.equal(h.state.sessionReads, 0);
  h.state.user = null;
  await assert.rejects(h.call('/native-billing?action=status', {}, 'GET', 'cafe-a'), /session expired/);
  h.state.user = 'cafe-b';
  await assert.rejects(h.call('/native-purchases', {}, 'POST', 'cafe-a'), /account changed/);
  assert.equal(h.state.requests.length, 0);
});

test('an account switch while session resolution is pending cannot send the previous account request', async () => {
  const pending = deferred(); const h = harness({ session: () => pending.promise });
  const result = h.call('/native-billing?action=prepare', {}, 'POST', 'cafe-a');
  h.state.user = 'cafe-b'; pending.resolve();
  await assert.rejects(result, /account changed/); assert.equal(h.state.requests.length, 0);
});

test('late responses cannot be accepted after an account switch or logout', async () => {
  for (const next of ['cafe-b', null]) {
    const pending = deferred(); const h = harness({ request: () => pending.promise });
    const result = h.call('/native-billing?action=status', {}, 'GET', 'cafe-a');
    while (!h.state.requests.length) await new Promise(r => setImmediate(r));
    h.state.user = next; pending.resolve({ verified: true, accountId: 'cafe-a' });
    await assert.rejects(result, /account changed|session expired/);
  }
});

test('a pending mode switch blocks Android token access immediately', async () => {
  const h = harness(); h.state.pending = true;
  await assert.rejects(h.call('/native-billing?action=status', {}, 'GET', 'cafe-a'), /connection is changing/);
  assert.equal(h.state.sessionReads, 0); assert.equal(h.state.requests.length, 0);
});

test('mode switch, environment replacement and configuration mutation during session resolution cannot send', async () => {
  for (const change of [
    h => { h.state.pending = true; }, h => { h.state.environment = { ...h.state.environment }; },
    h => { h.state.environment.apiBase = review.apiBase; }, h => { h.state.environment.publishableKey = 'changed-public-key'; },
    h => { h.publicConfig.EXPO_PUBLIC_ANDROID_NATIVE_BILLING_API_BASE_URL = review.apiBase; },
  ]) {
    const pending = deferred(); const h = harness({ session: () => pending.promise });
    const result = h.call('/native-billing?action=start', {}, 'POST', 'cafe-a');
    change(h); pending.resolve();
    await assert.rejects(result, /connection changed/); assert.equal(h.state.requests.length, 0);
  }
});

test('public and isolated review responses are rejected if the app begins switching environments in flight', async () => {
  for (const environment of [live, review]) {
    const pending = deferred(); const h = harness({ environment, request: () => pending.promise });
    const result = h.call('/native-billing?action=status', {}, 'GET', 'cafe-a');
    while (!h.state.requests.length) await new Promise(r => setImmediate(r));
    h.state.pending = true; pending.resolve({ verified: true });
    await assert.rejects(result, /connection changed/);
  }
});

test('a mode switch during the final account check cannot release a late response', async () => {
  const pending = deferred(); const h = harness({ session: state => state.sessionReads === 2 ? pending.promise : undefined });
  const result = h.call('/native-billing?action=status', {}, 'GET', 'cafe-a');
  while (h.state.sessionReads !== 2) await new Promise(r => setImmediate(r));
  h.state.pending = true; pending.resolve();
  await assert.rejects(result, /connection changed/);
});

test('the environment change guard includes sign-out and storage awaits, then preserves restart-required state', async () => {
  const { createEnvironmentController } = loadTypescript('mobile/features/review-mode/environmentController.ts');
  const signedOut = deferred(), saved = deferred();
  const controller = createEnvironmentController({ getItem: async () => null, setItem: () => saved.promise }, live, review);
  await controller.initialize(); assert.equal(controller.changePending(), false);
  const switching = controller.switchMode('review', () => signedOut.promise, async () => {});
  assert.equal(controller.changePending(), true); assert.equal(controller.restartRequired(), false);
  signedOut.resolve(true); await Promise.resolve();
  assert.equal(controller.changePending(), true); assert.equal(controller.restartRequired(), false);
  saved.resolve(); await switching;
  assert.equal(controller.changePending(), true); assert.equal(controller.restartRequired(), true);
  assert.equal(controller.get().supabaseUrl, live.supabaseUrl);
});

test('failed sign-out or mode storage does not leave the new read-only change guard stuck', async () => {
  const { createEnvironmentController } = loadTypescript('mobile/features/review-mode/environmentController.ts');
  for (const failStorage of [false, true]) {
    const controller = createEnvironmentController({ getItem: async () => null, setItem: async () => { throw Error('synthetic-save-error'); } }, live, review);
    await controller.initialize();
    await assert.rejects(controller.switchMode('review', async () => failStorage, async () => {}), /Sign out|synthetic-save-error/);
    assert.equal(controller.changePending(), false); assert.equal(controller.restartRequired(), false);
  }
});

test('the subscription screen injects split billing calls while Stripe management keeps the ordinary API', async () => {
  const billing = async () => {}, ordinaryCalls = []; let dependencies;
  const ordinary = async (...args) => { ordinaryCalls.push(args); return { url: 'https://billing.stripe.com/synthetic-portal' }; };
  const { default: Screen } = loadTypescript('mobile/features/native-subscription/NativeSubscriptionScreen.tsx', {
    react: { useCallback: f => f, useRef: current => ({ current }), useState: initial => [initial, () => {}] },
    'react/jsx-runtime': { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) },
    'react-native': { Platform: { OS: 'android' }, Alert: {}, Linking: {}, AppState: { addEventListener: () => ({ remove() {} }) } },
    'react-native-safe-area-context': { SafeAreaView: 'safe-area' },
    'expo-router': { router: {}, useFocusEffect: effect => effect() }, 'expo-web-browser': { openBrowserAsync: async () => {} },
    '../../components/CafeAccessCheck': { CafeAccessCheck: 'access-check' },
    '../../lib/useCafeAccess': { useCafeAccess: () => ({ ready: true, accountId: 'cafe-a' }) },
    '../../lib/session': { getCurrentContext: async () => ({ user: { id: 'cafe-a' }, role: 'cafe_owner_manager' }) },
    '../../lib/api': { authenticatedApi: ordinary, requireAccountSession: async account => assert.equal(account, 'cafe-a') },
    '../../lib/legalLinks': { privacyPolicyUrl: () => 'https://baristamatch-android-baristamatch.vercel.app/android-privacy' },
    '../../lib/nativeBillingApi': { authenticatedNativeBillingApi: billing }, './SubscriptionPanel': { SubscriptionPanel: 'panel' },
    './subscriptionController': { initialSubscriptionState: {}, SubscriptionController: class { constructor(value) { dependencies = value; } async load() {} } },
    '../approved-dashboard/theme': { dashboardTheme: { background: 'white' } },
    '../review-mode/environment': { getAppEnvironment: () => live }, './nativeBillingClient': { androidReviewerAccessEnabled: () => false },
  }, { URL });
  const accountScreen = Screen({ createStore: () => null }); accountScreen.type(accountScreen.props);
  assert.equal(dependencies.call, billing);
  await dependencies.openManagement('stripe', 'cafe-a');
  assert.deepEqual(plain(ordinaryCalls), [['/create-portal-session', { channel: 'mobile' }, 'POST', 'cafe-a']]);
});

test('public Android missing release flag or dedicated key fails before any credential access', async () => {
  for (const [name, value] of [
    ['EXPO_PUBLIC_ANDROID_PUBLIC_RELEASE', undefined], ['EXPO_PUBLIC_ANDROID_PUBLIC_RELEASE', 'false'],
    ['EXPO_PUBLIC_ANDROID_PUBLIC_SUPABASE_PUBLISHABLE_KEY', undefined],
    ['EXPO_PUBLIC_ANDROID_PUBLIC_SUPABASE_PUBLISHABLE_KEY', 'sb_secret_SYNTHETIC'],
    ['EXPO_PUBLIC_ANDROID_PUBLIC_SUPABASE_PUBLISHABLE_KEY', 'sb_publishable_OTHER_PROJECT'],
  ]) {
    const h = harness(); h.publicConfig[name] = value;
    await assert.rejects(h.call('/native-billing?action=status', {}, 'GET', 'cafe-a'), /not configured/);
    assert.equal(h.state.sessionReads, 0); assert.equal(h.state.requests.length, 0);
  }
});

test('public Android rejects late status when compiled public flag or key changes in flight', async () => {
  for (const name of ['EXPO_PUBLIC_ANDROID_PUBLIC_RELEASE', 'EXPO_PUBLIC_ANDROID_PUBLIC_SUPABASE_PUBLISHABLE_KEY']) {
    const gate = deferred(); const h = harness({ request: () => gate.promise });
    const pending = h.call('/native-billing?action=status', {}, 'GET', 'cafe-a'); await Promise.resolve(); await Promise.resolve();
    h.publicConfig[name] = 'changed'; gate.resolve({ verified: true });
    await assert.rejects(pending, /connection changed/);
  }
});
