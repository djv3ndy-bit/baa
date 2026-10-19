import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { loadTypescript, plain } from './load-typescript.mjs';

const app = JSON.parse(fs.readFileSync(new URL('../../mobile/app.json', import.meta.url))).expo;
const eas = JSON.parse(fs.readFileSync(new URL('../../mobile/eas.json', import.meta.url)));
const source = fs.readFileSync(new URL('../../mobile/app.config.js', import.meta.url), 'utf8');
const key = 'sb_publishable_SYNTHETIC_ANDROID_PUBLIC';
const testKey = 'sb_publishable_SYNTHETIC_ANDROID_TEST';
const local = { ...eas.build['android-public-internal'].env,
  EXPO_PUBLIC_ANDROID_PUBLIC_SUPABASE_PUBLISHABLE_KEY: key,
  EXPO_PUBLIC_ANDROID_TEST_SUPABASE_PUBLISHABLE_KEY: testKey };
const remote = { ...local, EAS_BUILD_PROFILE: 'android-public-internal', EAS_BUILD_PLATFORM: 'android' };
const firebase = { project_info: { project_id: 'baristamatch', project_number: '397053773139' },
  client: [{ client_info: { mobilesdk_app_id: '1:397053773139:android:a3317b8e561e596aea4da6',
    android_client_info: { package_name: 'com.baristajobmatch.app' } }, api_key: [{ current_key: 'synthetic-public-firebase-key' }] }] };
function config(env = local, data) {
  const module = { exports: {} }, files = data === undefined ? {} : { '/eas/firebase.json': JSON.stringify(data) };
  vm.runInNewContext(source, { module, __dirname: '/project/mobile', process: { env }, require(name) {
    if (name === 'node:path') return path;
    if (name === 'node:fs') return { existsSync: name => Object.hasOwn(files, name), readFileSync: name => { if (!Object.hasOwn(files, name)) throw Error(); return files[name]; } };
    throw Error('Unexpected dependency');
  } });
  return module.exports({ config: app });
}
const environmentController = loadTypescript('mobile/features/review-mode/environmentController.ts');
function environment(env = local, saved = null, platform = 'android') {
  const writes = [];
  const module = loadTypescript('mobile/features/review-mode/environment.ts', {
    '@react-native-async-storage/async-storage': { default: { getItem: async () => saved, setItem: async (k,v) => { writes.push([k,v]); saved=v; } } },
    expo: { reloadAppAsync: async () => {} }, 'react-native': { Platform: { OS: platform } }, './environmentController': environmentController,
  }, { process: { env } });
  return { module, writes };
}

test('dedicated public internal profile configures a store AAB without changing existing iOS/review profiles', () => {
  const p = eas.build['android-public-internal'];
  assert.equal(p.extends, 'production'); assert.equal(p.environment, 'production'); assert.equal(p.distribution, 'store');
  assert.equal(p.android.buildType, 'app-bundle'); assert.equal(p.ios, undefined);
  assert.equal(eas.cli.appVersionSource, 'remote'); assert.equal(eas.build.production.autoIncrement, true);
  assert.equal(eas.build.production.env, undefined); assert.equal(eas.build.production.ios.image, 'macos-sequoia-15.6-xcode-26.0');
  assert.equal(eas.build['android-payment-review'].environment, 'preview');
  assert.equal(eas.build['android-payment-review'].env.EXPO_PUBLIC_GOOGLE_PLAY_LICENSE_TESTING, 'true');
  assert.equal(eas.build['payment-review'].env.EXPO_PUBLIC_SUPABASE_URL, 'https://iqtpsxxlpncaeabbcxht.supabase.co');
  assert.deepEqual(eas.submit, { production: { ios: { ascAppId: '6807117736' } } });
  assert.equal(p.env.EXPO_PUBLIC_GOOGLE_PLAY_PRODUCT_ID, 'baristamatch_cafe_pro');
  assert.equal(p.env.EXPO_PUBLIC_GOOGLE_PLAY_BASE_PLAN_ID, 'monthly-us');
  assert.equal(p.env.EXPO_PUBLIC_GOOGLE_PLAY_LICENSE_TESTING, 'false');
  assert.equal(p.env.EXPO_PUBLIC_ANDROID_PUBLIC_SUPABASE_PUBLISHABLE_KEY, undefined);
});

test('local EAS public config resolves without builder-only file metadata; remote requires exact Firebase app', () => {
  const optimized = { ...app, plugins: [...app.plugins, './plugins/with-android-release-optimization.cjs'] };
  assert.deepEqual(JSON.parse(JSON.stringify(config(local))), optimized);
  assert.deepEqual(JSON.parse(JSON.stringify(config({ ...local, GOOGLE_SERVICES_JSON: '/builder-only/file' }))), optimized);
  assert.throws(() => config(remote), /Android public push notifications require GOOGLE_SERVICES_JSON/);
  assert.throws(() => config({ ...remote, GOOGLE_SERVICES_JSON: '/builder-only/file' }), /could not be read/);
  const result = config({ ...remote, GOOGLE_SERVICES_JSON: '/eas/firebase.json' }, firebase);
  assert.equal(result.android.googleServicesFile, '/eas/firebase.json'); assert.deepEqual(result.ios, app.ios);
  assert.deepEqual(result.extra, app.extra); assert.ok(!JSON.stringify(result).includes('synthetic-public-firebase-key'));
  for (const mutate of [f => f.project_info.project_id = 'other', f => f.project_info.project_number = '123',
    f => f.client[0].client_info.mobilesdk_app_id = '1:397053773139:android:other',
    f => f.client[0].client_info.android_client_info.package_name = 'other']) {
    const changed = structuredClone(firebase); mutate(changed);
    assert.throws(() => config({ ...remote, GOOGLE_SERVICES_JSON: '/eas/firebase.json' }, changed), /Firebase|no client/);
  }
});

test('public profile cannot run as iOS, review/another profile or with incomplete builder identity', () => {
  for (const change of [{ EAS_BUILD_PLATFORM: 'ios' }, { EAS_BUILD_PLATFORM: undefined },
    { EAS_BUILD_PROFILE: 'production' }, { EAS_BUILD_PROFILE: 'android-payment-review' }, { EAS_BUILD_PROFILE: undefined }]) {
    assert.throws(() => config({ ...remote, ...change }), /Android public build requires/);
  }
  assert.throws(() => config({ ...local, EAS_BUILD: 'true' }), /Android public build requires/);
  assert.throws(() => config({ EXPO_PUBLIC_ANDROID_PUBLIC_RELEASE: 'TRUE' }), /explicitly configured/);
});

test('every public build pin, safety flag and dedicated key is required before local packaging', () => {
  for (const name of Object.keys(local)) {
    for (const value of [undefined, 'wrong']) assert.throws(() => config({ ...local, [name]: value }), /Android public|license testing|direct FCM/);
  }
  for (const publicKey of [testKey, 'sb_secret_SYNTHETIC', eas.build['payment-review'].env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY]) {
    assert.throws(() => config({ ...local, EXPO_PUBLIC_ANDROID_PUBLIC_SUPABASE_PUBLISHABLE_KEY: publicKey }), /Android public build requires/);
  }
  assert.throws(() => config({ ...local, EXPO_PUBLIC_GOOGLE_PLAY_LICENSE_TESTING: 'true' }), /Android public build requires/);
});

test('fresh public Android startup uses shared marketplace and dedicated key, ignoring generic inherited preview keys', async () => {
  const h = environment({ ...local, EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_GENERIC_TEST_KEY' });
  assert.deepEqual(plain(await h.module.initializeAppEnvironment()), { review: false,
    supabaseUrl: local.EXPO_PUBLIC_SUPABASE_URL, apiBase: local.EXPO_PUBLIC_API_BASE_URL, publishableKey: key });
  assert.deepEqual(h.writes, []); assert.equal(h.module.canReturnToLive(), true);
  assert.equal(h.module.getPasswordResetRedirect(), 'https://www.baristajobmatch.com/reset-password');
});

test('saved reviewer mode never upgrades its test session into live; explicit signed-out exit restarts to public', async () => {
  const h = environment(local, 'review');
  const review = await h.module.initializeAppEnvironment();
  assert.equal(review.review, true); assert.equal(review.supabaseUrl, 'https://ojvjlvojvozvhktbclcg.supabase.co');
  assert.equal(review.publishableKey, testKey); assert.equal(h.module.getMobileAuthWebBridge(), 'https://android-testing.baristajobmatch.com/mobile-auth-callback.html');
  await assert.rejects(h.module.switchAppMode('configured', async () => false), /Sign out/);
  await h.module.switchAppMode('configured', async () => true);
  assert.equal(h.module.getAppEnvironment().review, true); assert.equal(h.module.appEnvironmentChangePending(), true);
  const restarted = environment(local, h.writes[0][1]); assert.equal((await restarted.module.initializeAppEnvironment()).review, false);
});

test('public runtime rejects mixed API/database/key and license-testing connections before initialization', () => {
  for (const change of [{ EXPO_PUBLIC_SUPABASE_URL: 'https://ojvjlvojvozvhktbclcg.supabase.co' },
    { EXPO_PUBLIC_API_BASE_URL: 'https://android-testing.baristajobmatch.com/api' },
    { EXPO_PUBLIC_ANDROID_NATIVE_BILLING_API_BASE_URL: local.EXPO_PUBLIC_API_BASE_URL },
    { EXPO_PUBLIC_ANDROID_PUBLIC_SUPABASE_PUBLISHABLE_KEY: testKey },
    { EXPO_PUBLIC_ANDROID_PUBLIC_SUPABASE_PUBLISHABLE_KEY: undefined },
    { EXPO_PUBLIC_ANDROID_TEST_SUPABASE_PUBLISHABLE_KEY: undefined }, { EXPO_PUBLIC_GOOGLE_PLAY_LICENSE_TESTING: 'true' }]) {
    assert.throws(() => environment({ ...local, ...change }), /public marketplace connection/);
  }
});

test('legal links use Android-only pages and preserve iOS website URLs', () => {
  for (const platform of ['android', 'ios', 'web']) {
    const legal = loadTypescript('mobile/lib/legalLinks.ts', { 'react-native': { Platform: { OS: platform } } });
    assert.equal(legal.privacyPolicyUrl(), platform === 'android'
      ? 'https://baristamatch-android-baristamatch.vercel.app/android-privacy' : 'https://www.baristajobmatch.com/privacy.html');
    assert.equal(legal.termsOfServiceUrl(), platform === 'android'
      ? 'https://baristamatch-android-baristamatch.vercel.app/android-terms' : 'https://www.baristajobmatch.com/terms.html');
  }
  for (const file of ['mobile/app/signup.tsx', 'mobile/app/settings.tsx', 'mobile/features/native-subscription/NativeSubscriptionScreen.tsx']) {
    assert.match(fs.readFileSync(new URL('../../'+file, import.meta.url), 'utf8'), /privacyPolicyUrl\(\)/);
    assert.match(fs.readFileSync(new URL('../../'+file, import.meta.url), 'utf8'), /termsOfServiceUrl\(\)/);
  }
});

test('public Android review-mode copy explains no-payment access while iOS text stays unchanged', () => {
  function copy(platform) {
    const jsx = (type, props) => ({ type, props });
    const react = { useState: v => [v, () => {}], useRef: v => ({ current: v }) };
    const native = { Platform: { OS: platform }, StyleSheet: { create: v => v }, Text: 'Text', ScrollView: 'ScrollView', Pressable: 'Pressable', ActivityIndicator: 'Spinner' };
    const screen = loadTypescript('mobile/app/review-mode.tsx', {
      react, 'react/jsx-runtime': { jsx, jsxs: jsx }, 'react-native': native,
      'expo-router': { router: {} }, '@/lib/supabase': { supabase: {} },
      '@/features/review-mode/environment': { getAppEnvironment: () => ({ review: false }), canReturnToLive: () => true, reviewRestartRequired: () => false, switchAppMode: async () => {} },
    }, { process: { env: { EXPO_PUBLIC_ANDROID_PUBLIC_RELEASE: 'true' } } });
    const text = n => Array.isArray(n) ? n.map(text).join(' ') : typeof n === 'string' ? n : n && typeof n === 'object' ? text(n.props?.children) : '';
    return text(screen.default());
  }
  assert.match(copy('android'), /Reviewer Pro access uses the dedicated review account and requires no payment/);
  assert.ok(!copy('android').includes('Apple'));
  assert.ok(copy('ios').includes('Apple test purchases require a Sandbox installation on iOS 16 or later. Changing app mode does not change your Apple purchase account.'));
});
