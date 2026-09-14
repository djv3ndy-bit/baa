import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Backport the Android UI-thread fix from react-native-screens PR #2964.
// https://github.com/software-mansion/react-native-screens/pull/2964
// Keep the Expo SDK 54 dependency version. An unknown source/version must be
// reviewed instead of silently modifying another dependency implementation.
const originalHash = '6fca9ccbc02959f46b022d30edeca624f99cf6cc186b3c274a9d4c3902dc5976';
const patchedHash = 'f0f12842639bab8690e264cda1a8cc7a6f3e2c159fc1896ae27787b9cb96f439';
const sha256 = source => createHash('sha256').update(source).digest('hex');

export function patchScreenRemoval(source, version) {
  if (version !== '4.16.0') throw new Error('Review the Android screen-removal fix before changing react-native-screens.');
  if (sha256(source) === patchedHash) return source;
  if (sha256(source) !== originalHash) throw new Error('Unexpected Android screen-removal source; no patch applied.');
  const patched = source.replace('            screen.startRemovalTransition()', `            val isScheduled =
                screen.post {
                    screen.startRemovalTransition()
                }
            if (!isScheduled) {
                Log.w("[RNScreens]", "Failed to schedule removal transition start for screen with tag $screenTag")
            }`);
  if (sha256(patched) !== patchedHash) throw new Error('Android screen-removal patch verification failed.');
  return patched;
}

export function applyScreenRemovalFix() {
  const require = createRequire(import.meta.url);
  const packagePath = require.resolve('react-native-screens/package.json');
  const { version } = JSON.parse(readFileSync(packagePath, 'utf8'));
  const sourcePath = join(dirname(packagePath), 'android/src/fabric/java/com/swmansion/rnscreens/NativeProxy.kt');
  const original = readFileSync(sourcePath, 'utf8');
  const patched = patchScreenRemoval(original, version);
  if (patched !== original) writeFileSync(sourcePath, patched);
  return { version, changed: patched !== original, sha256: sha256(patched) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log('Android screen-removal fix verified:', applyScreenRemovalFix());
}
