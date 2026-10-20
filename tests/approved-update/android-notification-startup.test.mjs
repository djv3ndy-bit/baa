import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTypescript } from './load-typescript.mjs';

function layout() {
  let path = '/', key, cursor = 0, listeners = 0, stopped = 0, unsubscribed = 0;
  const slots = [], pendingEffects = [], readiness = [];
  const react = {
    useRef(initial) { return slots[cursor++] ||= { current: initial }; },
    useEffect(callback, deps) {
      const index = cursor++, previous = slots[index];
      if (!previous || deps.some((value, i) => value !== previous.deps[i])) {
        pendingEffects.push(() => { previous?.cleanup?.(); slots[index] = { deps, cleanup: callback() }; });
      }
    },
  };
  const jsx = (type, props) => ({ type, props });
  const root = loadTypescript('mobile/app/_layout.tsx', {
    react, 'react/jsx-runtime': { jsx, jsxs: jsx },
    'expo-router': { Stack: 'Stack', usePathname: () => path, useRootNavigationState: () => key ? { key } : undefined },
    'react-native': { Platform: { OS: 'android' } }, 'react-native-safe-area-context': { SafeAreaView: 'SafeAreaView' },
    'expo-status-bar': { StatusBar: 'StatusBar' }, '@/components/AppErrorBoundary': { AppErrorBoundary: 'AppErrorBoundary' },
    '@/lib/pushNotifications': {
      listenForPhoneNotifications(options) {
        listeners++; readiness.push(options.isNavigationReady());
        return Object.assign(() => { stopped++; }, { retryPending: () => readiness.push(options.isNavigationReady()) });
      },
      async registerForPhoneNotifications() {},
    },
    '@/lib/supabase': { supabase: { auth: { async getSession() { return { data: { session: null } }; },
      onAuthStateChange() { return { data: { subscription: { unsubscribe() { unsubscribed++; } } } }; } } } },
    '@/lib/api': { authenticatedApi() { throw new Error('signed-out analytics must not run'); } },
    '@/features/review-mode/AppEnvironmentGate': { AppEnvironmentGate: 'AppEnvironmentGate' },
    '@/features/review-mode/ReviewModeControls': { ReviewModeBanner: 'ReviewModeBanner', ReviewModeEntry: 'ReviewModeEntry' },
    '@/features/review-mode/environment': { getAppEnvironment: () => ({ review: true }) },
  });
  const readyRoot = root.default().props.children.type;
  function render(nextPath = path, nextKey = key) {
    path = nextPath; key = nextKey; cursor = 0; readyRoot();
    while (pendingEffects.length) pendingEffects.shift()();
  }
  render();
  return { render, readiness, listeners: () => listeners, stopped: () => stopped, unsubscribed: () => unsubscribed,
    dispose() { slots.forEach(slot => slot?.cleanup?.()); } };
}

test('root notification wiring waits for both mounted navigation and the completed startup decision without replacing its listener', () => {
  const h = layout();
  assert.deepEqual(h.readiness, [false, false]);
  h.render('/home'); assert.equal(h.readiness.at(-1), false);
  h.render('/', 'root-stack'); assert.equal(h.readiness.at(-1), false);
  h.render('/home', 'root-stack'); assert.equal(h.readiness.at(-1), true);
  assert.equal(h.listeners(), 1); h.dispose(); assert.equal(h.stopped(), 1); assert.equal(h.unsubscribed(), 1);
});

test('Android root retries a pending tap only after login, signup or callback redirects settle on an app route', () => {
  const h = layout();
  for (const route of ['/login', '/signup', '/auth/callback']) {
    h.render(route, 'root-stack'); assert.equal(h.readiness.at(-1), false);
  }
  h.render('/home', 'root-stack'); assert.equal(h.readiness.at(-1), true);
  h.render('/messages', 'root-stack'); assert.equal(h.readiness.at(-1), true);
  h.render('/login', 'root-stack'); assert.equal(h.readiness.at(-1), false);
  assert.equal(h.listeners(), 1); h.dispose();
});
