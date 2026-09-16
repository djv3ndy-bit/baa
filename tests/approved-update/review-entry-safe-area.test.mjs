import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTypescript, plain } from './load-typescript.mjs';

function renderedInsets(path, platform, review) {
  const jsx = (type, props) => ({ type, props });
  const { default: RootLayout } = loadTypescript('mobile/app/_layout.tsx', {
    react: { useEffect() {} },
    'react/jsx-runtime': { jsx, jsxs: jsx },
    'expo-router': { Stack: 'Stack', usePathname: () => path },
    'react-native': { Platform: { OS: platform } },
    'react-native-safe-area-context': { SafeAreaView: 'SafeAreaView' },
    'expo-status-bar': { StatusBar: 'StatusBar' },
    '@/components/AppErrorBoundary': { AppErrorBoundary: 'AppErrorBoundary' },
    '@/lib/pushNotifications': {},
    '@/lib/supabase': {},
    '@/lib/api': {},
    '@/features/review-mode/AppEnvironmentGate': { AppEnvironmentGate: 'AppEnvironmentGate' },
    '@/features/review-mode/ReviewModeControls': { ReviewModeBanner: 'ReviewModeBanner', ReviewModeEntry: 'ReviewModeEntry' },
    '@/features/review-mode/environment': { getAppEnvironment: () => ({ review }) },
  });
  const ready = RootLayout().props.children;
  const screen = ready.type(ready.props);
  const safe = screen.props.children.find(child => child.type === 'SafeAreaView');
  return plain(safe.props.edges);
}

test('the iPhone review entry respects the notch and home indicator before test mode starts', () => {
  assert.deepEqual(renderedInsets('/review-mode', 'ios', false), ['top', 'right', 'bottom', 'left']);
});

test('the original photo login keeps its own inset handling on both platforms', () => {
  for (const platform of ['ios', 'android']) assert.deepEqual(renderedInsets('/login', platform, false), []);
});

test('isolated review screens retain their existing outer safe area', () => {
  for (const path of ['/review-mode', '/login', '/home']) {
    for (const platform of ['ios', 'android']) assert.deepEqual(renderedInsets(path, platform, true), ['top', 'right', 'bottom', 'left']);
  }
});

test('other live screens retain existing platform-specific inset handling', () => {
  for (const path of ['/home', '/profile', '/subscription']) {
    assert.deepEqual(renderedInsets(path, 'ios', false), []);
    assert.deepEqual(renderedInsets(path, 'android', false), ['top', 'right', 'bottom', 'left']);
  }
});
