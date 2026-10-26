import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadTypescript } from './load-typescript.mjs';

const profiles = JSON.parse(readFileSync(new URL('../../mobile/eas.json', import.meta.url), 'utf8')).build;

function controls(platform, publicRelease, review = false) {
  const pushes = [];
  const jsx = (type, props) => ({ type, props });
  const module = loadTypescript('mobile/features/review-mode/ReviewModeControls.tsx', {
    'react/jsx-runtime': { jsx, jsxs: jsx },
    'react-native': { Platform: { OS: platform }, Pressable: 'Pressable', Text: 'Text', View: 'View',
      StyleSheet: { create: styles => styles } },
    'expo-router': { router: { push: path => pushes.push(path) } },
    'react-native-safe-area-context': { useSafeAreaInsets: () => ({ top: 47 }) },
    './environment': { getAppEnvironment: () => ({ review }) },
  }, { process: { env: { EXPO_PUBLIC_ANDROID_PUBLIC_RELEASE: publicRelease } } });
  return { ...module, pushes };
}

test('public Android login does not advertise App review or claim to be in test mode', () => {
  const publicRelease = profiles['android-public-internal'].env.EXPO_PUBLIC_ANDROID_PUBLIC_RELEASE;
  assert.equal(publicRelease, 'true');
  const h = controls('android', publicRelease);
  assert.equal(h.ReviewModeEntry(), null);
  assert.equal(h.ReviewModeBanner(), null);
  assert.deepEqual(h.pushes, []);
});

test('iOS and other non-Android entry behavior and safe-area position remain unchanged', () => {
  for (const platform of ['ios', 'web']) {
    for (const publicRelease of [undefined, 'false', 'true']) {
      const h = controls(platform, publicRelease);
      const entry = h.ReviewModeEntry();
      assert.equal(entry.props.children.props.children, 'App review');
      assert.equal(entry.props.accessibilityRole, 'button');
      assert.equal(entry.props.style[1].top, 51);
      entry.props.onPress();
      assert.deepEqual(h.pushes, ['/review-mode']);
    }
  }
});

test('non-public Android builds retain the existing explicit reviewer entry', () => {
  assert.equal(profiles['android-payment-review'].env.EXPO_PUBLIC_ANDROID_PUBLIC_RELEASE, undefined);
  for (const publicRelease of [undefined, 'false']) {
    const h = controls('android', publicRelease);
    const entry = h.ReviewModeEntry();
    assert.equal(entry.props.children.props.children, 'App review');
    entry.props.onPress();
    assert.deepEqual(h.pushes, ['/review-mode']);
  }
});

test('saved review mode and test-only builds retain their banner and Info / Exit route', () => {
  for (const platform of ['android', 'ios']) {
    for (const publicRelease of [undefined, 'false', 'true']) {
      const h = controls(platform, publicRelease, true);
      assert.equal(h.ReviewModeEntry(), null);
      const banner = h.ReviewModeBanner();
      assert.equal(banner.props.children[0].props.children, 'Test mode · Isolated accounts');
      const info = banner.props.children[1];
      assert.equal(info.props.accessibilityLabel, 'Test mode information and exit');
      info.props.onPress();
      assert.deepEqual(h.pushes, ['/review-mode']);
    }
  }
});
