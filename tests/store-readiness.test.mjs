import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateStoreConfiguration, verifyAppleToolchain } from '../mobile/scripts/verify-store-toolchain.mjs';
const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const app = JSON.parse(read('mobile/app.json')).expo;
const pkg = JSON.parse(read('mobile/package.json'));
const eas = JSON.parse(read('mobile/eas.json'));

test('current store configuration passes without a dependency upgrade', () => {
  assert.deepEqual(validateStoreConfiguration(app, pkg, eas), []);
});
test('rejects older Android-targeting SDK baselines', () => {
  assert.ok(validateStoreConfiguration(app, { ...pkg, dependencies: { expo: '~53.0.0' } }, eas).length);
});
test('rejects the pinned build images defaulting to unsupported Node 20', () => {
  for (const node of [undefined, '20.19.4', '22']) {
    const changed = structuredClone(eas); changed.build.production.node = node;
    assert.equal(validateStoreConfiguration(app, pkg, changed).length, 2);
  }
});
test('rejects a platform Node override below the dependencies engine requirement', () => {
  const changed = structuredClone(eas); changed.build.production.android.node = '20.19.4';
  assert.equal(validateStoreConfiguration(app, pkg, changed).length, 1);
});
test('rejects an Android target override below API 36', () => {
  assert.ok(validateStoreConfiguration({ ...app, plugins: [['expo-build-properties', { android: { targetSdkVersion: 35 } }]] }, pkg, eas).length);
});
test('rejects a production APK configuration', () => {
  const changed = structuredClone(eas); changed.build.production.android.buildType = 'apk';
  assert.ok(validateStoreConfiguration(app, pkg, changed).length);
});
test('rejects an old Xcode production builder', () => {
  const changed = structuredClone(eas); changed.build.production.ios.image = 'macos-sequoia-15.6-xcode-16.4';
  assert.ok(validateStoreConfiguration(app, pkg, changed).length);
});
test('rejects mismatched release versions and package identifiers', () => {
  const changed = structuredClone(app); changed.android.package = 'com.example.app'; changed.version = '0.0.0';
  assert.equal(validateStoreConfiguration(changed, pkg, eas).length, 2);
});
test('verifies real Apple tool output, not just configuration', () => {
  assert.deepEqual(verifyAppleToolchain(command => command === 'xcodebuild' ? 'Xcode 26.0\nBuild version 17A324' : '26.0\n'), { xcodeMajor: 26, iphoneosSdk: '26.0' });
});
test('blocks Xcode 16 despite an SDK-looking configuration', () => {
  assert.throws(() => verifyAppleToolchain(command => command === 'xcodebuild' ? 'Xcode 16.4' : '18.4'), /Xcode 26/);
});
test('blocks an older iPhoneOS SDK even with new Xcode', () => {
  assert.throws(() => verifyAppleToolchain(command => command === 'xcodebuild' ? 'Xcode 26.1' : '18.4'), /iPhoneOS 26/);
});
test('blocks unknown Apple tool output', () => {
  assert.throws(() => verifyAppleToolchain(() => 'unknown'), /Xcode 26/);
});
test('production builder invokes the toolchain check', () => {
  assert.equal(pkg.scripts['eas-build-pre-install'], 'node scripts/verify-store-toolchain.mjs');
});
test('public deletion resource is usable without the app or scripts', () => {
  const html = read('delete-account.html');
  assert.match(html, /BaristaMatch LLC/);
  assert.match(html, /mailto:hello@baristajobmatch\.com\?subject=/);
  assert.match(html, /without reinstalling the app/);
  assert.match(html, /associated personal data/);
  assert.match(html, /Backup copies/);
  assert.doesNotMatch(html, /<script\b/i);
});
test('Android root protects insets; the photo login owns its safe areas on both platforms', () => {
  const layout = read('mobile/app/_layout.tsx');
  assert.match(layout, /import \{ SafeAreaView \} from 'react-native-safe-area-context'/);
  assert.match(layout, /Platform\.OS === 'android' && !isLogin \? \['top', 'right', 'bottom', 'left'\] : \[\]/);
  assert.match(layout, /const isLogin = pathname === '\/login'/);
  const login = read('mobile/app/login.tsx');
  assert.match(login, /useSafeAreaInsets/);
  assert.match(login, /paddingTop: insets\.top \+ 12/);
  assert.match(login, /paddingBottom: Math\.max\(insets\.bottom, 16\)/);
  assert.match(layout, /<Stack screenOptions/);
});
