import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { patchScreenRemoval } from '../../mobile/scripts/fix-android-screen-removal.mjs';

const source = readFileSync(new URL('../../mobile/node_modules/react-native-screens/android/src/fabric/java/com/swmansion/rnscreens/NativeProxy.kt', import.meta.url), 'utf8');

test('screen removal is queued on the UI thread, retaining failure diagnostics', () => {
  const fixed = patchScreenRemoval(source, '4.16.0');
  assert.match(fixed, /screen\.post\s*\{\s*screen\.startRemovalTransition\(\)/);
  assert.match(fixed, /if \(!isScheduled\)/);
  assert.match(fixed, /Failed to schedule removal transition/);
});

test('repeated installation leaves the exact verified fix unchanged', () => {
  const fixed = patchScreenRemoval(source, '4.16.0');
  assert.equal(patchScreenRemoval(fixed, '4.16.0'), fixed);
});

test('a different dependency version requires review before mutation', () => {
  assert.throws(() => patchScreenRemoval(source, '4.17.0'), /Review/);
});

test('unknown source is rejected instead of applying an ambiguous patch', () => {
  assert.throws(() => patchScreenRemoval(source + '\n', '4.16.0'), /Unexpected/);
});
