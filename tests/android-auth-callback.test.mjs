import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import vm from 'node:vm';
import test from 'node:test';

const requireMobile = createRequire(new URL('../mobile/package.json', import.meta.url));
const ts = requireMobile('typescript');
const mobileFile = relative => new URL(`../mobile/${relative}`, import.meta.url);
const flush = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const url = id => `baristamatch://auth/callback#access_token=synthetic-${id}&refresh_token=synthetic-refresh-${id}`;
function compile(relative, mocks = {}, cache = new Map()) {
  if (cache.has(relative)) return cache.get(relative);
  const exports = {};
  cache.set(relative, exports);
  const source = ts.transpileModule(readFileSync(mobileFile(relative), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(source, { exports, URL, URLSearchParams, setTimeout: mocks.setTimeout || setTimeout, clearTimeout: mocks.clearTimeout || clearTimeout, require(name) {
    if (name in mocks) return mocks[name];
    if (name.startsWith('.')) return compile(`${path.posix.join(path.posix.dirname(relative), name)}.ts`, mocks, cache);
    if (name.startsWith('@/')) return compile(`${name.slice(2)}.ts`, mocks, cache);
    throw new Error(`Unexpected dependency ${name}`);
  } }, { filename: relative });
  return exports;
}
const { createAndroidAuthCallback, androidAuthCallbackMessage, androidAuthCallbackReference } = compile('lib/androidAuthCallback.ts');

function controller(overrides = {}) {
  const states = [], calls = { exchange: [], context: 0, assert: [], navigate: [] }, timers = new Map();
  let currentUser = 'user-a';
  const api = createAndroidAuthCallback({
    async exchange(value) { calls.exchange.push(value); return { id: 'user-a' }; },
    async context() { calls.context++; return { user: { id: 'user-a' }, role: 'barista' }; },
    async assertCurrentUser(expected) { calls.assert.push(expected); if (currentUser !== expected) throw new Error('synthetic account changed'); },
    navigate(hasRole) { calls.navigate.push(hasRole); },
    changed(state) { states.push(JSON.parse(JSON.stringify(state))); },
    delay(fn, milliseconds) { timers.set(fn, milliseconds); return () => timers.delete(fn); },
    ...overrides,
  });
  api.activate(); api.setNavigationReady(true);
  return { api, calls, states, setCurrentUser(value) { currentUser = value; }, fireTimers(milliseconds = 8000) { for (const [fn, delay] of [...timers]) if (delay <= milliseconds) { timers.delete(fn); fn(); } }, state: () => states.at(-1) };
}

test('accepted callback survives missing route parameters and duplicate delivery while account loading', async () => {
  const account = deferred();
  const h = controller({ context: () => account.promise });
  h.api.receive(url('a')); await flush();
  h.api.receive(null); h.api.receive(url('a')); h.fireTimers();
  assert.equal(h.calls.exchange.length, 1);
  account.resolve({ user: { id: 'user-a' }, role: 'barista' }); await flush();
  assert.deepEqual(h.calls.navigate, [true]); assert.deepEqual(h.calls.assert, ['user-a']);
});

test('warm callback arrives after empty startup and late null initial URL cannot take over', async () => {
  const h = controller(); h.api.receive(null); h.fireTimers();
  assert.equal(h.state().reason, 'missing_callback');
  h.api.receive(url('warm')); h.api.receive(null); await flush();
  h.fireTimers(); assert.deepEqual(h.calls.navigate, [true]); assert.notEqual(h.state().phase, 'failed');
});

test('current rejected or incomplete callback blocks a stale valid initial URL but permits a fresh warm callback', async () => {
  for (const value of ['baristamatch://auth/callback#error=access_denied', 'baristamatch://auth/callback']) {
    const h = controller(); h.api.receive(value); h.api.receive(url('old'), 'initial'); await flush();
    assert.equal(h.calls.exchange.length, 0); assert.equal(h.calls.context, 0); assert.equal(h.state().phase, 'failed');
    h.api.receive(url('new')); await flush(); assert.equal(h.calls.exchange.length, 1); assert.deepEqual(h.calls.navigate, [true]);
  }
});

test('different current callback interrupts pending initial-owned work fail-closed at every async stage', async () => {
  for (const stage of ['exchange', 'account', 'identity']) {
    const gate = deferred(); let exchanges = 0;
    const h = controller({
      exchange: () => { exchanges++; return stage === 'exchange' ? gate.promise : Promise.resolve({ id: 'user-a' }); },
      context: stage === 'account' ? () => gate.promise : async () => ({ user: { id: 'user-a' }, role: 'barista' }),
      assertCurrentUser: stage === 'identity' ? () => gate.promise : async () => {},
    });
    h.api.receive(url('old'), 'initial'); await flush(); h.api.receive(url('new')); await flush();
    assert.equal(h.state().reason, 'callback_changed');
    gate.resolve(stage === 'exchange' ? { id: 'user-a' } : { user: { id: 'user-a' }, role: 'barista' }); await flush();
    h.api.retry(); h.api.receive(url('third')); await flush();
    assert.equal(exchanges, 1); assert.deepEqual(h.calls.navigate, []); assert.equal(h.state().reason, 'callback_changed');
  }
});

test('same-token current confirmation upgrades initial provenance without another exchange', async () => {
  const account = deferred(); const h = controller({ context: () => account.promise });
  h.api.receive(url('a'), 'initial'); await flush();
  h.api.receive('baristamatch://auth/callback?access_token=synthetic-a&refresh_token=synthetic-refresh-a');
  account.resolve({ user: { id: 'user-a' }, role: 'barista' }); await flush();
  assert.equal(h.calls.exchange.length, 1); assert.deepEqual(h.calls.navigate, [true]);
});

test('navigation waits for readiness and rechecks the exchanged account before replacing once', async () => {
  const h = controller(); h.api.setNavigationReady(false); h.api.receive(url('a')); await flush();
  assert.equal(h.state().phase, 'waiting_navigation'); assert.deepEqual(h.calls.navigate, []); assert.deepEqual(h.calls.assert, []);
  h.api.setNavigationReady(true); await flush(); h.api.setNavigationReady(true); await flush();
  assert.deepEqual(h.calls.assert, ['user-a']); assert.deepEqual(h.calls.navigate, [true]);
});

test('account switch while navigation is waiting cannot route the prior callback user', async () => {
  const h = controller(); h.api.setNavigationReady(false); h.api.receive(url('a')); await flush();
  h.setCurrentUser('user-b'); h.api.setNavigationReady(true); await flush();
  assert.equal(h.state().reason, 'session_changed'); assert.deepEqual(h.calls.navigate, []);
});

test('navigation becoming unready during identity check retains the intent and verifies again', async () => {
  const identity = deferred(); let checks = 0;
  const h = controller({ assertCurrentUser: async () => { if (++checks === 1) await identity.promise; } });
  h.api.receive(url('a')); await flush(); h.api.setNavigationReady(false); identity.resolve(); await flush();
  assert.deepEqual(h.calls.navigate, []); assert.equal(h.state().phase, 'waiting_navigation');
  h.api.setNavigationReady(true); await flush(); assert.equal(checks, 2); assert.deepEqual(h.calls.navigate, [true]);
});

for (const [name, value, reason] of [
  ['provider rejection', 'baristamatch://auth/callback#error_description=synthetic-private-detail', 'provider_error'],
  ['missing refresh token', 'baristamatch://auth/callback#access_token=synthetic-only', 'missing_session'],
  ['bare callback', 'baristamatch://auth/callback', 'missing_session'],
]) test(`${name} never exchanges tokens or falls back to an existing session`, async () => {
  const h = controller(); h.api.receive(value); await flush();
  assert.equal(h.state().reason, reason); assert.equal(h.calls.exchange.length, 0); assert.equal(h.calls.context, 0); assert.deepEqual(h.calls.navigate, []);
  h.api.retry(); await flush(); assert.equal(h.calls.context, 0);
  assert.doesNotMatch(androidAuthCallbackMessage({ phase: 'failed', reason }), /synthetic-private|access_token/);
});

test('unrelated and noncanonical links never trigger Auth or account reads', async () => {
  const h = controller();
  for (const value of [null, 'baristamatch://home', 'https://example.invalid/auth/callback', 'baristamatch://auth/callback-evil#access_token=a&refresh_token=b']) h.api.receive(value);
  await flush(); assert.equal(h.calls.exchange.length, 0); assert.equal(h.calls.context, 0);
});

test('mismatched loaded profile context blocks navigation', async () => {
  const h = controller({ context: async () => ({ user: { id: 'user-b' }, role: 'barista' }) });
  h.api.receive(url('a')); await flush(); assert.equal(h.state().reason, 'session_changed'); assert.deepEqual(h.calls.navigate, []);
});

test('no saved role reaches explicit setup only after the exchanged user is confirmed', async () => {
  const h = controller({ context: async () => ({ user: { id: 'user-a' }, role: null }) });
  h.api.receive(url('a')); await flush(); assert.deepEqual(h.calls.assert, ['user-a']); assert.deepEqual(h.calls.navigate, [false]);
});

test('safe retry recovers a failed exchange without exposing raw provider errors', async () => {
  let count = 0;
  const h = controller({ exchange: async () => { if (++count === 1) throw new Error('private_token synthetic-sensitive'); return { id: 'user-a' }; } });
  h.api.receive(url('retry')); await flush(); assert.equal(h.state().reason, 'exchange');
  assert.doesNotMatch(androidAuthCallbackMessage(h.state()), /private_token|synthetic-sensitive/);
  h.api.retry(); await flush(); assert.equal(count, 2); assert.deepEqual(h.calls.navigate, [true]);
});

test('an indefinitely slow exchange, account read or identity check times out and cannot navigate when it finishes late', async () => {
  for (const stage of ['exchange', 'account', 'identity']) {
    const gate = deferred();
    const h = controller({
      exchange: stage === 'exchange' ? () => gate.promise : async () => ({ id: 'user-a' }),
      context: stage === 'account' ? () => gate.promise : async () => ({ user: { id: 'user-a' }, role: 'barista' }),
      assertCurrentUser: stage === 'identity' ? () => gate.promise : async () => {},
    });
    h.api.receive(url('slow')); await flush(); h.fireTimers(8000);
    assert.notEqual(h.state().phase, 'failed');
    h.fireTimers(60000); assert.equal(h.state().reason, 'timeout');
    gate.resolve(stage === 'exchange' ? { id: 'user-a' } : { user: { id: 'user-a' }, role: 'barista' }); await flush();
    assert.equal(h.state().reason, 'timeout'); assert.deepEqual(h.calls.navigate, []);
  }
});

test('timeout retry shares the actual existing token exchange instead of sending concurrent Auth session writes', async () => {
  const gate = deferred(); let sessionWrites = 0;
  const exchange = compile('lib/authCallback.ts').createMobileCallbackExchange(async () => { sessionWrites++; return gate.promise; });
  const h = controller({ exchange }); h.api.receive(url('slow')); await flush();
  h.fireTimers(60000); assert.equal(h.state().reason, 'timeout');
  h.api.retry(); await flush(); assert.equal(sessionWrites, 1);
  gate.resolve({ id: 'user-a' }); await flush();
  assert.equal(sessionWrites, 1); assert.deepEqual(h.calls.assert, ['user-a']); assert.deepEqual(h.calls.navigate, [true]);
});

test('navigation readiness cannot wait forever or reuse a timed-out identity after an account switch', async () => {
  const h = controller(); h.api.setNavigationReady(false); h.api.receive(url('wait')); await flush();
  h.fireTimers(60000); assert.equal(h.state().reason, 'timeout');
  h.setCurrentUser('user-b'); h.api.setNavigationReady(true); await flush(); assert.deepEqual(h.calls.navigate, []);
  h.api.retry(); await flush(); assert.equal(h.state().reason, 'session_changed'); assert.deepEqual(h.calls.navigate, []);
});

test('failure support references contain only fixed stage codes and no Auth material', () => {
  for (const [reason, code] of [['missing_callback', 'A01'], ['provider_error', 'A02'], ['missing_session', 'A03'], ['exchange', 'A04'], ['account', 'A05'], ['session_changed', 'A06'], ['navigation', 'A07'], ['callback_changed', 'A08'], ['timeout', 'A09']]) assert.equal(androidAuthCallbackReference({ phase: 'failed', reason }), code);
  assert.equal(androidAuthCallbackReference({ phase: 'working' }), null);
});

test('account-read and navigation failures remain explicitly retryable', async () => {
  for (const failure of ['account', 'navigation']) {
    let reads = 0, navigation = 0;
    const h = controller({
      context: async () => { if (failure === 'account' && ++reads === 1) throw new Error('synthetic private backend error'); return { user: { id: 'user-a' }, role: 'barista' }; },
      navigate: () => { if (failure === 'navigation' && ++navigation === 1) throw new Error('synthetic navigator unavailable'); navigation++; },
    });
    h.api.receive(url('retry')); await flush(); assert.equal(h.state().reason, failure);
    h.api.retry(); await flush(); assert.notEqual(h.state().phase, 'failed'); assert.ok(navigation > 0);
  }
});

test('different overlapping callback cannot switch an already accepted sign-in', async () => {
  const exchange = deferred(); const h = controller({ exchange: () => exchange.promise });
  h.api.receive(url('a')); h.api.receive(url('b'));
  exchange.resolve({ id: 'user-a' }); await flush(); assert.deepEqual(h.calls.navigate, [true]);
});

test('fresh focus accepts a new warm callback while old rejected work cannot change its generation', async () => {
  const first = deferred(), second = deferred(); let exchanges = 0, reads = 0;
  const navigated = [];
  const h = controller({ exchange: async () => ({ id: ++exchanges === 1 ? 'user-a' : 'user-b' }), context: () => ++reads === 1 ? first.promise : second.promise, assertCurrentUser: async id => { assert.equal(id, 'user-b'); }, navigate: hasRole => navigated.push(hasRole) });
  h.api.receive(url('a')); await flush(); h.api.deactivate(); h.api.activate(); h.api.receive(url('b')); await flush();
  first.reject(new Error('old synthetic account read failed')); await flush(); h.api.retry();
  assert.equal(exchanges, 2);
  second.resolve({ user: { id: 'user-b' }, role: 'barista' }); await flush(); assert.deepEqual(navigated, [true]);
});

test('unmount cancels timeout, pending exchange, account loading and late identity completion', async () => {
  for (const stage of ['exchange', 'account', 'identity', 'empty']) {
    const gate = deferred();
    const h = controller({ exchange: stage === 'exchange' ? () => gate.promise : async () => ({ id: 'user-a' }), context: stage === 'account' ? () => gate.promise : async () => ({ user: { id: 'user-a' }, role: 'barista' }), assertCurrentUser: stage === 'identity' ? () => gate.promise : async () => {} });
    if (stage !== 'empty') h.api.receive(url('a'));
    await flush(); h.api.deactivate(); const states = h.states.length;
    gate.resolve(stage === 'exchange' ? { id: 'user-a' } : { user: { id: 'user-a' }, role: 'barista' });
    await flush(); h.fireTimers(60000); h.api.receive(url('late')); await flush();
    assert.deepEqual(h.calls.navigate, []); assert.equal(h.states.length, states);
  }
});

function screen({ callback: initialCallback = null, ready: initialReady = true, initialURL = Promise.resolve(null), account = Promise.resolve({ user: { id: 'user-a' }, role: 'barista' }) } = {}) {
  let params = {}, ready = initialReady, tree, stateCursor, refCursor, callbackCursor, effectCursor, mounted = true;
  const states = [], refs = [], callbacks = [], effects = [], queued = [], routes = [], exchanges = [], timers = new Map();
  let assertions = 0;
  const cache = new Map();
  const react = {
    useState(value) { const i = stateCursor++; if (!(i in states)) states[i] = value; return [states[i], next => { states[i] = typeof next === 'function' ? next(states[i]) : next; }]; },
    useRef(value) { const i = refCursor++; return refs[i] ||= { current: value }; },
    useCallback(fn, deps) { const i = callbackCursor++, old = callbacks[i]; if (!old || deps.some((value, j) => !Object.is(value, old.deps[j]))) callbacks[i] = { fn, deps }; return callbacks[i].fn; },
    useEffect(fn, deps) { const i = effectCursor++, old = effects[i]; if (!old || deps.some((value, j) => !Object.is(value, old.deps[j]))) queued.push(() => { old?.cleanup?.(); effects[i] = { deps, cleanup: fn() }; }); },
  };
  const jsx = (type, props) => ({ type, props });
  const mocks = {
    react, 'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'Fragment' },
    'react-native': { Platform: { OS: 'android' }, ActivityIndicator: 'ActivityIndicator', Pressable: 'Pressable', SafeAreaView: 'SafeAreaView', StyleSheet: { create: value => value }, Text: 'Text', View: 'View' },
    'expo-router': { router: { replace(value) { routes.push(value); } }, useLocalSearchParams: () => params, useRootNavigationState: () => ready ? { key: 'synthetic-root' } : undefined, useFocusEffect(fn) { react.useEffect(fn, [fn]); } },
    '@/lib/session': { completeMobileAuth: async value => { exchanges.push(value); return { id: 'user-a' }; }, getCurrentContext: () => account, requireCurrentUser: async id => { assertions++; assert.equal(id, 'user-a'); } },
    setTimeout(fn, milliseconds) { timers.set(fn, milliseconds); return fn; }, clearTimeout(fn) { timers.delete(fn); },
  };
  // Exercise the same native-intent handoff and one-time route reference as Router 6.
  // Raw bearer fragments are no longer consumed directly by the callback screen.
  const { redirectSystemPath } = compile('app/+native-intent.tsx', mocks, cache);
  const component = compile('app/auth/callback.android.tsx', mocks, cache).default;
  function deliver(value, initial = false) {
    const route = value === null ? '/auth/callback' : redirectSystemPath({ path: value, initial });
    params = Object.fromEntries(new URL(route, 'https://router.example.invalid').searchParams);
    if (mounted) render();
  }
  function render() { stateCursor = 0; refCursor = 0; callbackCursor = 0; effectCursor = 0; tree = component(); while (queued.length) queued.shift()(); return tree; }
  deliver(initialCallback);
  void initialURL.then(value => { if (mounted) deliver(value, true); });
  return { routes, exchanges, states, render, get assertions() { return assertions; },
    setParams(value) { params = value; render(); }, setReady(value) { ready = value; render(); },
    warm(value) { deliver(value); },
    fireTimers(milliseconds = 8000) { for (const [fn, delay] of [...timers]) if (delay <= milliseconds) { timers.delete(fn); fn(); } },
    unmount() { mounted = false; for (const effect of effects) effect.cleanup?.(); },
  };
}

test('actual Android screen preserves pending callback across valid-to-empty params and waits for root readiness', async () => {
  const account = deferred();
  const ui = screen({ callback: url('a'), ready: false, account: account.promise });
  await flush(); ui.setParams({}); account.resolve({ user: { id: 'user-a' }, role: 'barista' }); await flush();
  ui.fireTimers(); assert.equal(ui.states[0].phase, 'waiting_navigation'); assert.deepEqual(ui.routes, []);
  ui.setReady(true); await flush(); assert.deepEqual(ui.routes, ['/home']); assert.equal(ui.assertions, 1); ui.unmount();
});

test('actual Android screen accepts warm URL before a late empty initial URL without resetting the attempt', async () => {
  const initial = deferred(); const ui = screen({ initialURL: initial.promise });
  ui.warm(url('warm')); await flush(); initial.resolve(null); await flush(); ui.fireTimers(); ui.render();
  assert.deepEqual(ui.routes, ['/home']); assert.notEqual(ui.states[0].phase, 'failed'); ui.unmount();
});

test('actual Android screen never replaces a current provider rejection with a stale valid initial URL', async () => {
  const ui = screen({ callback: 'baristamatch://auth/callback#error=access_denied', initialURL: Promise.resolve(url('stale')) });
  await flush(); assert.equal(ui.states[0].reason, 'provider_error'); assert.deepEqual(ui.exchanges, []); assert.deepEqual(ui.routes, []);
  ui.unmount();
});

test('actual Android screen blocks stale initial-user navigation when fresh current params arrive later', async () => {
  const account = deferred(); const ui = screen({ initialURL: Promise.resolve(url('stale')), account: account.promise });
  await flush(); ui.warm(url('fresh'));
  account.resolve({ user: { id: 'user-a' }, role: 'barista' }); await flush();
  assert.equal(ui.states[0].reason, 'callback_changed'); assert.equal(ui.exchanges.length, 1); assert.deepEqual(ui.routes, []); ui.unmount();
});

test('actual Android screen ignores late initial URL resolution after unmount', async () => {
  const initial = deferred(); const ui = screen({ initialURL: initial.promise }); ui.unmount(); const before = ui.states[0];
  initial.resolve(url('late')); await flush(); ui.fireTimers(); assert.equal(ui.states[0], before); assert.deepEqual(ui.routes, []);
});

test('actual Android screen gives safe timeout recovery instead of spinning forever on a slow account request', async () => {
  const account = deferred(); const ui = screen({ callback: url('a'), account: account.promise });
  await flush(); ui.fireTimers(60000); ui.render();
  assert.equal(ui.states[0].reason, 'timeout'); assert.equal(androidAuthCallbackReference(ui.states[0]), 'A09');
  assert.match(androidAuthCallbackMessage(ui.states[0]), /connection/);
  account.resolve({ user: { id: 'user-a' }, role: 'barista' }); await flush(); assert.deepEqual(ui.routes, []); ui.unmount();
});
