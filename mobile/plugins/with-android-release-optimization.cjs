const fs = require('node:fs');
const path = require('node:path');
const { withGradleProperties, withAppBuildGradle, withFinalizedMod } = require('expo/config-plugins');

const RELEASE_PROPERTIES = ['android.enableMinifyInReleaseBuilds', 'android.enableShrinkResourcesInReleaseBuilds'];
// SDK54 records use this annotation through Kotlin reflection. Expo's narrow
// upstream fix: https://github.com/expo/expo/pull/51206 (no SDK upgrade needed).
const FIELD_ANNOTATION_KEEP = '-keep @interface expo.modules.kotlin.records.Field { *; }';
const RESOURCE_KEEP = `<?xml version="1.0" encoding="utf-8"?>
<!-- Metro/Hermes images are resolved by resource name, outside R8's Java graph. -->
<resources xmlns:tools="http://schemas.android.com/tools"
    tools:keep="@drawable/assets_*,@drawable/node_modules_*" />
`;

function releaseProperties(properties) {
  // Keep comments and unrelated flags, replacing any existing values once.
  return [...properties.filter(item => item.type !== 'property' || !RELEASE_PROPERTIES.includes(item.key)),
    ...RELEASE_PROPERTIES.map(key => ({ type: 'property', key, value: 'true' }))];
}

function releaseGradle(source) {
  // SDK54 defaults to proguard-android.txt, whose -dontoptimize defeats R8's
  // optimizer. Keep Expo's app rules and all dependency consumer rules intact.
  const matches = [...source.matchAll(/proguardFiles\s+getDefaultProguardFile\((["'])proguard-android(?:-optimize)?\.txt\1\),\s*(["'])proguard-rules\.pro\2/g)];
  if (matches.length !== 1
    || !source.includes("findProperty('android.enableMinifyInReleaseBuilds')")
    || !source.includes("findProperty('android.enableShrinkResourcesInReleaseBuilds')")
    || !/^\s*minifyEnabled\s*(?:=\s*)?enableMinifyInReleaseBuilds\s*$/m.test(source)
    || !/^\s*shrinkResources\s*(?:=\s*)?enableShrinkResources\.toBoolean\(\)\s*$/m.test(source)) {
    throw Error('Review the Android release optimization plugin for this Gradle template.');
  }
  return source.replace(matches[0][0], matches[0][0].replace('proguard-android.txt', 'proguard-android-optimize.txt'));
}

async function writeResourceKeep(platformRoot) {
  // Use the release source set only. These are Metro's generated drawable
  // prefixes, not a blanket keep of Firebase/Android/React Native resources.
  const directory = path.join(platformRoot, 'app/src/release/res/raw');
  const filename = path.join(directory, 'com_baristajobmatch_app_metro_keep.xml');
  try {
    const existing = await fs.promises.readFile(filename, 'utf8');
    if (existing !== RESOURCE_KEEP) throw Error('Review the existing Android Metro resource keep rules.');
    return;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await fs.promises.mkdir(directory, { recursive: true });
  await fs.promises.writeFile(filename, RESOURCE_KEEP);
}

function releaseProguard(source) {
  if (source.split(/\r?\n/).some(line => line.trim() === FIELD_ANNOTATION_KEEP)) return source;
  return `${source}${source.endsWith('\n') ? '' : '\n'}\n# Preserve Expo record option annotations in optimized Android releases.\n${FIELD_ANNOTATION_KEEP}\n`;
}

async function writeFieldAnnotationKeep(platformRoot) {
  const filename = path.join(platformRoot, 'app/proguard-rules.pro');
  const source = await fs.promises.readFile(filename, 'utf8');
  const result = releaseProguard(source);
  if (result !== source) await fs.promises.writeFile(filename, result);
}

function withAndroidReleaseOptimization(config) {
  config = withGradleProperties(config, c => { c.modResults = releaseProperties(c.modResults); return c; });
  config = withAppBuildGradle(config, c => {
    if (c.modResults.language !== 'groovy') throw Error('Review Android release optimization for this Gradle language.');
    c.modResults.contents = releaseGradle(c.modResults.contents);
    return c;
  });
  // RN, Expo modules core, Firebase and pinned OpenIAP provide their consumer
  // keep rules. Do not add blanket package keeps or suppress missing classes.
  return withFinalizedMod(config, ['android', async c => {
    await writeFieldAnnotationKeep(c.modRequest.platformProjectRoot);
    await writeResourceKeep(c.modRequest.platformProjectRoot);
    return c;
  }]);
}

module.exports = withAndroidReleaseOptimization;
module.exports.releaseProperties = releaseProperties;
module.exports.releaseGradle = releaseGradle;
module.exports.writeResourceKeep = writeResourceKeep;
module.exports.RESOURCE_KEEP = RESOURCE_KEEP;
module.exports.releaseProguard = releaseProguard;
module.exports.writeFieldAnnotationKeep = writeFieldAnnotationKeep;
module.exports.FIELD_ANNOTATION_KEEP = FIELD_ANNOTATION_KEEP;
