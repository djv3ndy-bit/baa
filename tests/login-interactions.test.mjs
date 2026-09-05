import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import test from 'node:test';
const require = createRequire(import.meta.url);
const html = readFileSync(new URL('../login.html', import.meta.url), 'utf8');
const script = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(match => match[1]).find(code => code.includes('signInWithPassword'));
async function loginHarness(overrides = {}, session = null) {
  const elements = {};
  for (const id of ['email', 'password', 'status', 'forgot-password', 'google', 'apple', 'login-button', 'login-form']) {
    const attrs = {};
    elements[id] = { value: '', textContent: '', disabled: false, style: {}, classList: { toggle() {} },
      focus() {}, checkValidity: () => true, reportValidity() {},
      getAttribute: name => attrs[name], setAttribute: (name, value) => { attrs[name] = value; }, removeAttribute: name => { delete attrs[name]; } };
  }
  elements.email.value = 'test@example.test';
  elements.password.value = 'local-test-only';
  const redirects = [];
  const auth = { getSession: async () => ({ data: { session } }), ...overrides };
  vm.runInNewContext(script, { document: { getElementById: id => elements[id] }, URLSearchParams,
    location: { search: '', replace: url => redirects.push(url) },
    fetch: async () => ({ ok: true, json: async () => ({ supabaseUrl: 'https://example.test', supabasePublishableKey: 'public-test' }) }),
    window: { supabase: { createClient: () => ({ auth }) } } });
  await new Promise(resolve => setImmediate(resolve));
  const click = id => elements[id][id === 'login-form' ? 'onsubmit' : 'onclick']({ preventDefault() {}, currentTarget: elements[id] });
  return { elements, redirects, click };
}
const reject = async () => { throw new Error('offline'); };
test('password login recovers from a thrown request and can be retried', async () => {
  let attempts = 0;
  const h = await loginHarness({ signInWithPassword: async () => { attempts++; return reject(); } });
  await h.click('login-form');
  assert.equal(h.elements['login-button'].disabled, false);
  assert.equal(h.elements['login-button'].textContent, 'Log in');
  assert.match(h.elements.status.textContent, /connection/);
  await h.click('login-form');
  assert.equal(attempts, 2);
  assert.deepEqual(h.redirects, []);
});
test('invalid credentials and missing sessions never redirect', async () => {
  for (const result of [{ error: { message: 'Invalid login credentials' } }, { data: { user: { id: 'test' } } }]) {
    const h = await loginHarness({ signInWithPassword: async () => result });
    await h.click('login-form');
    assert.equal(h.elements['login-button'].disabled, false);
    assert.ok(h.elements.status.textContent);
    assert.deepEqual(h.redirects, []);
  }
});
test('successful sign-in and existing sessions reach the dashboard without an extra profile query', async () => {
  const h = await loginHarness({ signInWithPassword: async () => ({ data: { session: {}, user: { id: 'test' } } }) });
  await h.click('login-form');
  assert.deepEqual(h.redirects, ['/dashboard.html']);
  const existing = await loginHarness({}, { user: { id: 'test' } });
  assert.deepEqual(existing.redirects, ['/dashboard.html']);
});
test('both social sign-in buttons recover from thrown and returned provider errors', async () => {
  for (const provider of ['google', 'apple']) {
    for (const signInWithOAuth of [reject, async () => ({ error: { message: 'unavailable' } })]) {
      const h = await loginHarness({ signInWithOAuth });
      await h.click(provider);
      assert.equal(h.elements[provider].disabled, false);
      assert.match(h.elements.status.textContent, /could not start/);
    }
  }
});
test('password reset restores its link after errors and rejects malformed email locally', async () => {
  let calls = 0;
  const h = await loginHarness({ resetPasswordForEmail: async () => { calls++; return reject(); } });
  h.elements.email.checkValidity = () => false;
  await h.click('forgot-password');
  assert.equal(calls, 0);
  h.elements.email.checkValidity = () => true;
  await h.click('forgot-password');
  assert.equal(calls, 1);
  assert.equal(h.elements['forgot-password'].style.pointerEvents, '');
  assert.equal(h.elements['forgot-password'].getAttribute('aria-disabled'), undefined);
  assert.match(h.elements.status.textContent, /could not send/);
});
test('repeated submit while sign-in is pending sends only one request', async () => {
  let finish, calls = 0;
  const h = await loginHarness({ signInWithPassword: () => { calls++; return new Promise(resolve => { finish = resolve; }); } });
  const pending = h.click('login-form');
  await h.click('login-form');
  assert.equal(calls, 1);
  finish({ error: {} });
  await pending;
});

const ts = require('../mobile/node_modules/typescript');
const { parseMobileAuthCallback } = require(process.env.AUTH_CALLBACK_MODULE);
const nativeSource = readFileSync(new URL('../mobile/app/login.tsx', import.meta.url), 'utf8');
const start = nativeSource.indexOf('  async function handleOAuth(');
const end = nativeSource.indexOf('  async function createSocialProfile', start);
const nativeHandler = ts.transpileModule(nativeSource.slice(start, end), { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText;
function nativeHarness(setSession) {
  const alerts = [], loading = [];
  const context = { parseMobileAuthCallback, supabase: { auth: { setSession } },
    Alert: { alert: (...args) => alerts.push(args) }, setSocialLoading: value => loading.push(value) };
  vm.createContext(context);
  vm.runInContext(nativeHandler, context);
  return { ...context, alerts, loading };
}
test('native login rejects callback lookalikes before creating a session', async () => {
  let calls = 0;
  const h = nativeHarness(async () => { calls++; });
  await h.handleOAuth('baristamatch://auth/callback.evil#access_token=a&refresh_token=b');
  assert.equal(calls, 0);
});
test('native login recovers from a thrown session request', async () => {
  const h = nativeHarness(reject);
  await h.handleOAuth('baristamatch://auth/callback#access_token=a&refresh_token=b');
  assert.equal(h.loading.at(-1), null);
  assert.equal(h.alerts[0][0], 'Connection problem');
});
test('native login handles malformed provider text without displaying it or throwing', async () => {
  const h = nativeHarness(reject);
  await h.handleOAuth('baristamatch://auth/callback#error_description=private%25detail');
  assert.equal(h.loading.at(-1), null);
  assert.equal(h.alerts[0][0], 'Sign-in failed');
  assert.doesNotMatch(JSON.stringify(h.alerts), /private/);
});
