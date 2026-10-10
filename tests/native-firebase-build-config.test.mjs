import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const app = JSON.parse(fs.readFileSync(new URL('../mobile/app.json', import.meta.url))).expo;
const source = fs.readFileSync(new URL('../mobile/app.config.js', import.meta.url), 'utf8');
const valid = {
  project_info: { project_number: '123456789', project_id: 'synthetic-test-only' },
  client: [{ client_info: { mobilesdk_app_id: '1:123456789:android:synthetic', android_client_info: { package_name: 'com.baristajobmatch.app' } }, api_key: [{ current_key: 'synthetic-public-client-key' }] }],
};
const production = { EAS_BUILD_PROFILE: 'production', EAS_BUILD_PLATFORM: 'android' };
const eas = JSON.parse(fs.readFileSync(new URL('../mobile/eas.json', import.meta.url), 'utf8'));
const androidKeyName = 'EXPO_PUBLIC_ANDROID_TEST_SUPABASE_PUBLISHABLE_KEY';
const androidPublicKey = 'sb_publishable_SYNTHETIC_ANDROID_TEST_ONLY';
const androidLocal = { ...eas.build['android-payment-review'].env, [androidKeyName]: androidPublicKey };
const androidReview = { ...androidLocal, EAS_BUILD_PROFILE: 'android-payment-review', EAS_BUILD_PLATFORM: 'android' };
function resolveConfig(env = {}, files = {}) {
  const module = { exports: {} };
  vm.runInNewContext(source, { module, __dirname: '/project/mobile', process: { env }, require(name) {
    if (name === 'node:path') return path;
    if (name === 'node:fs') return { existsSync: filename => Object.hasOwn(files, filename), readFileSync: filename => { if (!(filename in files)) throw new Error('missing'); return files[filename]; } };
    throw new Error(`Unexpected import ${name}`);
  } });
  return module.exports({ config: app });
}

test('production Android requires a real Firebase client file while iOS and local config remain unaffected', () => {
  assert.throws(() => resolveConfig(production), /Production Android push notifications require GOOGLE_SERVICES_JSON/);
  assert.equal(resolveConfig(), app);
  assert.equal(resolveConfig({ ...production, EAS_BUILD_PROFILE: 'preview' }), app);
  assert.equal(resolveConfig({ ...production, EAS_BUILD_PLATFORM: 'ios', GOOGLE_SERVICES_JSON: '/missing-android-file' }), app);
});

test('EAS file configuration preserves Expo settings and includes only its file path', () => {
  const result = resolveConfig({ ...production, GOOGLE_SERVICES_JSON: '/eas/files/google-services.json' }, { '/eas/files/google-services.json': JSON.stringify(valid) });
  assert.equal(result.android.googleServicesFile, '/eas/files/google-services.json');
  assert.equal(result.android.package, app.android.package);
  assert.deepEqual(result.extra, app.extra);
  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes('synthetic-public-client-key')); assert.ok(!serialized.includes('synthetic-test-only'));
  assert.equal(app.android.googleServicesFile, undefined);
});

test('a reviewed local client file is supported and an explicit EAS file takes precedence', () => {
  const files = { '/project/mobile/google-services.json': JSON.stringify(valid), '/eas/selected.json': JSON.stringify(valid) };
  assert.equal(resolveConfig(production, files).android.googleServicesFile, '/project/mobile/google-services.json');
  assert.equal(resolveConfig({ ...production, GOOGLE_SERVICES_JSON: '/eas/selected.json' }, files).android.googleServicesFile, '/eas/selected.json');
  assert.throws(() => resolveConfig({ ...production, GOOGLE_SERVICES_JSON: '/missing.json' }, files), /could not be read as JSON/);
});

test('missing files, invalid JSON and a Firebase service account key fail without exposing file contents', () => {
  for (const value of [undefined, '{ invalid', JSON.stringify({ type: 'service_account', private_key: 'synthetic-private-value', project_id: 'synthetic-test-only' })]) {
    const files = value === undefined ? {} : { '/eas/client.json': value };
    assert.throws(() => resolveConfig({ ...production, GOOGLE_SERVICES_JSON: '/eas/client.json' }, files), error => {
      assert.ok(!error.message.includes('synthetic-private-value')); assert.ok(!error.message.includes('synthetic-test-only')); return true;
    });
  }
});

test('a different Android package or incomplete matching client cannot pass the production build check', () => {
  const wrong = structuredClone(valid); wrong.client[0].client_info.android_client_info.package_name = 'com.example.other';
  assert.throws(() => resolveConfig({ ...production, GOOGLE_SERVICES_JSON: '/eas/client.json' }, { '/eas/client.json': JSON.stringify(wrong) }), /no client for com.baristajobmatch.app/);
  for (const mutate of [data => { delete data.project_info.project_id; }, data => { delete data.project_info.project_number; }, data => { delete data.client[0].client_info.mobilesdk_app_id; }, data => { data.client[0].api_key = []; }]) {
    const incomplete = structuredClone(valid); mutate(incomplete);
    assert.throws(() => resolveConfig({ ...production, GOOGLE_SERVICES_JSON: '/eas/client.json' }, { '/eas/client.json': JSON.stringify(incomplete) }), /configuration is incomplete/);
  }
});

test('the Android license-testing profile is a separate isolated Play store build', () => {
  const profile = eas.build['android-payment-review'];
  assert.equal(profile.extends, 'production'); assert.equal(profile.environment, 'preview');
  assert.equal(profile.distribution, 'store'); assert.equal(profile.android.buildType, 'app-bundle');
  for (const name of ['EXPO_NO_DOTENV', 'EXPO_PUBLIC_NATIVE_SUBSCRIPTIONS_ENABLED']) {
    assert.equal(profile.env[name], eas.build['payment-review'].env[name]);
  }
  assert.equal(profile.env.EXPO_PUBLIC_API_BASE_URL, 'https://android-testing.baristajobmatch.com/api');
  assert.equal(profile.env.EXPO_PUBLIC_SUPABASE_URL, 'https://ojvjlvojvozvhktbclcg.supabase.co');
  assert.equal(profile.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY, undefined);
  assert.equal(profile.env[androidKeyName], undefined); // Supplied explicitly through EAS preview.
  assert.equal(eas.build['payment-review'].env.EXPO_PUBLIC_API_BASE_URL, 'https://testing.baristajobmatch.com/api');
  assert.equal(eas.build['payment-review'].env.EXPO_PUBLIC_SUPABASE_URL, 'https://iqtpsxxlpncaeabbcxht.supabase.co');
  assert.equal(eas.build['payment-review'].env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY, 'sb_publishable_470rDNz5G4PrUD5mvMu4Eg_LPcLOM4x');
  assert.equal(profile.env.EXPO_PUBLIC_GOOGLE_PLAY_LICENSE_TESTING, 'true');
  assert.equal(eas.build['payment-review'].env.EXPO_PUBLIC_GOOGLE_PLAY_LICENSE_TESTING, undefined);
  assert.equal(eas.build.production.env?.EXPO_PUBLIC_GOOGLE_PLAY_LICENSE_TESTING, undefined);
});

test('known builder metadata rejects license testing in another profile or platform', () => {
  for (const changes of [
    { EAS_BUILD_PROFILE: 'production' }, { EAS_BUILD_PROFILE: 'preview' }, { EAS_BUILD_PROFILE: 'payment-review' },
    { EAS_BUILD_PROFILE: undefined }, { EAS_BUILD_PLATFORM: 'ios' }, { EAS_BUILD_PLATFORM: undefined },
    { EXPO_PUBLIC_GOOGLE_PLAY_LICENSE_TESTING: undefined }, { EXPO_PUBLIC_GOOGLE_PLAY_LICENSE_TESTING: 'false' },
  ]) assert.throws(() => resolveConfig({ ...androidReview, ...changes }), /android-payment-review profile and Android platform/);
  assert.throws(() => resolveConfig({ EXPO_PUBLIC_GOOGLE_PLAY_LICENSE_TESTING: 'TRUE' }), /must be true only/);
  assert.throws(() => resolveConfig({ ...eas.build['android-payment-review'].env, EAS_BUILD: 'true' }), /android-payment-review profile and Android platform/);
});

test('EAS local resolution accepts the pinned profile env without unavailable builder metadata or secret files', () => {
  const localEnv = androidLocal;
  assert.equal(localEnv.EAS_BUILD_PROFILE, undefined); assert.equal(localEnv.EAS_BUILD_PLATFORM, undefined);
  assert.equal(resolveConfig(localEnv), app);
  assert.equal(resolveConfig({ ...localEnv, GOOGLE_SERVICES_JSON: '/eas/unavailable-secret-file.json' }), app);
  assert.throws(() => resolveConfig({ ...localEnv, EXPO_PUBLIC_GOOGLE_PLAY_LICENSE_TESTING: 'true', EXPO_PUBLIC_API_BASE_URL: 'https://www.baristajobmatch.com/api' }), /pinned isolated/);
  const configured = resolveConfig({ ...localEnv, GOOGLE_SERVICES_JSON: '/local/google-services.json' }, { '/local/google-services.json': JSON.stringify(valid) });
  assert.equal(configured.android.googleServicesFile, '/local/google-services.json');
});

test('both local and remote license-testing config reject live, missing or changed isolated connections', () => {
  for (const env of [androidReview, androidLocal]) {
    for (const name of ['EXPO_NO_DOTENV', 'EXPO_PUBLIC_API_BASE_URL', 'EXPO_PUBLIC_SUPABASE_URL', androidKeyName, 'EXPO_PUBLIC_NATIVE_SUBSCRIPTIONS_ENABLED']) {
      for (const value of [undefined, 'unexpected']) {
        assert.throws(() => resolveConfig({ ...env, [name]: value }), /pinned isolated test API and database/);
      }
    }
  }
  assert.throws(() => resolveConfig({ ...androidReview, EXPO_PUBLIC_API_BASE_URL: 'https://www.baristajobmatch.com/api' }), /pinned isolated/);
});

test('the Android build cannot reuse the Apple key or silently use a generic key', () => {
  for (const key of [undefined, '', 'sb_secret_SYNTHETIC_NEVER_CLIENT', eas.build['payment-review'].env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY]) {
    assert.throws(() => resolveConfig({ ...androidLocal, [androidKeyName]: key,
      EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: androidPublicKey }), /pinned isolated/);
  }
  assert.equal(resolveConfig({ ...androidLocal, EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'generic-production-public' }), app);
  for (const name of ['EXPO_PUBLIC_API_BASE_URL', 'EXPO_PUBLIC_SUPABASE_URL']) {
    assert.throws(() => resolveConfig({ ...androidLocal, [name]: eas.build['payment-review'].env[name] }), /pinned isolated/);
  }
});

test('the Android license-testing build also requires the registered Firebase Android client file', () => {
  assert.throws(() => resolveConfig(androidReview), /Android payment-review push notifications require GOOGLE_SERVICES_JSON/);
  assert.throws(() => resolveConfig({ ...androidReview, GOOGLE_SERVICES_JSON: '/eas/unavailable-secret-file.json' }), /could not be read as JSON/);
  const result = resolveConfig({ ...androidReview, GOOGLE_SERVICES_JSON: '/eas/client.json' }, { '/eas/client.json': JSON.stringify(valid) });
  assert.equal(result.android.googleServicesFile, '/eas/client.json');
  const wrong = structuredClone(valid); wrong.client[0].client_info.android_client_info.package_name = 'com.example.other';
  assert.throws(() => resolveConfig({ ...androidReview, GOOGLE_SERVICES_JSON: '/eas/client.json' }, { '/eas/client.json': JSON.stringify(wrong) }), /no client for com.baristajobmatch.app/);
});
