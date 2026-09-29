import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateBundleOnlyConfiguration } from '../../mobile/scripts/store-bundle-policy.mjs';

const read = path => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const app = read('../../mobile/app.json').expo;
const pkg = read('../../mobile/package.json');
const eas = read('../../mobile/eas.json');
const lock = read('../../mobile/package-lock.json');
const clean = () => structuredClone([app, pkg, eas]);

test('release configuration and locked dependency graph contain no downloadable-code engine', () => {
  assert.deepEqual(validateBundleOnlyConfiguration(app, pkg, eas), []);
  assert.ok(!Object.keys(lock.packages).some(p => /(?:^|\/)node_modules\/(?:expo-updates|expo-dev-client|expo-dev-launcher|react-native-code-push)$/.test(p)));
});
for (const [label, change] of [
  ['automatic updates', a => { a[0].updates.enabled = true; }],
  ['omitted update disablement', a => { delete a[0].updates; }],
  ['remote manifest URL', a => { a[0].updates.url = 'https://updates.example.invalid'; }],
  ['runtime mapping', a => { a[0].runtimeVersion = '1.0.5'; }],
  ['Expo download engine', a => { a[1].dependencies['expo-updates'] = '29.0.20'; }],
  ['development client in optional dependencies', a => { a[1].optionalDependencies = { 'expo-dev-client': '1' }; }],
  ['development launcher', a => { a[1].devDependencies['expo-dev-launcher'] = '1'; }],
  ['CodePush', a => { a[1].dependencies['react-native-code-push'] = '1'; }],
  ['production update channel', a => { a[2].build.production.channel = 'production'; }],
  ['review update channel', a => { a[2].build['payment-review'].channel = 'review'; }],
  ['production development client', a => { a[2].build.production.developmentClient = true; }],
  ['inherited store development client', a => { a[2].build['payment-review'].developmentClient = true; }],
]) test(`release gate rejects ${label}`, () => {
  const inputs = clean(); change(inputs);
  assert.ok(validateBundleOnlyConfiguration(...inputs).length > 0);
});

test('local development and fixed test-data environment still work without a code update channel', () => {
  assert.equal(eas.build.development.developmentClient, true);
  const source = readFileSync(new URL('../../mobile/features/review-mode/environment.ts', import.meta.url), 'utf8');
  assert.match(source, /import \{ reloadAppAsync \} from 'expo'/);
  assert.doesNotMatch(source, /expo-updates|fetchUpdate|checkForUpdate/);
});
