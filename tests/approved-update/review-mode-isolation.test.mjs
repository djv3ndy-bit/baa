import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from '../../mobile/node_modules/typescript/lib/typescript.js';

function load(path, mocks = {}, env = {}) {
  const module = { exports: {} };
  const source = readFileSync(new URL(`../../mobile/${path}`, import.meta.url), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  vm.runInNewContext(code, { module, exports: module.exports, URL, setTimeout, clearTimeout, process: { env }, require(name) {
    if (!Object.hasOwn(mocks, name)) throw new Error(`Unexpected dependency ${name}`);
    return mocks[name];
  } });
  return module.exports;
}
const policy = load('features/review-mode/environmentController.ts');
const live = { review: false, supabaseUrl: 'https://live.example.invalid', publishableKey: 'live-public', apiBase: 'https://live-api.example.invalid/api' };
const review = { review: true, supabaseUrl: 'https://test.example.invalid', publishableKey: 'test-public', apiBase: 'https://test-api.example.invalid/api' };
function harness(saved = null, configured = live, timeout = 30) {
  const writes = [];
  const storage = { getItem: async () => saved, setItem: async (key, value) => { writes.push([key, value]); saved = value; } };
  return { storage, writes, controller: policy.createEnvironmentController(storage, configured, review, timeout), saved: () => saved };
}
test('first launch keeps the configured live environment and performs no storage writes', async () => {
  const h = harness(); assert.throws(() => h.controller.get(), /still opening/);
  const selected = await h.controller.initialize(); assert.equal(selected.supabaseUrl, live.supabaseUrl); assert.equal(selected.review, false); assert.deepEqual(h.writes, []);
});
test('a saved review session initializes only the review environment and remains immutable', async () => {
  const h = harness('review'); const first = await h.controller.initialize();
  assert.equal(first.apiBase, review.apiBase); assert.equal(first.publishableKey, review.publishableKey);
  assert.throws(() => { first.apiBase = live.apiBase; });
  assert.equal(await h.controller.initialize(), first);
});
test('switching requires sign-out and cannot mix the running client with the next environment', async () => {
  const h = harness(); await h.controller.initialize(); let reloads = 0;
  await assert.rejects(h.controller.switchMode('review', async () => false, async () => { reloads++; }), /Sign out/);
  assert.equal(reloads, 0); assert.deepEqual(h.writes, []);
  await h.controller.switchMode('review', async () => true, async () => { reloads++; });
  assert.equal(h.controller.get().review, false); assert.equal(h.saved(), 'review'); assert.equal(reloads, 1);
  const restarted = policy.createEnvironmentController(h.storage, live, review);
  assert.equal((await restarted.initialize()).review, true);
});
test('returning to live requires test-account sign-out and only takes effect on restart', async () => {
  const h = harness('review'); await h.controller.initialize();
  await assert.rejects(h.controller.switchMode('configured', async () => false, async () => {}), /Sign out/);
  await h.controller.switchMode('configured', async () => true, async () => {});
  assert.equal(h.controller.get().review, true);
  assert.equal((await policy.createEnvironmentController(h.storage, live, review).initialize()).review, false);
});
test('repeated switching taps cannot duplicate the restart or storage write', async () => {
  const h = harness(); await h.controller.initialize(); let finish, reloads = 0;
  const first = h.controller.switchMode('review', () => new Promise(resolve => { finish = resolve; }), async () => { reloads++; });
  await assert.rejects(h.controller.switchMode('review', async () => true, async () => { reloads++; }), /already restarting/);
  finish(true); await first;
  await assert.rejects(h.controller.switchMode('review', async () => true, async () => { reloads++; }), /already restarting/);
  assert.equal(h.writes.length, 1); assert.equal(reloads, 1);
});
test('storage failure never falls back to a live client from a requested review session', async () => {
  let fail = true;
  const storage = { getItem: async () => { if (fail) throw new Error('read failed'); return 'review'; }, setItem: async () => {} };
  const c = policy.createEnvironmentController(storage, live, review);
  await assert.rejects(c.initialize(), /read failed/); assert.throws(c.get, /still opening/);
  fail = false; assert.equal((await c.initialize()).review, true);
});
test('a stalled storage read times out without creating a live environment', async () => {
  const c = policy.createEnvironmentController({ getItem: () => new Promise(() => {}), setItem: async () => {} }, live, review, 5);
  await assert.rejects(c.initialize(), /could not be confirmed/); assert.throws(c.get, /still opening/);
});
test('invalid mode values are rejected instead of silently choosing live', async () => {
  for (const value of ['production', 'https://attacker.invalid', '{}']) await assert.rejects(harness(value).controller.initialize(), /saved app mode/);
});
test('a failed mode save does not trigger a restart', async () => {
  let reloads = 0;
  const h = harness(); h.storage.setItem = async () => { throw new Error('write failed'); };
  await h.controller.initialize(); await assert.rejects(h.controller.switchMode('review', async () => true, async () => { reloads++; }), /write failed/);
  assert.equal(reloads, 0); assert.equal(h.controller.get().review, false); assert.equal(h.controller.restartRequired(), false);
});
test('reload failure leaves the current environment fixed and preserves the explicit next-start choice', async () => {
  const h = harness(); await h.controller.initialize();
  await assert.rejects(h.controller.switchMode('review', async () => true, async () => { throw new Error('restart failed'); }), /restart failed/);
  assert.equal(h.saved(), 'review'); assert.equal(h.controller.get().review, false); assert.equal(h.controller.restartRequired(), true);
});
test('existing test-only builds cannot switch to a nonexistent live connection', async () => {
  const h = harness(null, review); assert.equal((await h.controller.initialize()).review, true);
  assert.equal(h.controller.canReturnToLive(), false);
  await assert.rejects(h.controller.switchMode('configured', async () => true, async () => {}), /no live account connection/);
});

function clientHarness(environment) {
  const created = [], states = [];
  const client = { auth: { startAutoRefresh() {}, stopAutoRefresh() {} } };
  const module = load('lib/supabase.ts', {
    '@react-native-async-storage/async-storage': { default: {} },
    '@supabase/supabase-js': { createClient: (...args) => { created.push(args); return client; }, processLock: 'original-lock' },
    'react-native': { Platform: { OS: 'ios' }, AppState: { addEventListener: (...args) => states.push(args) } },
    './request': { fetchWithTimeout: 'original-transport' },
    './authStorage': { createLockedAuthStorage: () => ({ storage: 'locked-storage', runExclusive: operation => operation() }) },
    '../features/review-mode/environment': { initializeAppEnvironment: async () => environment },
  });
  return { module, created, states, client };
}
for (const env of [live, review]) test(`client startup binds all services and auth storage to ${env.review ? 'review' : 'live'}`, async () => {
  const h = clientHarness(env); assert.equal(h.created.length, 0); assert.equal(h.module.supabase, undefined);
  await Promise.all([h.module.initializeSupabaseEnvironment(), h.module.initializeSupabaseEnvironment()]);
  assert.equal(h.created.length, 1); assert.equal(h.states.length, 1); assert.equal(h.created[0][0], env.supabaseUrl);
  assert.equal(h.module.APP_API_BASE, env.apiBase); assert.equal(h.module.AUTH_API_BASE, `${env.supabaseUrl}/auth/v1`);
  assert.equal(h.module.AUTH_STORAGE_KEY, `sb-${env.review ? 'test' : 'live'}-auth-token`);
  assert.equal(h.created[0][2].auth.autoRefreshToken, true); assert.equal(h.created[0][2].auth.persistSession, true); assert.equal(h.created[0][2].auth.detectSessionInUrl, false);
});
test('API and password requests use the same selected environment and captured session', async () => {
  for (const env of [live, review]) {
    const h = clientHarness(env); await h.module.initializeSupabaseEnvironment();
    h.client.auth.getSession = async () => ({ data: { session: { access_token: `${env.review}-token`, user: { id: 'dedicated-account' } } } });
    const calls = [];
    const api = load('lib/api.ts', { './supabase': h.module, './request': { requestJson: async (...args) => calls.push(args) } });
    await api.authenticatedApi('/native-billing', {}, 'GET', 'dedicated-account');
    await api.updateAccountPassword('dedicated-account', 'test-only-placeholder');
    assert.equal(calls[0][0], `${env.apiBase}/native-billing`); assert.equal(calls[1][0], `${env.supabaseUrl}/auth/v1/user`);
    assert.equal(calls[1][1].headers.apikey, env.publishableKey);
  }
});

const { sandboxOnlyStore } = load('features/review-mode/reviewPurchaseGuard.ts', { '../native-subscription/storeTimeout': { storeResponse: promise => promise } });
function storeHarness(transaction) {
  const calls = [];
  let connected = false;
  const sdk = {
    initConnection: async () => { calls.push('connect'); connected = true; return true; },
    endConnection: async () => { calls.push('disconnect'); connected = false; },
    getAppTransactionIOS: async () => { assert.equal(connected, true); return typeof transaction === 'function' ? transaction() : transaction; },
    requestPurchase: async () => { calls.push('purchase'); return 'requested'; },
    restorePurchases: async () => { calls.push('restore'); },
  };
  return { sdk, calls, store: sandboxOnlyStore(sdk) };
}
test('confirmed Apple Sandbox installation can request and restore a test purchase', async () => {
  const h = storeHarness({ environment: 'Sandbox', bundleId: 'com.baristajobmatch.app' });
  await h.store.initConnection(); assert.equal(await h.store.requestPurchase({}), 'requested'); await h.store.restorePurchases();
  assert.deepEqual(h.calls, ['connect', 'purchase', 'restore']);
});
for (const transaction of [null, { environment: 'Production', bundleId: 'com.baristajobmatch.app' }, { environment: 'Sandbox', bundleId: 'com.other.app' }, { environment: 'Xcode', bundleId: 'com.baristajobmatch.app' }]) test(`unconfirmed or wrong Apple installation cannot start test checkout: ${JSON.stringify(transaction)}`, async () => {
  const h = storeHarness(transaction); await assert.rejects(h.store.initConnection(), /Sandbox installation/);
  assert.deepEqual(h.calls, ['connect', 'disconnect']);
});
test('Apple environment is rechecked before purchase after a successful connection', async () => {
  let environment = 'Sandbox';
  const h = storeHarness(() => ({ environment, bundleId: 'com.baristajobmatch.app' }));
  await h.store.initConnection(); environment = 'Production';
  await assert.rejects(h.store.requestPurchase({}), /Sandbox installation/);
  await assert.rejects(h.store.restorePurchases(), /Sandbox installation/);
  assert.deepEqual(h.calls, ['connect']);
});
