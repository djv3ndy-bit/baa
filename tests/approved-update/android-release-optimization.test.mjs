import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

const mobile = path.resolve(new URL('../../mobile/', import.meta.url).pathname);
const require = createRequire(path.join(mobile, 'package.json'));
const plugin = require('./plugins/with-android-release-optimization.cjs');
const { compileModsAsync } = require('expo/config-plugins');
const app = JSON.parse(fs.readFileSync(path.join(mobile, 'app.json'))).expo;
const eas = JSON.parse(fs.readFileSync(path.join(mobile, 'eas.json')));
const config = require('./app.config.js');
const template = name => execFileSync('tar', ['-xOzf', require.resolve('expo/template.tgz'), `package/android/${name}`], { encoding: 'utf8' });
const gradle = template('app/build.gradle');
const rules = template('app/proguard-rules.pro');
const optimizationPlugin = './plugins/with-android-release-optimization.cjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bjm-release-optimization-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('actual installed Expo54 release template uses R8 optimize and keeps app/consumer inputs intact', () => {
  const result = plugin.releaseGradle(gradle);
  assert.equal(result, gradle.replace('proguard-android.txt', 'proguard-android-optimize.txt'));
  assert.equal(plugin.releaseGradle(result), result);
  assert.match(result, /minifyEnabled enableMinifyInReleaseBuilds/);
  assert.match(result, /shrinkResources enableShrinkResources\.toBoolean\(\)/);
  assert.match(result, /proguardFiles getDefaultProguardFile\("proguard-android-optimize.txt"\), "proguard-rules.pro"/);
  assert.match(result, /autolinkLibrariesWithApp\(\)/);
  assert.equal(result.includes('-dontwarn'), false);
  assert.equal(result.includes('-keep class'), false);
});

test('unknown or ambiguous Gradle inputs fail visibly instead of silently leaving release unoptimized', () => {
  for (const value of [gradle.replace('proguard-android.txt', 'other.txt'), gradle.replace('android.enableMinifyInReleaseBuilds', 'changed'),
    gradle.replace('android.enableShrinkResourcesInReleaseBuilds', 'changed'), gradle.replace('minifyEnabled enableMinifyInReleaseBuilds', 'minifyEnabled false'),
    gradle.replace('shrinkResources enableShrinkResources.toBoolean()', 'shrinkResources false'),
    `${gradle}\nproguardFiles getDefaultProguardFile("proguard-android.txt"), "proguard-rules.pro"`]) {
    assert.throws(() => plugin.releaseGradle(value), /Review the Android release optimization/);
  }
});

test('installed expo-iap Gradle normalization preserves optimization and its exact Play dependency', () => {
  const iap = require(path.join(path.dirname(require.resolve('expo-iap/package.json')), 'plugin/build/withIAP.js'));
  const first = plugin.releaseGradle(iap.modifyAppBuildGradle(gradle, 'groovy', false, false));
  const second = iap.modifyAppBuildGradle(plugin.releaseGradle(gradle), 'groovy', false, false);
  assert.equal(first, second);
  assert.match(first, /io.github.hyochan.openiap:openiap-google:3\.5\.0/);
  assert.match(first, /shrinkResources = enableShrinkResources\.toBoolean\(\)/);
  assert.match(first, /minifyEnabled enableMinifyInReleaseBuilds/);
  assert.match(first, /proguard-android-optimize\.txt/);
});

test('release properties are idempotent without changing unrelated/debug/native packaging flags', () => {
  const unrelated = [{ type: 'comment', value: 'keep this' }, { type: 'property', key: 'org.gradle.jvmargs', value: '-Xmx4g' },
    { type: 'property', key: 'expo.useLegacyPackaging', value: 'false' }];
  const result = plugin.releaseProperties([...unrelated,
    { type: 'property', key: 'android.enableMinifyInReleaseBuilds', value: 'false' },
    { type: 'property', key: 'android.enableMinifyInReleaseBuilds', value: 'true' }]);
  assert.deepEqual(result.slice(0, unrelated.length), unrelated);
  for (const key of ['android.enableMinifyInReleaseBuilds', 'android.enableShrinkResourcesInReleaseBuilds']) {
    assert.deepEqual(result.filter(item => item.key === key), [{ type: 'property', key, value: 'true' }]);
  }
  assert.deepEqual(plugin.releaseProperties(result), result);
});

test('Expo record annotation fix appends one narrow rule while preserving all app rules byte for byte', () => {
  const existing = `${rules}\n-keep class com.example.ExistingReflection { *; }\n`;
  const result = plugin.releaseProguard(existing);
  assert.equal(result.slice(0, existing.length), existing);
  assert.equal(result.split(plugin.FIELD_ANNOTATION_KEEP).length - 1, 1);
  assert.equal(plugin.FIELD_ANNOTATION_KEEP, '-keep @interface expo.modules.kotlin.records.Field { *; }');
  assert.equal(plugin.releaseProguard(result), result);
  assert.equal(plugin.releaseProguard(`${existing}\t${plugin.FIELD_ANNOTATION_KEEP}\r\n`), `${existing}\t${plugin.FIELD_ANNOTATION_KEEP}\r\n`);
  assert.equal(plugin.releaseProguard('# existing rule without final newline').startsWith('# existing rule without final newline\n'), true);
  assert.equal(result.includes('-keep class expo.modules.**'), false);
  assert.equal(result.includes('-dontwarn'), false);
  assert.equal(result.includes('-dontoptimize'), false);
});

test('annotation keep writer requires the generated app rule file and never replaces an absent one', async t => {
  const root = fixture(t), platform = path.join(root, 'android');
  await assert.rejects(plugin.writeFieldAnnotationKeep(platform), { code: 'ENOENT' });
  assert.equal(fs.existsSync(path.join(platform, 'app/proguard-rules.pro')), false);
});

test('real Expo Android mods write repeatable release settings and preserve existing keep rules; no iOS mods', async t => {
  const root = fixture(t);
  fs.mkdirSync(path.join(root, 'android/app'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"synthetic-optimization","version":"1.0.0"}');
  fs.writeFileSync(path.join(root, 'android/gradle.properties'), 'org.gradle.jvmargs=-Xmx4g\n');
  fs.writeFileSync(path.join(root, 'android/app/build.gradle'), gradle);
  fs.writeFileSync(path.join(root, 'android/app/proguard-rules.pro'), `${rules}\n-keep class com.example.ExistingReflection { *; }\n`);
  const originalRules = fs.readFileSync(path.join(root, 'android/app/proguard-rules.pro'), 'utf8');
  const configured = plugin(structuredClone(app));
  assert.deepEqual(Object.keys(configured.mods), ['android']);
  assert.deepEqual(configured.ios, app.ios);
  for (let run = 0; run < 2; run++) await compileModsAsync(plugin(structuredClone(app)), { projectRoot: root, platforms: ['android'] });
  const properties = fs.readFileSync(path.join(root, 'android/gradle.properties'), 'utf8');
  assert.match(properties, /android.enableMinifyInReleaseBuilds=true/);
  assert.match(properties, /android.enableShrinkResourcesInReleaseBuilds=true/);
  assert.equal(fs.readFileSync(path.join(root, 'android/app/build.gradle'), 'utf8'), plugin.releaseGradle(gradle));
  const generatedRules = fs.readFileSync(path.join(root, 'android/app/proguard-rules.pro'), 'utf8');
  assert.equal(generatedRules, plugin.releaseProguard(originalRules));
  assert.equal(generatedRules.slice(0, originalRules.length), originalRules);
  assert.equal(generatedRules.split(plugin.FIELD_ANNOTATION_KEEP).length - 1, 1);
  const keep = fs.readFileSync(path.join(root, 'android/app/src/release/res/raw/com_baristajobmatch_app_metro_keep.xml'), 'utf8');
  assert.equal(keep, plugin.RESOURCE_KEEP);
  assert.equal(fs.existsSync(path.join(root, 'android/app/src/main/res/raw/com_baristajobmatch_app_metro_keep.xml')), false);
  assert.equal(fs.existsSync(path.join(root, 'ios')), false);
});

test('resource shrinking preserves only Metro named-image prefixes and refuses conflicting custom rules', async t => {
  const root = fixture(t), platform = path.join(root, 'android');
  await plugin.writeResourceKeep(platform);
  await plugin.writeResourceKeep(platform);
  assert.match(plugin.RESOURCE_KEEP, /tools:keep="@drawable\/assets_\*,@drawable\/node_modules_\*"/);
  assert.equal(plugin.RESOURCE_KEEP.includes('@drawable/*'), false);
  assert.equal(plugin.RESOURCE_KEEP.includes('tools:discard'), false);
  const filename = path.join(platform, 'app/src/release/res/raw/com_baristajobmatch_app_metro_keep.xml');
  fs.writeFileSync(filename, 'unreviewed rules');
  await assert.rejects(plugin.writeResourceKeep(platform), /Review the existing Android Metro resource keep/);
  assert.equal(fs.readFileSync(filename, 'utf8'), 'unreviewed rules');
});

function withEnvironment(values, action) {
  const keys = Object.keys(process.env).filter(key => key.startsWith('EAS_BUILD') || key.startsWith('EXPO_PUBLIC_') || ['EXPO_NO_DOTENV', 'GOOGLE_SERVICES_JSON'].includes(key));
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  Object.assign(process.env, values);
  try { return action(); }
  finally { for (const key of new Set([...keys, ...Object.keys(values)])) delete process.env[key]; Object.assign(process.env, previous); }
}

test('effective public and isolated Android EAS profiles retain all pins and add optimization once', t => {
  const root = fixture(t), firebase = path.join(root, 'firebase-fixture.json');
  fs.writeFileSync(firebase, JSON.stringify({ project_info: { project_id: 'baristamatch', project_number: '397053773139' }, client: [{ client_info: {
    android_client_info: { package_name: app.android.package }, mobilesdk_app_id: '1:397053773139:android:a3317b8e561e596aea4da6' }, api_key: [{ current_key: 'synthetic-public-firebase-fixture' }] }] }));
  for (const profile of ['android-public-internal', 'android-payment-review']) {
    const configured = withEnvironment({ ...eas.build[profile].env, EAS_BUILD_PLATFORM: 'android', EAS_BUILD_PROFILE: profile,
      GOOGLE_SERVICES_JSON: firebase, EXPO_PUBLIC_ANDROID_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_publicfixture',
      EXPO_PUBLIC_ANDROID_TEST_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_reviewfixture' }, () => config({ config: structuredClone(app) }));
    assert.equal(configured.plugins.filter(value => value === optimizationPlugin).length, 1);
    assert.deepEqual(configured.android, { ...app.android, googleServicesFile: firebase });
    assert.deepEqual(configured.ios, app.ios);
    assert.equal(configured.orientation, app.orientation);
    assert.equal(configured.updates.enabled, false);
  }
});

test('iOS production and Apple payment-review effective config remain exactly unchanged and need no Firebase', () => {
  for (const profile of ['production', 'payment-review']) {
    const configured = withEnvironment({ ...eas.build[profile].env, EAS_BUILD_PLATFORM: 'ios', EAS_BUILD_PROFILE: profile },
      () => config({ config: structuredClone(app) }));
    assert.deepEqual(configured, app);
  }
});
