const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const backport = require('./android-font-layout/backport.json');
const sha = value => createHash('sha256').update(value).digest('hex');
const marker = '// BaristaMatch: compile the reviewed Android font-layout backport.';

function prepareBackport(root) {
  const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  if (version !== backport.reactNativeVersion) throw Error('Review the Android font-layout backport before changing React Native.');
  return backport.files.map(file => {
    const filename = path.join(root, file.path);
    const original = fs.readFileSync(filename, 'utf8');
    if (sha(original) === file.afterSha256) return { filename, original, patched: original };
    if (sha(original) !== file.beforeSha256) throw Error(`Unexpected font-layout source: ${file.path}. No patch applied.`);
    let patched = original;
    for (const edit of file.edits) {
      if (patched.split(edit.before).length !== 2) throw Error(`Ambiguous font-layout patch: ${file.path}.`);
      patched = patched.replace(edit.before, edit.after);
    }
    if (sha(patched) !== file.afterSha256) throw Error(`Font-layout verification failed: ${file.path}.`);
    return { filename, original, patched };
  });
}

function applyBackport(root) {
  // Validate every file before changing any file. An unknown dependency fails
  // visibly; it must never produce a partially patched native release.
  const prepared = prepareBackport(root);
  const written = [];
  try {
    for (const item of prepared) {
      if (item.original === item.patched) continue;
      fs.writeFileSync(item.filename, item.patched);
      written.push(item);
    }
  } catch (error) {
    for (const item of written.reverse()) fs.writeFileSync(item.filename, item.original);
    throw error;
  }
  return written.length;
}

function assertPristineIos(root) {
  // EAS builds each platform from a fresh install. Do not mix the changed C++
  // layout ABI with precompiled iOS React Native in a shared local install.
  for (const file of backport.files) {
    if (sha(fs.readFileSync(path.join(root, file.path))) !== file.beforeSha256) {
      throw Error('Build iOS from a separate clean dependency install; this install contains the Android font-layout backport.');
    }
  }
}

function sourceBuildSettings(source, relativeRoot) {
  if (!/^[\w./-]+$/.test(relativeRoot)) throw Error('Unsupported React Native source path.');
  const block = `${marker}\nincludeBuild('${relativeRoot}') {\n  dependencySubstitution {\n    substitute(module('com.facebook.react:react-android')).using(project(':packages:react-native:ReactAndroid'))\n    substitute(module('com.facebook.react:react-native')).using(project(':packages:react-native:ReactAndroid'))\n    substitute(module('com.facebook.react:hermes-android')).using(project(':packages:react-native:ReactAndroid:hermes-engine'))\n    substitute(module('com.facebook.react:hermes-engine')).using(project(':packages:react-native:ReactAndroid:hermes-engine'))\n  }\n}\n`;
  if (source.includes(marker)) {
    if (!source.endsWith(block)) throw Error('Review the existing Android font-layout build configuration.');
    return source;
  }
  return source.replace(/\s*$/, '\n\n') + block;
}

function withAndroidFontLayout(config) {
  const { withDangerousMod, withSettingsGradle, withAndroidManifest, AndroidConfig } = require('expo/config-plugins');
  const rnRoot = c => path.dirname(require.resolve('react-native/package.json', { paths: [c.modRequest.projectRoot] }));
  config = withDangerousMod(config, ['android', async c => { applyBackport(rnRoot(c)); return c; }]);
  config = withDangerousMod(config, ['ios', async c => { assertPristineIos(rnRoot(c)); return c; }]);
  config = withSettingsGradle(config, c => {
    if (c.modResults.language !== 'groovy') throw Error('Review the Android font-layout configuration for this Gradle format.');
    const relative = path.relative(c.modRequest.platformProjectRoot, rnRoot(c)).split(path.sep).join('/');
    c.modResults.contents = sourceBuildSettings(c.modResults.contents, relative);
    return c;
  });
  return withAndroidManifest(config, c => {
    const activity = AndroidConfig.Manifest.getMainActivityOrThrow(c.modResults);
    const changes = new Set((activity.$['android:configChanges'] || '').split('|').filter(Boolean));
    // Preserve the running screen and its draft on text/display scaling changes.
    changes.add('fontScale'); changes.add('density');
    activity.$['android:configChanges'] = [...changes].join('|');
    return c;
  });
}

module.exports = withAndroidFontLayout;
module.exports.prepareBackport = prepareBackport;
module.exports.applyBackport = applyBackport;
module.exports.assertPristineIos = assertPristineIos;
module.exports.sourceBuildSettings = sourceBuildSettings;
