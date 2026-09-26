import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTypescript } from './load-typescript.mjs';

const jsx = (type, props) => ({ type, props });
function options() {
  const { default: RootLayout } = loadTypescript('mobile/app/_layout.tsx', {
    react: { useEffect() {} },
    'react/jsx-runtime': { jsx, jsxs: jsx },
    'expo-router': { Stack: 'stack', usePathname: () => '/home' },
    'react-native': { Platform: { OS: 'ios' } },
    'react-native-safe-area-context': { SafeAreaView: 'safe-area' },
    'expo-status-bar': { StatusBar: 'status-bar' },
    '@/components/AppErrorBoundary': { AppErrorBoundary: 'boundary' },
    '@/lib/pushNotifications': {},
    '@/lib/supabase': {},
    '@/lib/api': {},
    '@/features/review-mode/AppEnvironmentGate': { AppEnvironmentGate: 'gate' },
    '@/features/review-mode/ReviewModeControls': { ReviewModeBanner: 'banner', ReviewModeEntry: 'entry' },
    '@/features/review-mode/environment': { getAppEnvironment: () => ({ review: false }) },
  });
  const ready = RootLayout().props.children;
  function findStack(node) {
    if (node?.type === 'stack') return node;
    for (const child of [node?.props?.children].flat()) {
      const found = child && findStack(child);
      if (found) return found;
    }
  }
  return findStack(ready.type()).props.screenOptions;
}

test('both account types switch between their main sections without an overlapping fade', () => {
  const screenOptions = options();
  for (const name of ['home', 'jobs', 'discover', 'matches', 'messages', 'profile']) {
    const result = screenOptions({ route: { name } });
    assert.equal(result.animation, 'none', name);
    assert.equal(result.headerShown, false, name);
  }
});

test('detail, authentication and payment screens retain their existing transition', () => {
  const screenOptions = options();
  for (const name of ['login', 'signup', 'forgot-password', 'reset-password', 'auth/callback', 'settings', 'subscription', 'post-job', 'job/[id]', 'chat/[id]', 'candidates', 'match-success', 'review-mode']) {
    const result = screenOptions({ route: { name } });
    assert.equal(result.animation, 'fade', name);
    assert.equal(result.headerShown, false, name);
  }
});
