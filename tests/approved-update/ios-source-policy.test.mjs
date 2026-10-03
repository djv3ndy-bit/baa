import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
const require = createRequire(import.meta.url);
const mobileRequire = createRequire(new URL('../../mobile/package.json', import.meta.url));
const plugin = require('../../mobile/plugins/with-ios-bundled-code.cjs');
const manifest = require('../../mobile/plugins/ios-bundled-code/patches.json');
const sha = value => createHash('sha256').update(value).digest('hex');
function fixture(t) {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'bjm-ios-source-'));
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));
  for (const pkg of manifest.packages) {
    const root = path.join(project, 'node_modules', pkg.name);
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: pkg.version }));
    const sourceRoot = path.dirname(mobileRequire.resolve(`${pkg.name}/package.json`));
    for (const file of pkg.files) {
      const dest = path.join(root, file.path);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      if (file.beforeSha256 !== null) fs.copyFileSync(path.join(sourceRoot, file.path), dest);
    }
  }
  return project;
}
test('iOS dependency changes are reproducible and idempotent without touching other source', t => {
  const root = fixture(t);
  assert.equal(plugin.applySources(root), 6);
  assert.equal(plugin.applySources(root), 0);
  for (const pkg of manifest.packages) for (const file of pkg.files) {
    assert.equal(sha(fs.readFileSync(path.join(root, 'node_modules', pkg.name, file.path))), file.afterSha256);
  }
});
test('unreviewed navigation source prevents all loader edits', t => {
  const root = fixture(t), pkg = manifest.packages.at(-1), file = pkg.files.at(-1);
  fs.appendFileSync(path.join(root, 'node_modules', pkg.name, file.path), '\n// upstream change\n');
  assert.throws(() => plugin.applySources(root), /Unexpected iOS dependency source/);
  assert.equal(fs.existsSync(path.join(root, 'node_modules/react-native/React/Base/RCTBundledCodePolicy.h')), false);
});
test('dependency version drift fails before changing any file', t => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, 'node_modules/react-native/package.json'), '{"version":"0.82.0"}');
  assert.throws(() => plugin.applySources(root), /before changing react-native/);
});
test('source build is forced before pod helpers and preserves the rest of the Podfile', () => {
  const source = "require 'json'\ntarget 'Existing' do\nend\n";
  const result = plugin.sourceBuildPodfile(source);
  assert.ok(result.endsWith(source));
  assert.equal(plugin.sourceBuildPodfile(result), result);
  const withIap = "source 'https://cdn.cocoapods.org/'\n\n" + result;
  assert.equal(plugin.sourceBuildPodfile(withIap), withIap);
  assert.match(result.split("require 'json'")[0], /ENV\['RCT_USE_PREBUILT_RNCORE'\] = '0'/);
  assert.throws(() => plugin.sourceBuildPodfile('unexpected\n' + result), /Review the existing/);
});
test('Foundation rejects remote, cached, traversal and symlink code; accepts packaged code', { skip: process.platform !== 'darwin' }, t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bjm-code-policy-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const header = path.resolve(new URL('../../mobile/plugins/ios-bundled-code/RCTBundledCodePolicy.h', import.meta.url).pathname);
  const source = new URL('./native/bundled-code-policy.m', import.meta.url).pathname;
  execFileSync('xcrun', ['clang', '-fobjc-arc', '-framework', 'Foundation', '-include', header, source, '-o', path.join(tmp, 'policy')]);
  const output = execFileSync(path.join(tmp, 'policy'), [tmp], { encoding: 'utf8' });
  assert.match(output, /15 native URL policy cases passed/);
});
