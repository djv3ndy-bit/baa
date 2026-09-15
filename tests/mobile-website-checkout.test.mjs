import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const require = createRequire(new URL('../mobile/package.json', import.meta.url));
const ts = require('typescript');
const flush = async () => { for (let i = 0; i < 80; i++) await Promise.resolve(); };
const deferred = () => { let resolve; return { promise: new Promise(done => { resolve = done; }), resolve: value => resolve(value) }; };
const free = { status: 'free', plan: 'free', currentPeriodEnd: null, cancelAtPeriodEnd: false, connectedToBilling: false, billingPaused: false };
const pro = { ...free, status: 'active', plan: 'pro', connectedToBilling: true };
const checkoutUrl = 'https://checkout.stripe.com/c/pay/cs_test_abc';
const successReturn = { billing: 'success', sessionId: 'cs_test_abc' };

function harness(options = {}) {
  let accountId = options.accountId === undefined ? 'cafe-a' : options.accountId;
  let authAccount = accountId, returnInfo = options.returnInfo, country = options.country === undefined ? 'USA' : options.country;
  let index = 0, rendered, queued = false, isFocused = false, focusCallback, focusCleanup, clock = 0, nextTimer = 0, countryCalls = 0;
  const hooks = [], effects = [], appListeners = new Set(), timers = new Map(), requests = [], opened = [];
  const sameDeps = (left, right) => left && right && left.length === right.length && left.every((value, i) => value === right[i]);
  const schedule = () => { if (!queued) { queued = true; Promise.resolve().then(() => { queued = false; render(); }); } };
  const react = {
    useState(initial) { const id = index++; if (!(id in hooks)) hooks[id] = typeof initial === 'function' ? initial() : initial; return [hooks[id], value => { hooks[id] = typeof value === 'function' ? value(hooks[id]) : value; schedule(); }]; },
    useRef(initial) { const id = index++; if (!(id in hooks)) hooks[id] = { current: initial }; return hooks[id]; },
    useCallback(callback, deps) { const id = index++; if (!hooks[id] || !sameDeps(hooks[id].deps, deps)) hooks[id] = { callback, deps }; return hooks[id].callback; },
    useEffect(effect, deps) { const id = index++; if (!hooks[id] || !sameDeps(hooks[id].deps, deps)) { const previous = hooks[id]; hooks[id] = { deps }; effects.push(() => { previous?.cleanup?.(); hooks[id].cleanup = effect(); }); } },
  };
  const api = {
    async requireAccountSession(expected) {
      if (!authAccount || expected !== authAccount) throw new Error('The signed-in account changed.');
      if (options.session) await options.session(expected);
      return { user: { id: authAccount }, access_token: 'mock-token' };
    },
    async authenticatedApi(path, body, method, expected) {
      await api.requireAccountSession(expected);
      requests.push({ path, body: JSON.parse(JSON.stringify(body)), method, expected });
      if (options.api) return options.api(path, body, expected, requests);
      if (path === '/billing-status') return options.billing || free;
      if (path === '/confirm-checkout-session') return { confirmed: false, pending: true };
      return { url: checkoutUrl };
    },
  };
  const native = {
    Platform: { OS: options.platform || 'ios' },
    AppState: { currentState: 'active', addEventListener: (name, callback) => { assert.equal(name, 'change'); appListeners.add(callback); return { remove: () => appListeners.delete(callback) }; } },
    Linking: { async openURL(url) { opened.push(url); if (options.openURL) return options.openURL(url); } },
  };
  const modules = new Map();
  function load(path) {
    if (modules.has(path)) return modules.get(path).exports;
    const module = { exports: {} }; modules.set(path, module);
    const javascript = ts.transpileModule(readFileSync(new URL(`../mobile/lib/${path}.ts`, import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
    vm.runInNewContext(javascript, {
      module, exports: module.exports, Error, URL, console,
      setTimeout(callback, delay) { const id = ++nextTimer; timers.set(id, { callback, at: clock + delay }); return id; },
      clearTimeout(id) { timers.delete(id); },
      require(name) {
        if (name === 'react') return react;
        if (name === 'react-native') return native;
        if (name === 'expo-router') return { useFocusEffect(callback) { react.useEffect(() => { focusCallback = callback; if (isFocused) focusCleanup = callback(); return () => { focusCleanup?.(); focusCleanup = null; }; }, [callback]); } };
        if (name === '@/modules/baristamatch-storefront') return { getStorefrontCountryCode: async () => options.storefront ? options.storefront(++countryCalls) : country };
        if (name === './api') return api;
        if (name === './websiteCheckout') return load('websiteCheckout');
        throw new Error(`Unexpected module ${name}`);
      },
    }, { filename: `${path}.ts` });
    return module.exports;
  }
  const useWebsiteCheckout = load('useWebsiteCheckout').useWebsiteCheckout;
  function render() { index = 0; rendered = useWebsiteCheckout(accountId, returnInfo); effects.splice(0).forEach(effect => effect()); }
  render();
  return {
    requests, opened, helpers: load('websiteCheckout'),
    get value() { return rendered; },
    focus() { isFocused = true; focusCleanup = focusCallback(); },
    blur() { isFocused = false; focusCleanup?.(); focusCleanup = null; },
    appState(next) { native.AppState.currentState = next; [...appListeners].forEach(callback => callback(next)); },
    setCountry(next) { country = next; },
    setAuth(next) { authAccount = next; },
    setAccount(next) { authAccount = next; accountId = next; render(); },
    setReturnInfo(next) { returnInfo = next; render(); },
    async advance(milliseconds) { clock += milliseconds; for (const [id, timer] of [...timers]) if (timer.at <= clock) { timers.delete(id); timer.callback(); } await flush(); },
    confirms: () => requests.filter(request => request.path === '/confirm-checkout-session'),
    creates: () => requests.filter(request => request.path === '/create-checkout-session'),
  };
}

async function loaded(options) { const h = harness(options); h.focus(); await flush(); return h; }

test('billing and storefront are read only for a focused account', async () => {
  const h = harness(); await flush(); assert.equal(h.requests.length, 0); h.focus(); await flush();
  assert.equal(h.value.billing.plan, 'free'); assert.equal(h.value.storefrontCountryCode, 'USA'); assert.equal(h.value.storefrontChecked, true); assert.equal(h.value.loading, false);
  const guest = await loaded({ accountId: null }); await guest.value.subscribe(); await guest.value.refresh(); assert.equal(guest.requests.length, 0);
});

test('U.S. checkout uses the reviewed account, external browser, and one request for rapid taps', async () => {
  const gate = deferred(), h = await loaded({ api: path => path === '/create-checkout-session' ? gate.promise : free });
  const first = h.value.subscribe(); const second = h.value.subscribe(); await flush();
  assert.equal(h.creates().length, 1); assert.deepEqual(h.creates()[0], { path: '/create-checkout-session', body: { channel: 'mobile' }, method: 'POST', expected: 'cafe-a' });
  gate.resolve({ url: checkoutUrl }); await Promise.all([first, second]); await flush();
  assert.deepEqual(h.opened, [checkoutUrl]); assert.equal(h.value.opening, false); assert.equal(h.value.billing.plan, 'free'); assert.doesNotMatch(h.value.notice, /Pro subscription is active/);
});

for (const status of ['active', 'trialing', 'past_due', 'unpaid', 'incomplete']) {
  test(`${status} subscriptions use management and never create duplicate checkout`, async () => {
    const h = await loaded({ billing: { ...pro, status } }); await h.value.subscribe(); await flush();
    assert.equal(h.creates().length, 0); assert.match(h.value.error, /already has a subscription/);
  });
}

test('paused billing and explicit management capability block a new subscription', async () => {
  for (const billing of [{ ...free, billingPaused: true }, { ...free, canManageBilling: true }]) {
    const h = await loaded({ billing }); await h.value.subscribe(); await flush(); assert.equal(h.creates().length, 0); assert.ok(h.value.error);
  }
});

test('billing is rechecked before checkout to catch newly active or paused accounts', async () => {
  for (const latest of [pro, { ...free, billingPaused: true }]) {
    let reads = 0; const h = await loaded({ api: path => path === '/billing-status' ? (++reads === 1 ? free : latest) : { url: checkoutUrl } });
    await h.value.subscribe(); await flush(); assert.equal(h.creates().length, 0); assert.equal(h.value.billing, latest);
  }
});

test('non-U.S., unknown, and Android storefronts never create checkout', async () => {
  for (const options of [{ country: 'FRA' }, { country: null }, { platform: 'android', country: null }]) {
    const h = await loaded(options); await h.value.subscribe(); await flush(); assert.equal(h.creates().length, 0); assert.equal(h.opened.length, 0); assert.ok(h.value.error);
  }
});

test('storefront changes after display are checked before creating checkout', async () => {
  const h = await loaded(); h.setCountry('FRA'); await h.value.subscribe(); await flush();
  assert.equal(h.creates().length, 0); assert.equal(h.value.storefrontCountryCode, 'FRA');
});

test('storefront changes while the checkout request runs prevent browser launch', async () => {
  const gate = deferred(), h = await loaded({ api: path => path === '/create-checkout-session' ? gate.promise : free });
  const action = h.value.subscribe(); await flush(); h.setCountry('CAN'); gate.resolve({ url: checkoutUrl }); await action; await flush();
  assert.equal(h.creates().length, 1); assert.equal(h.opened.length, 0); assert.equal(h.value.storefrontCountryCode, 'CAN');
});

test('an unresponsive storefront query times out safely and Retry recovers', async () => {
  const gate = deferred(); let calls = 0; const h = harness({ storefront: () => ++calls === 1 ? gate.promise : 'USA' });
  h.focus(); await flush(); assert.equal(h.value.loading, true); await h.advance(8000);
  assert.equal(h.value.loading, false); assert.equal(h.value.storefrontChecked, true); assert.match(h.value.error, /App Store region/);
  await h.value.refresh(); await flush(); assert.equal(h.value.error, ''); assert.equal(h.value.storefrontCountryCode, 'USA'); gate.resolve('FRA'); await flush(); assert.equal(h.value.storefrontCountryCode, 'USA');
});

for (const url of ['http://checkout.stripe.com/pay', 'https://checkout.stripe.com.evil.invalid/pay', 'https://checkout.stripe.com@evil.invalid/pay', 'https://user:password@checkout.stripe.com/pay', 'https://checkout.stripe.com:444/pay', 'https://billing.stripe.com/pay', 'javascript:alert(1)', null]) {
  test(`untrusted checkout destination ${url} is never opened`, async () => {
    const h = await loaded({ api: path => path === '/billing-status' ? free : { url } }); await h.value.subscribe(); await flush(); assert.equal(h.opened.length, 0); assert.ok(h.value.error);
  });
}

test('account changes discard an in-flight checkout and leave the new account usable', async () => {
  const gate = deferred(), h = await loaded({ api: path => path === '/create-checkout-session' ? gate.promise : free });
  const action = h.value.subscribe(); await flush(); h.setAccount('cafe-b'); await flush(); gate.resolve({ url: checkoutUrl }); await action; await flush();
  assert.equal(h.opened.length, 0); assert.equal(h.value.billing.plan, 'free'); assert.equal(h.value.opening, false); assert.equal(h.value.notice, ''); assert.ok(h.requests.some(request => request.path === '/billing-status' && request.expected === 'cafe-b'));
});

test('a changed authenticated session prevents opening even before the screen rerenders', async () => {
  const gate = deferred(), h = await loaded({ api: path => path === '/create-checkout-session' ? gate.promise : free });
  const action = h.value.subscribe(); await flush(); h.setAuth('cafe-b'); gate.resolve({ url: checkoutUrl }); await action; await flush(); assert.equal(h.opened.length, 0); assert.match(h.value.error, /account changed/);
});

test('blur and background prevent stale checkout from opening and foreground reloads status', async () => {
  for (const leave of ['blur', 'background']) {
    const gate = deferred(); let paid = false;
    const h = await loaded({ api: path => path === '/create-checkout-session' ? gate.promise : paid ? pro : free });
    const action = h.value.subscribe(); await flush(); if (leave === 'blur') h.blur(); else h.appState('background');
    gate.resolve({ url: checkoutUrl }); await action; await flush(); assert.equal(h.opened.length, 0);
    paid = true; if (leave === 'blur') h.focus(); else h.appState('active'); await flush(); assert.equal(h.value.billing.plan, 'pro'); assert.equal(h.value.opening, false);
  }
});

test('an older account billing response cannot replace the new account', async () => {
  const gate = deferred(), h = harness({ api: (path, body, expected) => expected === 'cafe-a' ? gate.promise : free });
  h.focus(); await flush(); h.setAccount('cafe-b'); await flush(); gate.resolve(pro); await flush(); assert.equal(h.value.billing.plan, 'free'); assert.equal(h.value.notice, '');
  h.setAccount(null); await flush(); assert.equal(h.value.billing, null); assert.equal(h.value.storefrontCountryCode, null);
});

test('success return confirms ownership on the server and waits for fresh Pro billing', async () => {
  let confirmations = 0;
  const h = await loaded({ returnInfo: successReturn, api: path => path === '/confirm-checkout-session' ? (++confirmations === 1 ? { confirmed: false, pending: true } : { confirmed: true, status: 'active' }) : confirmations >= 2 ? pro : free });
  assert.equal(h.confirms().length, 1); assert.equal(h.value.billing.plan, 'free'); assert.doesNotMatch(h.value.notice, /is active/);
  await h.advance(1499); assert.equal(h.confirms().length, 1); await h.advance(1);
  assert.equal(h.confirms().length, 2); assert.deepEqual(h.confirms()[0].body, { sessionId: successReturn.sessionId }); assert.ok(h.confirms().every(request => request.expected === 'cafe-a'));
  assert.equal(h.value.billing.plan, 'pro'); assert.equal(h.value.notice, 'Your Pro subscription is active.'); assert.equal(h.value.loading, false);
});

for (const confirmation of [{ confirmed: false, pending: true }, { confirmed: true, status: 'active' }]) {
  test(`return ${JSON.stringify(confirmation)} cannot grant Pro while authoritative billing is free`, async () => {
    const h = await loaded({ returnInfo: successReturn, api: path => path === '/confirm-checkout-session' ? confirmation : free });
    for (let i = 0; i < 4; i++) await h.advance(1500);
    assert.equal(h.confirms().length, 5); assert.equal(h.value.billing.plan, 'free'); assert.equal(h.value.notice, ''); assert.match(h.value.error, /still being confirmed.*check your subscription status/); assert.equal(h.value.loading, false);
    await h.advance(10000); assert.equal(h.confirms().length, 5);
  });
}

test('connected billing alone and payment-problem states never claim Pro activation', async () => {
  const h = await loaded({ returnInfo: successReturn, api: path => path === '/confirm-checkout-session' ? { confirmed: true, status: 'past_due' } : { ...pro, status: 'past_due' } });
  assert.equal(h.value.notice, ''); assert.match(h.value.error, /needs attention/); assert.equal(h.confirms().length, 1);
});

test('malformed success and unknown return parameters never call confirmation or grant access', async () => {
  for (const returnInfo of [{ billing: 'success', sessionId: '../evil' }, { billing: 'success', sessionId: ['cs_test_abc'] }, { billing: 'paid' }, { sessionId: 'cs_test_abc' }]) {
    const h = await loaded({ returnInfo }); assert.equal(h.confirms().length, 0); assert.equal(h.value.billing.plan, 'free'); assert.match(h.value.error, /checkout return/);
  }
});

test('cancellation refreshes actual status without claiming no charge or successful payment', async () => {
  const h = await loaded({ returnInfo: { billing: 'canceled' } }); assert.equal(h.confirms().length, 0); assert.match(h.value.notice, /Checkout closed/); assert.doesNotMatch(h.value.notice, /charged|paid|is active/);
});

test('a checkout return is never replayed under a different account', async () => {
  const gate = deferred(), h = await loaded({ returnInfo: successReturn, api: path => path === '/confirm-checkout-session' ? gate.promise : free });
  h.setAccount('cafe-b'); await flush(); gate.resolve({ confirmed: true, status: 'active' }); await flush();
  assert.ok(h.confirms().every(request => request.expected === 'cafe-a')); assert.equal(h.value.notice, ''); assert.equal(h.value.billing.plan, 'free'); assert.match(h.value.error, /no longer current/);
});

test('blur cancels confirmation retry timers and cannot overwrite another account', async () => {
  const h = await loaded({ returnInfo: successReturn }); assert.equal(h.confirms().length, 1); h.blur(); await h.advance(10000); assert.equal(h.confirms().length, 1);
  h.setAccount('cafe-b'); h.focus(); await flush(); assert.equal(h.confirms().length, 1); assert.equal(h.value.notice, '');
});

test('foreground recovery refreshes server billing without treating a URL as proof of payment', async () => {
  let billing = free; const h = await loaded({ api: () => billing }); h.appState('background'); billing = pro; h.appState('active'); await flush();
  assert.equal(h.value.billing.plan, 'pro'); assert.equal(h.value.notice, ''); assert.equal(h.confirms().length, 0);
});

test('billing failures prevent checkout, and browser failures release the tap lock', async () => {
  const broken = await loaded({ api: async () => { throw new Error('Billing unavailable'); } }); await broken.value.subscribe(); await flush(); assert.equal(broken.creates().length, 0); assert.equal(broken.value.billing, null);
  let opens = 0; const h = await loaded({ openURL: async () => { if (++opens === 1) throw new Error('Browser unavailable'); } });
  await h.value.subscribe(); await flush(); assert.equal(h.value.opening, false); assert.match(h.value.error, /Browser unavailable/);
  await h.value.subscribe(); await flush(); assert.equal(opens, 2); assert.equal(h.value.opening, false);
});

test('new return parameters are handled after the browser brings the app back', async () => {
  let confirmations = 0; const h = await loaded({ api: path => path === '/confirm-checkout-session' ? (++confirmations, { confirmed: true, status: 'active' }) : confirmations ? pro : free });
  h.appState('background'); h.setReturnInfo(successReturn); h.appState('active'); await flush(); assert.equal(h.confirms().length, 1); assert.equal(h.value.notice, 'Your Pro subscription is active.');
});

test('a legacy success return without session ID polls trusted billing, never confirmation or another checkout', async () => {
  let reads = 0;
  const h = await loaded({ returnInfo: { billing: 'success' }, api: () => (++reads >= 3 ? pro : free) });
  assert.equal(h.value.billing.plan, 'free'); assert.equal(h.confirms().length, 0);
  await h.advance(1500); await h.advance(1500);
  assert.equal(h.value.billing.plan, 'pro'); assert.equal(h.value.notice, 'Your current Pro subscription is active.'); assert.equal(h.confirms().length, 0); assert.equal(h.creates().length, 0);
});

test('an unconfirmed legacy return stops after five billing reads and never asks the customer to pay again', async () => {
  const h = await loaded({ returnInfo: { billing: 'success' } });
  for (let i = 0; i < 4; i++) await h.advance(1500);
  assert.equal(h.requests.filter(request => request.path === '/billing-status').length, 5);
  assert.equal(h.confirms().length, 0); assert.equal(h.creates().length, 0); assert.equal(h.value.billing.plan, 'free');
  assert.equal(h.value.error, 'Please check your subscription status again shortly.'); assert.doesNotMatch(h.value.error, /checkout again|pay again/);
});

test('a legacy complete return refreshes billing without claiming payment or showing a false error', async () => {
  const h = await loaded({ returnInfo: { billing: 'complete' } }); assert.equal(h.value.error, ''); assert.equal(h.value.notice, 'Your subscription status has been refreshed.'); assert.equal(h.confirms().length, 0);
});

test('Pro activation requires a connected paid subscription, not complimentary or disconnected data', async () => {
  const h = await loaded({ returnInfo: { billing: 'success' }, billing: { ...pro, connectedToBilling: false } });
  for (let i = 0; i < 4; i++) await h.advance(1500);
  assert.equal(h.value.notice, ''); assert.match(h.value.error, /check your subscription status/);
});
