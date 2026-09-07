import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import vm from 'node:vm';
const sourceRoot = process.env.BJM_ACCOUNT_SOURCE_ROOT || fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(new URL('../mobile/package.json', import.meta.url));
const ts = require('typescript');
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(done => setTimeout(done, 0)); };
const deferred = () => { let resolve; return { promise: new Promise(done => resolve = done), resolve: value => resolve(value) }; };
const clean = value => JSON.parse(JSON.stringify(value));
const member = (id, role = 'barista') => ({ user: { id, email: `${id}@example.invalid` }, role, profile: { id, role } });
function harness(file, options = {}) {
  let current = options.member || member('account-a'), contextCalls = 0, hookIndex = 0, tree, focusCallback, focusCleanup;
  const hooks = [], effects = [], callbacks = [], routes = [], alerts = [], requests = [], passwordCalls = [], cleared = [], rawUpdates = [];
  const depsEqual = (a, b) => a && b && a.length === b.length && a.every((value, i) => value === b[i]);
  const react = {
    useState(initial) { const id = hookIndex++; if (!(id in hooks)) hooks[id] = typeof initial === 'function' ? initial() : initial; return [hooks[id], value => { hooks[id] = typeof value === 'function' ? value(hooks[id]) : value; }]; },
    useRef(initial) { const id = hookIndex++; if (!(id in hooks)) hooks[id] = { current: initial }; return hooks[id]; },
    useCallback(callback, deps) { const id = hookIndex++; if (!hooks[id] || !depsEqual(hooks[id].deps, deps)) hooks[id] = { callback, deps }; return hooks[id].callback; },
    useEffect(effect, deps) { const id = hookIndex++; if (!hooks[id] || !depsEqual(hooks[id].deps, deps)) { hooks[id]?.cleanup?.(); effects.push(() => { hooks[id] = { deps, cleanup: effect() }; }); } },
  };
  const session = () => current?.user ? { user: current.user, access_token: `${current.user.id}-token` } : null;
  const auth = { getSession: async () => ({ data: { session: session() } }), onAuthStateChange(callback) { callbacks.push(callback); return { data: { subscription: { unsubscribe() {} } } }; }, stopAutoRefresh() {}, async signOut() { cleared.push(current.user.id); }, async updateUser(value) { rawUpdates.push({ id: current.user.id, value }); return {}; } };
  const api = {
    async requireAccountSession(expected) { const captured = session(); if (!captured || captured.user.id !== expected) throw new Error('The signed-in account changed.'); if (options.requireSession) await options.requireSession(expected); return captured; },
    async authenticatedApi(path, body, method, expected) { await api.requireAccountSession(expected); requests.push({ path, body, method, expected }); return options.api ? options.api(path, expected) : path === '/billing-status' ? { plan: 'free', status: 'active', connectedToBilling: false } : { success: true }; },
    async updateAccountPassword(expected, password) { await api.requireAccountSession(expected); passwordCalls.push({ expected, password }); if (options.password) await options.password(); },
  };
  const native = { StyleSheet: { create: value => value }, Alert: { alert: (...args) => alerts.push(args) }, Linking: { openURL: async () => {}, openSettings: async () => {} } };
  for (const name of ['View', 'Text', 'Pressable', 'SafeAreaView', 'ScrollView', 'TextInput', 'ActivityIndicator']) native[name] = name;
  const jsx = (type, props) => ({ type, props: props || {} }), modules = new Map();
  function load(file) {
    file = resolve(sourceRoot, file);
    if (!existsSync(file)) file = existsSync(`${file}.ts`) ? `${file}.ts` : `${file}.tsx`;
    if (modules.has(file)) return modules.get(file).exports;
    const module = { exports: {} }; modules.set(file, module);
    function localRequire(name) {
      if (name === 'react') return react;
      if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx, Fragment: 'Fragment' };
      if (name === 'react-native') return native;
      if (name === 'expo-router') return { router: { replace: route => routes.push(route), push: route => routes.push(route), back: () => routes.push('back') }, useFocusEffect: callback => { focusCallback = callback; } };
      if (name === 'expo-web-browser') return { openBrowserAsync: async () => {} };
      if (name === '@react-native-async-storage/async-storage') return { multiRemove: async keys => cleared.push(keys) };
      if (name.endsWith('/supabase') || name === './supabase') return { supabase: { auth }, AUTH_STORAGE_KEY: 'test-auth' };
      if (name.endsWith('/session') || name === './session') return { getCurrentContext: async () => options.context ? options.context(++contextCalls, current) : current };
      if (name.endsWith('/api')) return api;
      if (name.endsWith('/pushNotifications')) return { registerForPhoneNotifications: async () => ({ status: 'enabled' }), unregisterThisDeviceNotifications: async () => {} };
      if (name.startsWith('@/')) return load(`mobile/${name.slice(2)}`);
      if (name.startsWith('./')) return load(resolve(dirname(file), name));
      throw new Error(`Unexpected native dependency ${name}`);
    }
    const output = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
    vm.runInNewContext(output, { module, exports: module.exports, require: localRequire, console, Date, Error, URL, setTimeout, clearTimeout }, { filename: file });
    return module.exports;
  }
  const Component = load(file).default;
  const expand = node => Array.isArray(node) ? node.map(expand) : node && typeof node === 'object' ? typeof node.type === 'function' ? expand(node.type(node.props)) : { ...node, props: { ...node.props, children: expand(node.props.children) } } : node;
  const textOf = node => Array.isArray(node) ? node.map(textOf).join(' ') : typeof node === 'string' || typeof node === 'number' ? String(node) : node && typeof node === 'object' ? textOf(node.props.children) : '';
  function render() { hookIndex = 0; tree = expand(Component()); effects.splice(0).forEach(effect => effect()); }
  function all(type) { const nodes = []; function visit(node) { if (Array.isArray(node)) node.forEach(visit); else if (node && typeof node === 'object') { if (node.type === type) nodes.push(node); visit(node.props.children); } } visit(tree); return nodes; }
  render();
  return { render, routes, alerts, requests, passwordCalls, rawUpdates, cleared, all, load, text: () => textOf(tree), focus: () => { focusCleanup = focusCallback(); }, blur: () => focusCleanup?.(), change(next, event = next?.user ? 'SIGNED_IN' : 'SIGNED_OUT') { current = next; callbacks.forEach(callback => callback(event, session())); }, press(label) { const node = all('Pressable').find(node => textOf(node).trim().startsWith(label)); assert.ok(node, `${label} exists`); assert.ok(!node.props.disabled, `${label} enabled`); return node.props.onPress(); } };
}
async function loadedSettings(options) { const h = harness('mobile/app/settings.tsx', options); h.focus(); await settle(); h.render(); return h; }
function deletePrompt(h) { h.press('Advanced settings'); h.render(); h.press('Delete my account'); return h.alerts.at(-1)[2].find(button => button.text === 'Continue').onPress; }
for (const file of ['mobile/app/subscription.tsx', 'mobile/app/cafe-trial.tsx']) {
  test(`${file}: guest, barista and incomplete profiles never render café prices`, async () => {
    for (const [account, route] of [[{ user: null, role: null, profile: null }, '/login'], [member('barista'), '/home'], [member('pending', null), { pathname: '/signup', params: { complete: '1' } }]]) {
      const h = harness(file, { member: account }); assert.doesNotMatch(h.text(), /\$0|\$9\.99|FREE CAFÉ PLAN/); h.focus(); await settle(); h.render(); assert.doesNotMatch(h.text(), /\$0|\$9\.99|FREE CAFÉ PLAN/); assert.deepEqual(clean(h.routes.at(-1)), route);
    }
  });
  test(`${file}: prices appear only after café confirmation and disappear immediately on signout`, async () => {
    const gate = deferred(), h = harness(file, { member: member('cafe', 'cafe_owner_manager'), context: (call, current) => call === 1 ? gate.promise : current });
    h.focus(); h.render(); assert.doesNotMatch(h.text(), /\$0|\$9\.99/); gate.resolve(member('cafe', 'cafe_owner_manager')); await settle(); h.render(); assert.match(h.text(), /\$0/);
    h.change({ user: null, role: null, profile: null }); h.render(); assert.doesNotMatch(h.text(), /\$0|\$9\.99/); await settle(); assert.equal(h.routes.at(-1), '/login');
  });
  test(`${file}: lookup failure offers retry and an older café response cannot reveal prices for a barista`, async () => {
    const old = deferred(); let failing = true;
    const h = harness(file, { member: member('cafe', 'cafe_owner_manager'), context: async (call, current) => { if (call === 1 && failing) throw new Error('Connection unavailable'); if (call === 2) return old.promise; return current; } });
    h.focus(); await settle(); h.render(); assert.match(h.text(), /Connection unavailable/); assert.doesNotMatch(h.text(), /\$0|\$9\.99/); failing = false; h.press('Try again');
    h.change(member('barista')); await settle(); old.resolve(member('cafe', 'cafe_owner_manager')); await settle(); h.render(); assert.doesNotMatch(h.text(), /\$0|\$9\.99/); assert.equal(h.routes.at(-1), '/home');
  });
}
test('Settings captures the displayed account when opening the first deletion confirmation', async () => {
  const h = await loadedSettings(); const continueDeleting = deletePrompt(h);
  h.change(member('account-b')); await settle(); h.render(); continueDeleting();
  assert.equal(h.alerts.at(-1)[0], 'Account changed'); assert.equal(h.requests.length, 0); assert.equal(h.cleared.length, 0);
});
test('the final Settings deletion confirmation cannot delete an account signed in afterward', async () => {
  const h = await loadedSettings(); deletePrompt(h)(); const confirm = h.alerts.at(-1)[2].find(button => button.text === 'Delete permanently').onPress;
  h.change(member('account-b')); await settle(); h.render(); confirm(); await settle();
  assert.equal(h.requests.length, 0); assert.equal(h.cleared.length, 0); assert.equal(h.alerts.at(-1)[0], 'Could not delete account');
});
test('Settings sends one deletion for the confirmed account and never clears a newly signed-in account', async () => {
  const gate = deferred(), h = await loadedSettings({ api: path => path === '/delete-account' ? gate.promise : {} });
  deletePrompt(h)(); const confirm = h.alerts.at(-1)[2].find(button => button.text === 'Delete permanently').onPress; confirm(); confirm(); await settle();
  assert.equal(h.requests.length, 1); assert.equal(h.requests[0].expected, 'account-a'); h.change(member('account-b')); await settle(); gate.resolve({ success: true }); await settle();
  assert.equal(h.cleared.length, 0); assert.deepEqual(clean(h.requests[0].body), { confirmation: 'DELETE' });
});
test('Settings binds password changes to the displayed account and never calls the mutable-session SDK method', async () => {
  const gate = deferred(), h = await loadedSettings({ password: () => gate.promise }); h.press('Change password'); h.render();
  h.all('TextInput').forEach(input => input.props.onChangeText('a-long-test-password')); h.render(); h.press('Save new password'); await settle();
  h.change(member('account-b')); await settle(); gate.resolve(); await settle();
  assert.deepEqual(clean(h.passwordCalls), [{ expected: 'account-a', password: 'a-long-test-password' }]); assert.equal(h.rawUpdates.length, 0);
});
test('Settings discards an old café billing response after a barista signs in', async () => {
  const gate = deferred(), h = harness('mobile/app/settings.tsx', { member: member('cafe', 'cafe_owner_manager'), api: () => gate.promise });
  h.focus(); await settle(); h.change(member('barista')); await settle(); gate.resolve({ plan: 'pro', connectedToBilling: true, status: 'active' }); await settle(); h.render();
  assert.match(h.text(), /barista@example.invalid/); assert.doesNotMatch(h.text(), /Subscription|\$9\.99|Free · Active/);
});
test('Settings recovers after a profile error instead of leaving account controls loading forever', async () => {
  const h = await loadedSettings({ context: async (call, current) => { if (call === 1) throw new Error('Profile unavailable'); return current; } });
  assert.match(h.text(), /Account unavailable/); h.press('Try again'); await settle(); h.render(); assert.match(h.text(), /account-a@example.invalid/); assert.doesNotMatch(h.text(), /Loading your account|Account unavailable/);
});

test('Settings does not navigate to plans after the user leaves while account verification is pending', async () => {
  const gate = deferred(); let pause = false;
  const h = await loadedSettings({ member: member('cafe', 'cafe_owner_manager'), requireSession: () => pause ? gate.promise : Promise.resolve() });
  pause = true; h.press('View Free and Pro plans'); h.blur(); gate.resolve(); await settle();
  assert.equal(h.routes.includes('/subscription'), false);
});
test('deletion cleanup preserves an account that signs in while auto-refresh is stopping', async () => {
  const gate = deferred(), h = harness('mobile/app/settings.tsx'); let current = 'deleted-account'; const cleared = [];
  const cleanup = h.load('mobile/lib/accountDeletion').clearDeletedSession;
  const auth = { getSession: async () => ({ data: { session: { user: { id: current } } } }), stopAutoRefresh: () => gate.promise, signOut: async () => { cleared.push(current); } };
  const pending = cleanup(auth, { multiRemove: async () => cleared.push('storage') }, 'test-auth', 'deleted-account');
  await settle(); current = 'new-account'; gate.resolve(); const result = await pending;
  assert.deepEqual(cleared, []); assert.equal(result, false);
});
