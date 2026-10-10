const fs = require('node:fs');
const path = require('node:path');

// AdaptiveIconDrawable expands a layer to 1.5 times its visible viewport.
// Retain the original artwork's spacing: (1 - 2 / 6) * 1.5 = 1.
const INSET = '16.666667%';
const DRAWABLE = '@mipmap/ic_launcher_foreground';
const insetAttributes = {
  'android:drawable': DRAWABLE,
  'android:insetLeft': INSET,
  'android:insetTop': INSET,
  'android:insetRight': INSET,
  'android:insetBottom': INSET,
};
const sameAttributes = (actual, expected) => actual && Object.keys(actual).length === Object.keys(expected).length
  && Object.entries(expected).every(([key, value]) => actual[key] === value);
const onlyKeys = (node, keys) => node && Object.keys(node).every(key => keys.includes(key));
const unsupported = () => new Error('Unexpected Android adaptive-icon XML. Review the icon inset before building.');

async function insetAdaptiveIconXml(source) {
  const { XML } = require('expo/config-plugins');
  let document;
  try { document = await XML.parseXMLAsync(source); }
  catch { throw unsupported(); }
  const icon = document?.['adaptive-icon'];
  if (Object.keys(document || {}).length !== 1
    || icon?.$?.['xmlns:android'] !== 'http://schemas.android.com/apk/res/android'
    || !Array.isArray(icon.foreground) || icon.foreground.length !== 1) throw unsupported();
  const foreground = icon.foreground[0];
  if (onlyKeys(foreground, ['inset']) && Array.isArray(foreground.inset) && foreground.inset.length === 1
    && onlyKeys(foreground.inset[0], ['$']) && sameAttributes(foreground.inset[0].$, insetAttributes)) return source;
  if (!onlyKeys(foreground, ['$']) || !sameAttributes(foreground.$, { 'android:drawable': DRAWABLE })) throw unsupported();
  icon.foreground[0] = { inset: [{ $: { ...insetAttributes } }] };
  // Background and any monochrome/unrelated nodes retain their original data.
  return '<?xml version="1.0" encoding="utf-8"?>\n' + XML.format(document) + '\n';
}

async function applyAndroidIconInset(platformProjectRoot) {
  const directory = path.join(platformProjectRoot, 'app/src/main/res/mipmap-anydpi-v26');
  // Validate both resources before writing either, so an SDK format change
  // cannot silently leave a release with only one corrected launcher shape.
  const prepared = [];
  for (const name of ['ic_launcher.xml', 'ic_launcher_round.xml']) {
    const filename = path.join(directory, name);
    const original = fs.readFileSync(filename, 'utf8');
    prepared.push({ filename, original, updated: await insetAdaptiveIconXml(original) });
  }
  const written = [];
  try {
    for (const item of prepared) {
      if (item.updated === item.original) continue;
      fs.writeFileSync(item.filename, item.updated);
      written.push(item);
    }
  } catch (error) {
    for (const item of written.reverse()) fs.writeFileSync(item.filename, item.original);
    throw error;
  }
  return written.length;
}

function withAndroidIconInset(config) {
  const { withFinalizedMod } = require('expo/config-plugins');
  if (config.android?.adaptiveIcon?.foregroundImage !== './assets/icon.png'
    || config.android.adaptiveIcon.backgroundColor !== '#ffffff') {
    throw new Error('The Android icon inset requires the unchanged original icon.png and white background.');
  }
  // Expo generates adaptive resources in its dangerous mod; finalized runs
  // afterwards. Register no iOS mod and never rewrite the source PNG.
  return withFinalizedMod(config, ['android', async c => {
    await applyAndroidIconInset(c.modRequest.platformProjectRoot);
    return c;
  }]);
}

module.exports = withAndroidIconInset;
module.exports.insetAdaptiveIconXml = insetAdaptiveIconXml;
module.exports.applyAndroidIconInset = applyAndroidIconInset;
