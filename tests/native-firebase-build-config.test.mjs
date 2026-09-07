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
