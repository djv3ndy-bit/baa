const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const policy = require('./ios-bundled-code/patches.json');
const sha = value => createHash('sha256').update(value).digest('hex');
const marker = '# BaristaMatch: build the audited iOS code loader from source.';

function prepareSources(projectRoot) {
  return policy.packages.flatMap(pkg => {
    const root = path.dirname(require.resolve(`${pkg.name}/package.json`, { paths: [projectRoot] }));
    if (JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version !== pkg.version) {
      throw Error(`Review the iOS bundled-code patch before changing ${pkg.name}.`);
    }
    return pkg.files.map(file => {
      const filename = path.join(root, file.path);
      const original = fs.existsSync(filename) ? fs.readFileSync(filename, 'utf8') : null;
      if (original !== null && sha(original) === file.afterSha256) return { filename, original, patched: original };
      if ((original === null ? null : sha(original)) !== file.beforeSha256) {
        throw Error(`Unexpected iOS dependency source: ${pkg.name}/${file.path}. No patch applied.`);
      }
      let patched = original;
      if (file.asset) {
        patched = fs.readFileSync(path.join(__dirname, 'ios-bundled-code', file.asset), 'utf8');
      } else {
        for (const edit of file.edits) {
          if (patched.split(edit.before).length !== 2) throw Error(`Ambiguous iOS patch: ${file.path}.`);
          patched = patched.replace(edit.before, edit.after);
        }
      }
      if (sha(patched) !== file.afterSha256) throw Error(`iOS patch verification failed: ${file.path}.`);
      return { filename, original, patched };
    });
  });
}

function applySources(projectRoot) {
  // Validate every source before writing; unknown versions fail closed.
  const prepared = prepareSources(projectRoot);
  const written = [];
  try {
    for (const item of prepared) {
      if (item.original === item.patched) continue;
      fs.writeFileSync(item.filename, item.patched);
      written.push(item);
    }
  } catch (error) {
    for (const item of written.reverse()) {
      if (item.original === null) fs.unlinkSync(item.filename);
      else fs.writeFileSync(item.filename, item.original);
    }
    throw error;
  }
  return written.length;
}

function sourceBuildPodfile(source) {
  // Override environment selection before React Native's pod helpers are loaded.
  const block = `${marker}\nENV['RCT_USE_PREBUILT_RNCORE'] = '0'\nENV['RCT_USE_RN_DEP'] ||= '1'\n`;
  if (source.includes(marker)) {
    // expo-iap prepends its CocoaPods source declaration after this mod runs.
    const withoutSource = source.replace(/^source 'https:\/\/cdn\.cocoapods\.org\/'\s*\n/, '');
    if (!withoutSource.startsWith(block) || source.split(marker).length !== 2) {
      throw Error('Review the existing iOS bundled-code build configuration.');
    }
    return source;
  }
  return block + source;
}

function withIosBundledCode(config) {
  const { withDangerousMod, withPodfile, withPodfileProperties } = require('expo/config-plugins');
  config = withDangerousMod(config, ['ios', async c => { applySources(c.modRequest.projectRoot); return c; }]);
  config = withPodfileProperties(config, c => {
    c.modResults['ios.buildReactNativeFromSource'] = 'true';
    return c;
  });
  return withPodfile(config, c => {
    c.modResults.contents = sourceBuildPodfile(c.modResults.contents);
    return c;
  });
}

module.exports = withIosBundledCode;
module.exports.prepareSources = prepareSources;
module.exports.applySources = applySources;
module.exports.sourceBuildPodfile = sourceBuildPodfile;
