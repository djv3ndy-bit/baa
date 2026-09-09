import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../checkout.js', import.meta.url), 'utf8');
const checkoutResult = {
  publishableKey: 'pk_live_fixture',
  sessionId: 'cs_live_fixture',
  clientSecret: 'cs_live_fixture_secret_fixture',
};
const account = (id = 'cafe-owner', token = 'initial-token') => ({ user: { id }, access_token: token });
const response = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const settle = async () => { for (let i = 0; i < 4; i++) await new Promise(setImmediate); };

// Run the production script in an isolated browser-shaped realm. Every request,
// auth event, timer, Stripe instance, and navigation is controlled by this test.
function browser(options = {}) {
  const state = {
    session: options.session === undefined ? account() : options.session,
    billing: options.billing || {},
    result: { ...checkoutResult, ...options.result },
    requests: [], instances: [], stripeKeys: [], navigations: [], logs: [],
    authCallbacks: [], timers: new Map(), clientOptions: [], sessionReads: 0, scripts: [], unsubscribed: 0,
  };
  const elements = new Map();
  const events = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, {
      hidden: false, disabled: false, textContent: '', attributes: {}, listeners: new Map(),
      setAttribute(name, value) { this.attributes[name] = value; },
      addEventListener(name, callback) { this.listeners.set(name, callback); },
      removeEventListener(name, callback) { if (this.listeners.get(name) === callback) this.listeners.delete(name); },
      replaceChildren() { this.clearCount = (this.clearCount || 0) + 1; },
    });
    return elements.get(id);
  };
  const auth = {
    async getSession() {
      state.sessionReads++;
      return options.getSession ? options.getSession(state) : { data: { session: state.session } };
    },
    onAuthStateChange(callback) {
      state.authCallbacks.push(callback);
      return { data: { subscription: { unsubscribe() { state.authCallbacks = state.authCallbacks.filter(item => item !== callback); state.unsubscribed++; } } } };
    },
  };
  const forbiddenStorage = {
    setItem() { throw new Error('Checkout must not persist credentials'); },
    getItem() { throw new Error('Checkout must not read credentials from storage directly'); },
  };
  const window = {
    localStorage: forbiddenStorage, sessionStorage: forbiddenStorage,
    supabase: {
      createClient(...args) { state.clientOptions.push(args); return { auth }; },
    },
    Stripe(key) {
      state.stripeKeys.push(key);
      return {
        async createEmbeddedCheckoutPage(callbacks) {
          const instance = {
            callbacks, mountTargets: [], destroyCount: 0,
            mount(target) { this.mountTargets.push(target); },
            destroy() { this.destroyCount++; },
          };
          state.instances.push(instance);
          if (options.initialize) await options.initialize(instance, state);
          return instance;
        },
      };
    },
    addEventListener(name, callback) { events.set(name, callback); },
    removeEventListener(name, callback) { if (events.get(name) === callback) events.delete(name); },
  };
  const stripeFactory = window.Stripe;
  if (options.stripeAbsent) delete window.Stripe;
  let timerId = 0;
  vm.runInNewContext(source, {
    window, document: {
      getElementById: element,
      createElement() { return { remove() { this.removed = true; } }; },
      head: { appendChild(script) { state.scripts.push(script); } },
    }, URL, AbortController,
    location: { assign(url) { state.navigations.push(url); } },
    localStorage: forbiddenStorage, sessionStorage: forbiddenStorage,
    console: Object.fromEntries(['log', 'info', 'warn', 'error'].map(name => [name, (...args) => state.logs.push(args)])),
    setTimeout(callback) { state.timers.set(++timerId, callback); return timerId; },
    clearTimeout(id) { state.timers.delete(id); },
    async fetch(url, init = {}) {
      state.requests.push({ url, ...init });
      const custom = await options.fetch?.(url, init, state);
      if (custom !== undefined) return custom;
      if (url === '/api/config') return response({
        supabaseUrl: 'https://fixture.supabase.co', supabasePublishableKey: 'sb_publishable_fixture',
        stripeEmbeddedCheckoutConfigured: true, ...options.config,
      });
      if (url === '/api/billing-status') return response(state.billing);
      if (url === '/api/create-checkout-session') return response(state.result);
      throw new Error(`Unstubbed network request: ${url}`);
    },
  }, { filename: 'checkout.js' });
  window.BaristaMatchCheckout.mount(options.sharedClient ? { client: { auth }, ownerId: state.session?.user.id } : undefined);
  return {
    state, element,
    clickRetry() { element('checkout-retry').listeners.get('click')(); },
    clickHosted() { element('checkout-hosted').listeners.get('click')(); },
    destroy() { window.BaristaMatchCheckout.destroy(); },
    remount() { window.BaristaMatchCheckout.mount({ client: { auth }, ownerId: state.session?.user.id }); },
    installStripe() { window.Stripe = stripeFactory; },
    dispatch(name, event = {}) { events.get(name)?.(event); },
    changeAuth(session, event = 'SIGNED_IN') {
      state.session = session;
      for (const callback of state.authCallbacks) callback(event, session);
    },
    expireRequests() { for (const callback of [...state.timers.values()]) callback(); },
  };
}

const createRequests = h => h.state.requests.filter(request => request.url === '/api/create-checkout-session');

test('embedded checkout mounts with the current SDK and sends completion only to owned-session confirmation', async () => {
  const h = browser();
  assert.equal(h.element('checkout-intro').hidden, true);
  await settle();
  const [instance] = h.state.instances;
  assert.deepEqual(instance.mountTargets, ['#checkout-mount']);
  assert.deepEqual(h.state.stripeKeys, [checkoutResult.publishableKey]);
  assert.equal(await instance.callbacks.fetchClientSecret(), checkoutResult.clientSecret);
  const [request] = createRequests(h);
  assert.deepEqual(JSON.parse(request.body), { channel: 'web', uiMode: 'embedded' });
  assert.equal(request.method, 'POST');
  assert.equal(request.headers.Authorization, 'Bearer initial-token');
  assert.ok(h.state.requests.every(request => request.cache === 'no-store'));
  assert.equal(h.state.clientOptions[0][2].auth.storageKey, 'sb-fixture-auth-token');
  assert.equal(h.element('checkout-message').hidden, true);
  assert.equal(h.element('checkout-intro').hidden, false);
  instance.callbacks.onComplete();
  instance.callbacks.onComplete();
  assert.deepEqual(h.state.navigations, ['/dashboard.html?billing=success&session_id=cs_live_fixture']);
  assert.equal(instance.destroyCount, 1);
  assert.equal(h.element('checkout-message-title').textContent, 'Confirming your subscription…');
  assert.equal(h.state.logs.length, 0);
  assert.equal(h.state.timers.size, 0);
});

test('embedded checkout passes an opaque encoded client secret to Stripe unchanged', async () => {
  const clientSecret = `${checkoutResult.sessionId}_secret_encoded%2Fpart_with%3Dpadding`;
  const h = browser({ result: { clientSecret } });
  await settle();
  assert.equal(h.state.instances.length, 1);
  const [instance] = h.state.instances;
  assert.deepEqual(instance.mountTargets, ['#checkout-mount']);
  assert.equal(await instance.callbacks.fetchClientSecret(), clientSecret);
  assert.equal(h.state.navigations.length, 0);
  assert.equal(h.state.logs.length, 0);
});

test('account changes and sign-out invalidate mounted checkout and its captured callbacks', async t => {
  for (const nextSession of [account('another-owner'), null]) await t.test(nextSession ? 'account changed' : 'signed out', async () => {
    const h = browser();
    await settle();
    const [instance] = h.state.instances;
    h.changeAuth(nextSession, nextSession ? 'SIGNED_IN' : 'SIGNED_OUT');
    assert.equal(instance.destroyCount, 1);
    assert.equal(h.element('checkout-login').hidden, false);
    assert.equal(h.element('checkout-intro').hidden, true);
    instance.callbacks.onComplete();
    assert.equal(h.state.navigations.length, 0);
    await assert.rejects(instance.callbacks.fetchClientSecret(), /log in|account changed|closed/i);
  });
});

test('an instance that finishes initializing after account change or page exit is destroyed without mounting', async t => {
  for (const reason of ['account change', 'page exit']) await t.test(reason, async () => {
    const pending = deferred();
    const h = browser({ initialize: () => pending.promise });
    await settle();
    const [instance] = h.state.instances;
    if (reason === 'account change') h.changeAuth(account('another-owner'));
    else h.dispatch('pagehide');
    assert.equal(h.element('checkout-intro').hidden, true);
    pending.resolve();
    await settle();
    assert.deepEqual(instance.mountTargets, []);
    assert.equal(instance.destroyCount, 1);
    instance.callbacks.onComplete();
    assert.equal(h.state.navigations.length, 0);
  });
});

test('completion during initialization cannot mount the completed form afterward', async () => {
  const h = browser({ initialize: async instance => instance.callbacks.onComplete() });
  await settle();
  assert.equal(h.state.navigations.length, 1);
  assert.deepEqual(h.state.instances[0].mountTargets, []);
  assert.equal(h.state.instances[0].destroyCount, 1);
});

test('a late billing response cannot create checkout for an account that changed', async () => {
  const pending = deferred();
  const h = browser({ fetch: url => url === '/api/billing-status' ? pending.promise : undefined });
  await settle();
  h.changeAuth(account('another-owner'));
  pending.resolve(response({}));
  await settle();
  assert.equal(createRequests(h).length, 0);
  assert.equal(h.state.instances.length, 0);
  assert.equal(h.element('checkout-message-title').textContent, 'Your session changed');
});

test('a failed create request offers one retry and does not launch duplicate requests while busy', async () => {
  let attempts = 0;
  const pending = deferred();
  const h = browser({ fetch(url) {
    if (url !== '/api/create-checkout-session') return;
    if (++attempts === 1) throw new TypeError('Network connection lost');
    return pending.promise;
  } });
  await settle();
  assert.equal(h.element('checkout-retry').hidden, false);
  assert.equal(h.element('checkout-retry').disabled, false);
  assert.equal(h.state.instances.length, 0);
  h.clickRetry();
  assert.equal(h.element('checkout-intro').hidden, true);
  h.clickRetry();
  await settle();
  assert.equal(attempts, 2);
  assert.equal(h.element('checkout-retry').disabled, true);
  pending.resolve(response(checkoutResult));
  await settle();
  assert.equal(h.state.instances.length, 1);
  assert.deepEqual(h.state.instances[0].mountTargets, ['#checkout-mount']);
  assert.equal(h.element('checkout-retry').disabled, false);
});

test('a timed out request explains the failure and remains retryable', async () => {
  const h = browser({ fetch(url, init) {
    if (url !== '/api/billing-status') return;
    return new Promise((resolve, reject) => init.signal.addEventListener('abort', () => {
      const error = new Error('aborted'); error.name = 'AbortError'; reject(error);
    }, { once: true }));
  } });
  await settle();
  h.expireRequests();
  await settle();
  assert.match(h.element('checkout-message-detail').textContent, /too long/);
  assert.equal(h.element('checkout-retry').hidden, false);
  assert.equal(h.element('checkout-retry').disabled, false);
  assert.equal(h.state.timers.size, 0);
  assert.equal(createRequests(h).length, 0);
});

test('missing sessions and server auth rejections show sign-in without mounting Stripe', async t => {
  await t.test('missing session', async () => {
    const h = browser({ session: null });
    await settle();
    assert.equal(h.element('checkout-login').hidden, false);
    assert.equal(h.element('checkout-intro').hidden, true);
    assert.equal(createRequests(h).length, 0);
    assert.equal(h.state.stripeKeys.length, 0);
  });
  for (const status of [401, 403]) await t.test(String(status), async () => {
    const h = browser({ fetch: url => url === '/api/create-checkout-session' ? response({ error: 'Access denied' }, status) : undefined });
    await settle();
    assert.equal(h.element('checkout-login').hidden, false);
    assert.equal(h.element('checkout-intro').hidden, true);
    assert.equal(h.element('checkout-retry').hidden, true);
    assert.equal(h.state.stripeKeys.length, 0);
  });
});

test('an existing subscription or paused billing routes to account management without creating a session', async t => {
  for (const billing of [{ canManageBilling: true }, { billingPaused: true }]) await t.test(Object.keys(billing)[0], async () => {
    const h = browser({ billing });
    await settle();
    assert.equal(h.element('checkout-manage').hidden, false);
    assert.equal(h.element('checkout-retry').hidden, true);
    assert.equal(createRequests(h).length, 0);
    assert.equal(h.state.stripeKeys.length, 0);
  });
});

test('invalid credentials and a client secret belonging to another session never reach Stripe', async t => {
  for (const result of [
    { clientSecret: 'cs_live_another_secret_fixture' },
    { clientSecret: null },
    { publishableKey: 'rk_live_fixture' },
    { sessionId: 'https://example.invalid/redirect' },
  ]) await t.test(Object.keys(result)[0] + ':' + String(Object.values(result)[0]), async () => {
    const h = browser({ result });
    await settle();
    assert.equal(h.state.stripeKeys.length, 0);
    assert.equal(h.element('checkout-retry').hidden, false);
    assert.equal(h.state.navigations.length, 0);
  });
});

test('checkout creation uses refreshed credentials and a same-account token refresh preserves the form', async () => {
  const h = browser({ fetch(url, init, state) {
    if (url === '/api/billing-status') state.session = account('cafe-owner', 'refreshed-token');
  } });
  await settle();
  const billingRequest = h.state.requests.find(request => request.url === '/api/billing-status');
  assert.equal(billingRequest.headers.Authorization, 'Bearer initial-token');
  assert.equal(createRequests(h)[0].headers.Authorization, 'Bearer refreshed-token');
  const [instance] = h.state.instances;
  h.changeAuth(account('cafe-owner', 'next-token'), 'TOKEN_REFRESHED');
  assert.equal(instance.destroyCount, 0);
  assert.equal(await instance.callbacks.fetchClientSecret(), checkoutResult.clientSecret);
  assert.equal(h.state.instances.length, 1);
});

test('browser back-forward restoration creates a new form while old callbacks remain invalid', async () => {
  const h = browser();
  await settle();
  const [oldInstance] = h.state.instances;
  h.dispatch('pagehide');
  assert.equal(oldInstance.destroyCount, 1);
  assert.equal(h.element('checkout-intro').hidden, true);
  h.dispatch('pageshow', { persisted: true });
  await settle();
  assert.equal(h.state.instances.length, 2);
  assert.deepEqual(h.state.instances[1].mountTargets, ['#checkout-mount']);
  oldInstance.callbacks.onComplete();
  assert.equal(h.state.navigations.length, 0);
  await assert.rejects(oldInstance.callbacks.fetchClientSecret(), /closed/);
});

test('dashboard integration reuses its authenticated client and tears down on section changes', async () => {
  const h = browser({ sharedClient: true });
  await settle();
  assert.equal(h.state.clientOptions.length, 0);
  const [oldInstance] = h.state.instances;
  h.destroy();
  assert.equal(oldInstance.destroyCount, 1);
  assert.equal(h.state.unsubscribed, 1);
  assert.equal(h.state.authCallbacks.length, 0);
  h.dispatch('pageshow', { persisted: true });
  await settle();
  assert.equal(h.state.instances.length, 1, 'a departed section cannot reopen on browser restoration');
  h.remount();
  await settle();
  assert.equal(h.state.instances.length, 2);
  assert.equal(h.state.authCallbacks.length, 1);
  oldInstance.callbacks.onComplete();
  assert.equal(h.state.navigations.length, 0);
});

test('departing the section during delayed Stripe initialization destroys the late form', async () => {
  const pending = deferred();
  const h = browser({ initialize: () => pending.promise, sharedClient: true });
  await settle();
  h.destroy();
  pending.resolve();
  await settle();
  assert.equal(h.state.instances[0].destroyCount, 1);
  assert.deepEqual(h.state.instances[0].mountTargets, []);
  assert.equal(h.state.authCallbacks.length, 0);
});

test('missing embedded readiness preserves hosted checkout behind an explicit click', async t => {
  for (const configured of [false, undefined]) await t.test(String(configured), async () => {
    const url = 'https://checkout.stripe.com/c/pay/cs_live_hosted';
    const h = browser({ config: { stripeEmbeddedCheckoutConfigured: configured }, result: { url }, stripeAbsent: true, sharedClient: true });
    await settle();
    assert.equal(h.element('checkout-intro').hidden, false);
    assert.equal(h.element('checkout-hosted').hidden, false);
    assert.equal(createRequests(h).length, 0);
    assert.equal(h.state.scripts.length, 0, 'hosted fallback does not load Stripe.js');
    h.clickHosted();
    h.clickHosted();
    await settle();
    assert.equal(createRequests(h).length, 1);
    assert.deepEqual(JSON.parse(createRequests(h)[0].body), { channel: 'web' });
    assert.deepEqual(h.state.navigations, [url]);
    assert.equal(h.state.instances.length, 0);
  });
});

test('hosted fallback withholds unsafe redirects and stale-account responses', async t => {
  await t.test('unsafe redirect', async () => {
    const h = browser({ config: { stripeEmbeddedCheckoutConfigured: false }, result: { url: 'https://checkout.stripe.com.attacker.invalid/pay' } });
    await settle(); h.clickHosted(); await settle();
    assert.equal(h.state.navigations.length, 0);
    assert.equal(h.element('checkout-retry').hidden, false);
  });
  await t.test('account changed', async () => {
    const pending = deferred();
    const h = browser({ config: { stripeEmbeddedCheckoutConfigured: false }, fetch: url => url === '/api/create-checkout-session' ? pending.promise : undefined });
    await settle(); h.clickHosted(); await settle();
    h.changeAuth(account('another-owner'));
    pending.resolve(response({ url: 'https://checkout.stripe.com/c/pay/cs_live_hosted' }));
    await settle();
    assert.equal(h.state.navigations.length, 0);
    assert.equal(h.element('checkout-intro').hidden, true);
  });
});

test('embedded readiness is checked again before the hosted fallback continues', async () => {
  let configured = false;
  const h = browser({ fetch: url => url === '/api/config' ? response({ stripeEmbeddedCheckoutConfigured: configured }) : undefined, sharedClient: true });
  await settle();
  assert.equal(h.element('checkout-hosted').hidden, false);
  configured = true;
  h.clickHosted();
  await settle();
  assert.equal(h.state.instances.length, 1);
  assert.deepEqual(JSON.parse(createRequests(h)[0].body), { channel: 'web', uiMode: 'embedded' });
  assert.equal(h.state.navigations.length, 0);
});

test('the real Stripe SDK loads only for embedded checkout and a load failure can retry', async () => {
  const h = browser({ stripeAbsent: true });
  await settle();
  assert.equal(h.state.scripts.length, 1);
  assert.equal(h.state.scripts[0].src, 'https://js.stripe.com/dahlia/stripe.js');
  assert.equal(createRequests(h).length, 0);
  h.state.scripts[0].onerror();
  await settle();
  assert.equal(h.element('checkout-retry').hidden, false);
  assert.equal(h.state.scripts[0].removed, true);
  h.clickRetry();
  await settle();
  assert.equal(h.state.scripts.length, 2);
  h.installStripe();
  h.state.scripts[1].onload();
  await settle();
  assert.equal(h.state.instances.length, 1);
  assert.equal(h.state.timers.size, 0);
});
