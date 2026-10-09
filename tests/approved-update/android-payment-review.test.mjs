import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTypescript } from './load-typescript.mjs';

const timeout = { storeResponse: promise => promise };
const androidKeyName = 'EXPO_PUBLIC_ANDROID_TEST_SUPABASE_PUBLISHABLE_KEY';
const androidPublicKey = 'sb_publishable_SYNTHETIC_ANDROID_TEST_ONLY';
const guards = loadTypescript('mobile/features/review-mode/reviewPurchaseGuard.ts', { '../native-subscription/storeTimeout': timeout },
  { process: { env: { [androidKeyName]: androidPublicKey } } });
const isolated = {
  review: true, apiBase: 'https://android-testing.baristajobmatch.com/api', supabaseUrl: 'https://ojvjlvojvozvhktbclcg.supabase.co',
  publishableKey: androidPublicKey,
};
const appleIsolated = {
  review: true, apiBase: 'https://testing.baristajobmatch.com/api', supabaseUrl: 'https://iqtpsxxlpncaeabbcxht.supabase.co',
  publishableKey: 'sb_publishable_470rDNz5G4PrUD5mvMu4Eg_LPcLOM4x',
};
const googleRequest = { type: 'subs', request: { google: {
  skus: ['synthetic.monthly'], obfuscatedAccountId: 'synthetic-account', subscriptionOffers: [{ sku: 'synthetic.monthly', offerToken: 'synthetic-offer' }],
} } };
function sdkHarness() {
  const calls = [];
  const sdk = {
    initConnection: async () => { calls.push('connect'); return true; },
    endConnection: async () => { calls.push('disconnect'); },
    getAppTransactionIOS: async () => { calls.push('apple-proof'); return { environment: 'Sandbox', bundleId: 'com.baristajobmatch.app' }; },
    requestPurchase: async request => { calls.push(['purchase', request]); return 'requested'; },
    restorePurchases: async () => { calls.push('restore'); },
  };
  return { sdk, calls };
}

test('the explicit isolated Android test wrapper delegates Google subscription purchases and restoration', async () => {
  const h = sdkHarness();
  const store = guards.googleLicenseTestingStore(h.sdk, { enabled: true, platform: 'android', environment: isolated });
  assert.equal(await store.initConnection(), true);
  assert.equal(await store.requestPurchase(googleRequest), 'requested'); await store.restorePurchases();
  assert.deepEqual(h.calls, ['connect', ['purchase', googleRequest], 'restore']);
});

test('live, configured, absent flag, non-Android or mismatched connections cannot use the Google test wrapper', () => {
  const h = sdkHarness();
  for (const options of [
    { enabled: false, platform: 'android', environment: isolated },
    { platform: 'android', environment: isolated },
    { enabled: true, platform: 'ios', environment: isolated },
    { enabled: true, platform: 'android', environment: appleIsolated },
    ...['review', 'apiBase', 'supabaseUrl', 'publishableKey'].map(key => ({ enabled: true, platform: 'android', environment: { ...isolated, [key]: key === 'review' ? false : 'different' } })),
  ]) assert.throws(() => guards.googleLicenseTestingStore(h.sdk, options), /isolated Android test build/);
  assert.deepEqual(h.calls, []);
});

test('the Google wrapper rechecks isolation and rejects Apple or other purchase request shapes', async () => {
  const h = sdkHarness(), options = { enabled: true, platform: 'android', environment: { ...isolated } };
  const store = guards.googleLicenseTestingStore(h.sdk, options);
  for (const request of [{ type: 'in-app', request: googleRequest.request }, { type: 'subs', request: {} },
    { type: 'subs', request: { ...googleRequest.request, apple: { sku: 'synthetic.monthly' } } }]) {
    await assert.rejects(store.requestPurchase(request), /Google Play subscription/);
  }
  options.environment.review = false;
  await assert.rejects(store.initConnection(), /isolated Android test build/);
  await assert.rejects(store.requestPurchase(googleRequest), /isolated Android test build/);
  await assert.rejects(store.restorePurchases(), /isolated Android test build/);
  assert.deepEqual(h.calls, []);
});

test('the Google wrapper requires its explicit dedicated key and rejects an Apple or generic key fallback', () => {
  for (const key of [undefined, '', 'sb_secret_SYNTHETIC_NEVER_CLIENT', appleIsolated.publishableKey]) {
    const h = sdkHarness();
    const guard = loadTypescript('mobile/features/review-mode/reviewPurchaseGuard.ts', { '../native-subscription/storeTimeout': timeout },
      { process: { env: { [androidKeyName]: key, EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: androidPublicKey } } });
    assert.throws(() => guard.googleLicenseTestingStore(h.sdk, { enabled: true, platform: 'android', environment: isolated }), /isolated Android test build/);
    assert.deepEqual(h.calls, []);
  }
});

function entryHarness({ platform = 'android', environment = platform === 'ios' ? appleIsolated : isolated, flag } = {}) {
  const h = sdkHarness();
  const env = { EXPO_PUBLIC_NATIVE_SUBSCRIPTIONS_ENABLED: 'true', EXPO_PUBLIC_GOOGLE_PLAY_PRODUCT_ID: 'synthetic.monthly',
    EXPO_PUBLIC_GOOGLE_PLAY_BASE_PLAN_ID: 'monthly', ...(flag === undefined ? {} : { EXPO_PUBLIC_GOOGLE_PLAY_LICENSE_TESTING: flag }) };
  const catalog = loadTypescript('mobile/features/native-subscription/storeCatalog.ts', {}, { process: { env } });
  class Gateway { constructor(api, plan) { this.api = api; this.plan = plan; } }
  const entry = loadTypescript('mobile/features/native-subscription/ExpoSubscriptionEntry.tsx', {
    'react/jsx-runtime': { jsx: (type, props) => ({ type, props }) },
    'react-native': { Platform: { OS: platform } }, './NativeSubscriptionScreen': { default: 'native-subscriptions' },
    './expoStoreGateway': { ExpoStoreGateway: Gateway }, './storeCatalog': catalog,
    '../review-mode/environment': { getAppEnvironment: () => environment }, '../review-mode/reviewPurchaseGuard': guards,
    'expo-iap': h.sdk,
  }, { process: { env } });
  return { ...h, create: () => entry.default().props.createStore(() => {}) };
}

test('the actual Android entry requires the explicit flag for a Google review store', async () => {
  for (const flag of [undefined, 'false', 'TRUE']) assert.throws(() => entryHarness({ flag }).create(), /isolated Android test build/);
  const h = entryHarness({ flag: 'true' });
  const gateway = h.create(); assert.equal(gateway.plan.provider, 'google');
  await gateway.api.initConnection(); await gateway.api.requestPurchase(googleRequest); await gateway.api.restorePurchases();
  assert.deepEqual(h.calls, ['connect', ['purchase', googleRequest], 'restore']);
});

test('configured live Google subscriptions use their normal SDK and never enter the review wrapper', () => {
  for (const flag of [undefined, 'true']) {
    const h = entryHarness({ flag, environment: { ...isolated, review: false } });
    assert.equal(h.create().api, h.sdk);
  }
});

test('the Apple review entry still requires its native Sandbox installation proof', async () => {
  const h = entryHarness({ platform: 'ios', flag: 'true' });
  const gateway = h.create(); assert.equal(gateway.plan.provider, 'apple');
  await gateway.api.initConnection();
  assert.deepEqual(h.calls, ['connect', 'apple-proof']);
  h.sdk.getAppTransactionIOS = async () => ({ environment: 'Production', bundleId: 'com.baristajobmatch.app' });
  await assert.rejects(gateway.api.requestPurchase({ type: 'subs', request: { apple: { sku: gateway.plan.id } } }), /Sandbox installation/);
  assert.deepEqual(h.calls, ['connect', 'apple-proof']);
});
