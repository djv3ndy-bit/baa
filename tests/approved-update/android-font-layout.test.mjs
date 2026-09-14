import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { applyBackport, assertPristineIos, sourceBuildSettings } = require('../../mobile/plugins/with-android-font-layout.cjs');
const patch = require('../../mobile/plugins/android-font-layout/backport.json');
const dependency = path.dirname(createRequire(new URL('../../mobile/package.json', import.meta.url)).resolve('react-native/package.json'));
const hash = value => createHash('sha256').update(value).digest('hex');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bjm-font-regression-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '0.81.5' }));
  for (const file of patch.files) {
    const dest = path.join(root, file.path); fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(dependency, file.path), dest);
  }
  return root;
}
test('reviewed backport is reproducible, idempotent and never mixes with precompiled iOS', t => {
  const root = fixture(t); assert.doesNotThrow(() => assertPristineIos(root));
  assert.equal(applyBackport(root), 5);
  for (const file of patch.files) assert.equal(hash(fs.readFileSync(path.join(root, file.path))), file.afterSha256);
  assert.equal(applyBackport(root), 0);
  assert.throws(() => assertPristineIos(root), /separate clean dependency install/);
});
test('unexpected source in the last file prevents every dependency mutation', t => {
  const root = fixture(t), last = patch.files.at(-1);
  fs.appendFileSync(path.join(root, last.path), '\n// changed upstream\n');
  assert.throws(() => applyBackport(root), /Unexpected font-layout source/);
  for (const file of patch.files.slice(0, -1)) assert.equal(hash(fs.readFileSync(path.join(root, file.path))), file.beforeSha256);
});
test('unknown dependency versions require review without changing source', t => {
  const root = fixture(t); fs.writeFileSync(path.join(root, 'package.json'), '{"version":"0.82.0"}');
  assert.throws(() => applyBackport(root), /before changing React Native/);
  assert.doesNotThrow(() => assertPristineIos(root));
});
test('source build preserves existing settings and rejects a changed or unsafe integration', () => {
  const original = "rootProject.name = 'Existing'\ninclude ':app'\n";
  const result = sourceBuildSettings(original, '../node_modules/react-native');
  assert.ok(result.startsWith(original)); assert.equal(sourceBuildSettings(result, '../node_modules/react-native'), result);
  assert.match(result, /react-android/); assert.match(result, /hermes-android/);
  assert.throws(() => sourceBuildSettings(result + '// unexpected\n', '../node_modules/react-native'), /Review the existing/);
  assert.throws(() => sourceBuildSettings(original, "../can't-use-this"), /Unsupported/);
});
