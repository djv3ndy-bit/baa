import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../../mobile/package.json', import.meta.url));
const plugin = require('./plugins/with-android-icon-inset.cjs');
const { XML, compileModsAsync } = require('expo/config-plugins');
const expoRequire = createRequire(require.resolve('expo/package.json'));
const cliRequire = createRequire(expoRequire.resolve('@expo/cli/package.json'));
const icons = cliRequire('@expo/prebuild-config/build/plugins/icons/withAndroidIcons');
const app = JSON.parse(fs.readFileSync(new URL('../../mobile/app.json', import.meta.url))).expo;
const original = fs.readFileSync(new URL('../../mobile/assets/icon.png', import.meta.url));
const digest = value => createHash('sha256').update(value).digest('hex');
const INSET = '16.666667%';
const iconDirectory = root => path.join(root, 'android/app/src/main/res/mipmap-anydpi-v26');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bjm-icon-inset-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(iconDirectory(root), { recursive: true });
  return root;
}
async function assertInset(source) {
  const document = await XML.parseXMLAsync(source);
  const foreground = document['adaptive-icon'].foreground[0];
  assert.deepEqual(Object.keys(foreground), ['inset']);
  assert.equal(foreground.inset.length, 1);
  assert.deepEqual(foreground.inset[0].$, {
    'android:drawable': '@mipmap/ic_launcher_foreground',
    'android:insetLeft': INSET, 'android:insetTop': INSET,
    'android:insetRight': INSET, 'android:insetBottom': INSET,
  });
}

test('Android uses the unchanged original artwork; iOS icon/settings and OTA remain unchanged', () => {
  assert.equal(digest(original), 'a7e561c157309742b2038314ee1153f40cde7b4eb90e117d098fadcae5519ad5');
  assert.equal(app.icon, './assets/icon.png');
  assert.equal(app.ios.icon, undefined);
  assert.equal(app.android.adaptiveIcon.foregroundImage, app.icon);
  assert.equal(app.android.adaptiveIcon.backgroundColor, '#ffffff');
  assert.equal(app.updates.enabled, false);
  assert.equal(app.plugins.filter(item => item === './plugins/with-android-icon-inset.cjs').length, 1);
  const configured = plugin(structuredClone(app));
  assert.deepEqual(Object.keys(configured.mods), ['android']);
  assert.deepEqual(Object.keys(configured.mods.android), ['finalized']);
  assert.deepEqual(configured.ios, app.ios);
});

test('the percent inset cancels the adaptive viewport expansion without altering artwork', () => {
  const visibleScale = (1 - 2 * parseFloat(INSET) / 100) * 1.5;
  assert.ok(Math.abs(visibleScale - 1) < 0.00000002);
});

test('real Expo XML is inset once, preserving background and monochrome content', async () => {
  for (const backgroundImage of [undefined, './assets/background.png']) {
    const source = icons.createAdaptiveIconXmlString(backgroundImage, './assets/monochrome.png');
    const result = await plugin.insetAdaptiveIconXml(source);
    await assertInset(result);
    const before = await XML.parseXMLAsync(source), after = await XML.parseXMLAsync(result);
    assert.deepEqual(after['adaptive-icon'].background, before['adaptive-icon'].background);
    assert.deepEqual(after['adaptive-icon'].monochrome, before['adaptive-icon'].monochrome);
    assert.equal(await plugin.insetAdaptiveIconXml(result), result);
  }
});

test('unknown foreground structure and changed inset fail visibly', async () => {
  const source = icons.createAdaptiveIconXmlString();
  const inset = await plugin.insetAdaptiveIconXml(source);
  for (const invalid of [
    'invalid XML', source.replace('adaptive-icon', 'layer-list'),
    source.replace('http://schemas.android.com/apk/res/android', 'https://invalid.example'),
    source.replace('@mipmap/ic_launcher_foreground', '@mipmap/unreviewed'),
    source.replace('<foreground', '<foreground android:alpha="0.5"'),
    source.replace('</adaptive-icon>', '<foreground android:drawable="@mipmap/ic_launcher_foreground"/></adaptive-icon>'),
    inset.replace('16.666667%', '20%'),
    inset.replace('<inset ', '<inset android:alpha="0.5" '),
  ]) await assert.rejects(plugin.insetAdaptiveIconXml(invalid), /Unexpected Android adaptive-icon XML/);
  assert.throws(() => plugin({ android: { adaptiveIcon: { foregroundImage: './assets/other.png', backgroundColor: '#ffffff' } } }), /unchanged original/);
});

test('both launcher XML files are validated before any resource changes', async t => {
  const root = fixture(t), directory = iconDirectory(root), source = icons.createAdaptiveIconXmlString();
  fs.writeFileSync(path.join(directory, 'ic_launcher.xml'), source);
  fs.writeFileSync(path.join(directory, 'ic_launcher_round.xml'), source.replace('@mipmap/ic_launcher_foreground', '@mipmap/unknown'));
  await assert.rejects(plugin.applyAndroidIconInset(path.join(root, 'android')), /Unexpected Android adaptive-icon XML/);
  assert.equal(fs.readFileSync(path.join(directory, 'ic_launcher.xml'), 'utf8'), source);
  fs.rmSync(path.join(directory, 'ic_launcher_round.xml'));
  await assert.rejects(plugin.applyAndroidIconInset(path.join(root, 'android')), /ENOENT/);
  assert.equal(fs.readFileSync(path.join(directory, 'ic_launcher.xml'), 'utf8'), source);
});

test('actual Expo icon prebuild runs before the Android-only finalized inset and remains repeatable', async t => {
  const root = fixture(t);
  fs.mkdirSync(path.join(root, 'assets'));
  fs.writeFileSync(path.join(root, 'assets/icon.png'), original);
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"synthetic-icon-prebuild","version":"1.0.0"}');
  fs.mkdirSync(path.join(root, 'android/app/src/main/res/values'), { recursive: true });
  fs.writeFileSync(path.join(root, 'android/app/src/main/res/values/colors.xml'), '<resources/>');
  fs.writeFileSync(path.join(root, 'android/app/src/main/AndroidManifest.xml'), '<manifest xmlns:android="http://schemas.android.com/apk/res/android"><application android:name=".MainApplication" android:icon="@mipmap/ic_launcher"/></manifest>');
  // Deliberately register the finalized plugin first: execution order must
  // still put Expo's dangerous icon-generation mod before this adjustment.
  async function prebuild() {
    let config = plugin(structuredClone(app));
    config = icons.withAndroidIcons(config);
    // Expo CLI normally runs from the app root; its image cache hashes the
    // source path relative to cwd even when projectRoot is supplied.
    const previous = process.cwd();
    process.chdir(root);
    try { return await compileModsAsync(config, { projectRoot: root, platforms: ['android'] }); }
    finally { process.chdir(previous); }
  }
  await prebuild();
  const first = ['ic_launcher.xml', 'ic_launcher_round.xml'].map(name => fs.readFileSync(path.join(iconDirectory(root), name), 'utf8'));
  for (const xml of first) await assertInset(xml);
  assert.equal(await plugin.applyAndroidIconInset(path.join(root, 'android')), 0);
  await prebuild();
  for (const [index, name] of ['ic_launcher.xml', 'ic_launcher_round.xml'].entries()) {
    assert.equal(fs.readFileSync(path.join(iconDirectory(root), name), 'utf8'), first[index]);
  }
  const colors = await XML.parseXMLAsync(fs.readFileSync(path.join(root, 'android/app/src/main/res/values/colors.xml'), 'utf8'));
  assert.equal(colors.resources.color.find(item => item.$.name === 'iconBackground')._, '#ffffff');
  assert.ok(fs.statSync(path.join(root, 'android/app/src/main/res/mipmap-xxxhdpi/ic_launcher_foreground.webp')).size > 0);
  assert.equal(digest(fs.readFileSync(path.join(root, 'assets/icon.png'))), digest(original));
  assert.equal(fs.existsSync(path.join(root, 'ios')), false);
});
