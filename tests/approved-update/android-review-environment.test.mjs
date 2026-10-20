import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTypescript, plain } from './load-typescript.mjs';

const policy = loadTypescript('mobile/features/review-mode/environmentController.ts');
const androidKeyName = 'EXPO_PUBLIC_ANDROID_TEST_SUPABASE_PUBLISHABLE_KEY';
const androidPublicKey = 'sb_publishable_SYNTHETIC_ANDROID_TEST_ONLY';
const android = { review: true, supabaseUrl: 'https://ojvjlvojvozvhktbclcg.supabase.co',
  publishableKey: androidPublicKey, apiBase: 'https://android-testing.baristajobmatch.com/api' };
const apple = { review: true, supabaseUrl: 'https://iqtpsxxlpncaeabbcxht.supabase.co',
  publishableKey: 'sb_publishable_470rDNz5G4PrUD5mvMu4Eg_LPcLOM4x', apiBase: 'https://testing.baristajobmatch.com/api' };
const live = { review: false, supabaseUrl: 'https://production.example.invalid',
  publishableKey: 'synthetic-generic-production-public', apiBase: 'https://production.example.invalid/api' };
const configuredEnv = connection => ({ EXPO_PUBLIC_SUPABASE_URL: connection.supabaseUrl,
  EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: connection.publishableKey, EXPO_PUBLIC_API_BASE_URL: connection.apiBase });
const androidEnv = { ...configuredEnv(android), EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: live.publishableKey,
  EXPO_PUBLIC_GOOGLE_PLAY_LICENSE_TESTING: 'true', [androidKeyName]: androidPublicKey };

function harness(platform, env, saved = null) {
  const calls = [];
  const module = loadTypescript('mobile/features/review-mode/environment.ts', {
    '@react-native-async-storage/async-storage': { default: { getItem: async () => { calls.push('read-mode'); return saved; },
      setItem: async () => { calls.push('write-mode'); } } },
    'expo': { reloadAppAsync: async () => { calls.push('reload'); } },
    'react-native': { Platform: { OS: platform } }, './environmentController': policy,
  }, { process: { env } });
  return { module, calls };
}

test('Android review client receives only its dedicated connection even when the generic key is production', async () => {
  const h = harness('android', androidEnv);
  const created = [];
  const client = loadTypescript('mobile/lib/supabase.ts', {
    '@react-native-async-storage/async-storage': { default: {} },
    '@supabase/supabase-js': { createClient: (...args) => { created.push(args); return { auth: {} }; }, processLock: 'synthetic-lock' },
    'react-native': { Platform: { OS: 'android' }, AppState: { addEventListener: () => {} } },
    './request': { fetchWithTimeout: 'synthetic-no-network' },
    './authStorage': { createLockedAuthStorage: () => ({ storage: 'synthetic-storage', runExclusive: fn => fn() }) },
    '../features/review-mode/environment': h.module,
  }, { URL });
  await client.initializeSupabaseEnvironment();
  assert.deepEqual(plain(h.module.getAppEnvironment()), android);
  assert.equal(created.length, 1); assert.equal(created[0][0], android.supabaseUrl); assert.equal(created[0][1], androidPublicKey);
  assert.equal(client.APP_API_BASE, android.apiBase); assert.equal(client.AUTH_API_BASE, `${android.supabaseUrl}/auth/v1`);
  assert.equal(h.module.canReturnToLive(), false);
  assert.equal(h.module.getPasswordResetRedirect(), 'https://android-testing.baristajobmatch.com/reset-password');
  assert.equal(h.module.getMobileAuthWebBridge(), 'https://android-testing.baristajobmatch.com/mobile-auth-callback.html');
  await assert.rejects(h.module.switchAppMode('configured', async () => true), /no live account connection/);
  assert.deepEqual(h.calls, ['read-mode']);
});

test('Android review fails before client initialization for missing, generic, secret-format or Apple keys', () => {
  for (const key of [undefined, '', 'sb_secret_SYNTHETIC_NEVER_CLIENT', apple.publishableKey]) {
    assert.throws(() => harness('android', { ...androidEnv, [androidKeyName]: key,
      EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: androidPublicKey }), /dedicated test API, database and publishable key/);
  }
});

test('Android rejects the Apple review connection and mixed test/live endpoint pairs', () => {
  for (const env of [
    configuredEnv(apple), { ...androidEnv, ...configuredEnv(live) },
    { ...androidEnv, EXPO_PUBLIC_API_BASE_URL: apple.apiBase },
    { ...androidEnv, EXPO_PUBLIC_SUPABASE_URL: apple.supabaseUrl },
    { ...androidEnv, EXPO_PUBLIC_API_BASE_URL: live.apiBase },
    { ...androidEnv, EXPO_PUBLIC_SUPABASE_URL: live.supabaseUrl },
  ]) assert.throws(() => harness('android', env), /Apple test|dedicated test|isolated test API/);
});

test('a saved Android review mode targets the dedicated connection, never the Apple connection', async () => {
  const h = harness('android', { ...configuredEnv(live), [androidKeyName]: androidPublicKey }, 'review');
  assert.deepEqual(plain(await h.module.initializeAppEnvironment()), android);
  assert.equal(h.module.getPasswordResetRedirect(), 'https://android-testing.baristajobmatch.com/reset-password');
  assert.equal(h.module.getMobileAuthWebBridge(), 'https://android-testing.baristajobmatch.com/mobile-auth-callback.html');
  assert.deepEqual(h.calls, ['read-mode']);
  const missingKey = harness('android', configuredEnv(live), 'review');
  await assert.rejects(missingKey.module.initializeAppEnvironment(), /not configured/);
  assert.throws(missingKey.module.getAppEnvironment, /still opening/);
});

test('Apple configured and saved review modes retain their original connection without an Android key', async () => {
  for (const key of [undefined, androidPublicKey, 'ignored-on-ios']) {
    const configured = harness('ios', { ...configuredEnv(apple), [androidKeyName]: key });
    assert.deepEqual(plain(await configured.module.initializeAppEnvironment()), apple);
    assert.equal(configured.module.getPasswordResetRedirect(), 'https://www.baristajobmatch.com/reset-password');
    assert.equal(configured.module.getMobileAuthWebBridge(), 'https://www.baristajobmatch.com/mobile-auth-callback.html');
    assert.equal(configured.module.canReturnToLive(), false);
    const selected = harness('ios', { ...configuredEnv(live), [androidKeyName]: key }, 'review');
    assert.deepEqual(plain(await selected.module.initializeAppEnvironment()), apple);
    assert.equal(selected.module.getPasswordResetRedirect(), 'https://www.baristajobmatch.com/reset-password');
    assert.equal(selected.module.getMobileAuthWebBridge(), 'https://www.baristajobmatch.com/mobile-auth-callback.html');
    assert.deepEqual(selected.calls, ['read-mode']);
  }
});

test('normal Android and Apple configured live modes still use the original generic connection', async () => {
  for (const platform of ['android', 'ios']) {
    const h = harness(platform, configuredEnv(live));
    assert.deepEqual(plain(await h.module.initializeAppEnvironment()), live);
    assert.equal(h.module.getPasswordResetRedirect(), 'https://www.baristajobmatch.com/reset-password');
    assert.equal(h.module.getMobileAuthWebBridge(), 'https://www.baristajobmatch.com/mobile-auth-callback.html');
    assert.equal(h.module.canReturnToLive(), true); assert.deepEqual(h.calls, ['read-mode']);
  }
});
