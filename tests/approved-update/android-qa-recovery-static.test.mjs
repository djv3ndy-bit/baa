import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const root = new URL('../../', import.meta.url);
const read = name => fs.readFileSync(new URL(name, root), 'utf8');
const page = read('public/reset-password.html');
const script = [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)][0]?.[1];
const qa = 'https://android-testing.baristajobmatch.com';
const backend = 'https://ojvjlvojvozvhktbclcg.supabase.co';
const user = {id: '11111111-1111-4111-8111-111111111111'};
const session = {user};
const validPassword = 'Synthetic-Only-Password1!';
const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

function harness(options = {}, source = script) {
  const calls = [], timers = [], cancelledTimers = new Set(), elements = new Map();
  let listener, current = options.session ?? null;
  const node = id => {
    if (!elements.has(id)) elements.set(id, {hidden: id !== 'loading', textContent: '', disabled: false,
      classList: {add() {}, remove() {}}, querySelector: () => node('button'),
      reset() { calls.push(['form-reset']); }});
    return elements.get(id);
  };
  const location = {origin: options.origin ?? qa, hash: options.hash ?? '', search: options.search ?? ''};
  const client = {auth: {
    onAuthStateChange(callback) { listener = callback; return {data: {subscription: {unsubscribe() {}}}}; },
    async getSession() { calls.push(['session']); if (options.sessionThrow) throw Error('PRIVATE_PROVIDER_ERROR'); return {data: {session: current}, error: options.sessionError ?? null}; },
    async updateUser(value) { calls.push(['update', value]); if (options.updateGate) await options.updateGate;
      if (options.updateThrow) throw Error('PRIVATE_PROVIDER_ERROR'); return {error: options.updateError ?? null}; },
    async signOut(value) { calls.push(['signout', value]); if (options.signOutThrow) throw Error('PRIVATE_PROVIDER_ERROR'); return {error: options.signOutError ?? null}; },
  }};
  const context = vm.createContext({location, URLSearchParams,
    document: {getElementById: node},
    FormData: class { constructor(form) { this.form = form; } get(key) { return this.form.values[key]; } },
    setTimeout(callback) { const id = timers.length + 1; timers.push(() => { if (!cancelledTimers.has(id)) callback(); }); return id; },
    clearTimeout(id) { cancelledTimers.add(id); },
    fetch: async (url, init) => { calls.push(['config', url, init]); if (options.fetchThrow) throw Error('PRIVATE_PROVIDER_ERROR');
      return {ok: options.ok ?? true, json: async () => options.config ?? {supabaseUrl: backend, supabasePublishableKey: 'sb_publishable_SYNTHETIC_ONLY'}}; },
    window: {supabase: {createClient(...args) { calls.push(['client', ...args]); return client; }}},
  });
  vm.runInContext(source, context, {filename: 'public/reset-password.html'});
  return {calls, timers, location, node, context,
    async ready() { await tick(); },
    emit(event, value) { current = value; listener?.(event, value); },
    setSession(value) { current = value; },
    async submit(password = validPassword, confirmation = password) {
      const form = node('reset-form'); form.values = {password, confirmation};
      await form.onsubmit({preventDefault() {}, currentTarget: form});
    },
    visible(name) { return !node(name).hidden; },
  };
}

const has = (h, name) => h.calls.filter(call => call[0] === name);
function noRawError(h) { for (const id of ['status', 'error-copy', 'success-copy']) assert.doesNotMatch(h.node(id).textContent, /PRIVATE_PROVIDER_ERROR/); }

test('both QA output paths contain the identical self-contained recovery implementation', () => {
  assert.equal(read('public/index.html'), page);
  assert.ok(script);
  assert.doesNotMatch(page, /analytics\.js|\/login\.html|baristamatch:\/\//);
  assert.match(page, /does not change your Google or Gmail password/);
  assert.match(page, /supabase-js@2\.102\.0/);
  for (const file of [...page.matchAll(/(?:src|href)="(\/[^"?#]+)"/g)].map(match => match[1])) {
    assert.ok(fs.existsSync(new URL(`public${file}`, root)), `missing static asset ${file}`);
  }
  const config = JSON.parse(read('vercel.json'));
  assert.equal(config.cleanUrls, true);
});

for (const origin of ['https://www.baristajobmatch.com', 'https://android-testing.baristajobmatch.com.evil.invalid', 'http://android-testing.baristajobmatch.com', `${qa}:444`]) {
  test(`unapproved origin fails before config/client: ${origin}`, async () => {
    const h = harness({origin}); await h.ready(); await h.submit();
    assert.equal(h.calls.length, 0); assert.ok(h.visible('error-view'));
  });
}
for (const config of [
  {supabaseUrl: 'https://lmwqrxoitraofaftpwhe.supabase.co', supabasePublishableKey: 'sb_publishable_SYNTHETIC_ONLY'},
  {supabaseUrl: `${backend}/`, supabasePublishableKey: 'sb_publishable_SYNTHETIC_ONLY'},
  {supabaseUrl: backend, supabasePublishableKey: 'sb_secret_SYNTHETIC_REJECTED'},
  {supabaseUrl: backend},
]) test('wrong/malformed backend configuration never creates a client or updates Auth', async () => {
  const h = harness({config}); await h.ready(); await h.submit();
  assert.equal(has(h, 'client').length, 0); assert.equal(has(h, 'update').length, 0); assert.ok(h.visible('error-view'));
});

test('config request is same-origin, uncached, cookie-free and refuses redirects', async () => {
  const h = harness(); await h.ready();
  assert.deepEqual(JSON.parse(JSON.stringify(has(h, 'config')[0])), ['config', '/api/config', {cache: 'no-store', credentials: 'omit', redirect: 'error'}]);
  assert.equal(has(h, 'client')[0][1], backend);
});

for (const options of [{ok: false}, {fetchThrow: true}, {sessionThrow: true}, {sessionError: Error('PRIVATE_PROVIDER_ERROR')}]) {
  test('config/session failures fail closed with fixed safe text', async () => {
    const h = harness(options); await h.ready(); await h.submit();
    assert.equal(has(h, 'update').length, 0); assert.ok(h.visible('error-view')); noRawError(h);
  });
}

test('PASSWORD_RECOVERY with a session opens the form; ordinary SIGNED_IN does not', async () => {
  const h = harness(); await h.ready(); h.emit('SIGNED_IN', session);
  assert.equal(h.visible('reset-view'), false);
  h.emit('PASSWORD_RECOVERY', null); assert.equal(h.visible('reset-view'), false);
  h.emit('PASSWORD_RECOVERY', session); assert.equal(h.visible('reset-view'), true);
});

test('a confirmed implicit recovery return opens the form on root or reset path without forwarding tokens', async () => {
  const h = harness({session, hash: '#access_token=SYNTHETIC&refresh_token=SYNTHETIC&type=recovery'}); await h.ready();
  assert.ok(h.visible('reset-view')); assert.equal(h.location.hash, '#access_token=SYNTHETIC&refresh_token=SYNTHETIC&type=recovery');
  assert.deepEqual(has(h, 'config').map(call => call[1]), ['/api/config']);
});
for (const hash of ['#type=recovery', '#access_token=SYNTHETIC&type=recovery', '#access_token=SYNTHETIC&refresh_token=SYNTHETIC&type=signup']) {
  test('a label or incomplete/non-recovery return cannot authorize a cached session', async () => {
    const h = harness({session, hash, search: '?type=recovery'}); await h.ready(); await h.submit();
    assert.equal(has(h, 'update').length, 0); assert.equal(h.visible('reset-view'), false);
  });
}

test('missing recovery expires to safe error without an update', async () => {
  const h = harness(); await h.ready(); h.timers.forEach(callback => callback()); await h.submit();
  assert.ok(h.visible('error-view')); assert.equal(has(h, 'update').length, 0);
});

for (const [password, confirmation] of [[validPassword, 'Mismatch1!'], ['shortA1!', 'shortA1!'], ['lowercase123!', 'lowercase123!'], ['UPPERCASE123!', 'UPPERCASE123!'], ['NoDigitsHere!', 'NoDigitsHere!'], ['NoSymbols123', 'NoSymbols123']]) {
  test('password mismatch/strength validation prevents Auth writes', async () => {
    const h = harness(); await h.ready(); h.emit('PASSWORD_RECOVERY', session); await h.submit(password, confirmation);
    assert.equal(has(h, 'update').length, 0); assert.equal(has(h, 'signout').length, 0); assert.notEqual(h.node('status').textContent, '');
  });
}

test('recovery updates only the entered password then revokes only the browser local session', async () => {
  const h = harness(); await h.ready(); h.emit('PASSWORD_RECOVERY', session); await h.submit();
  assert.deepEqual(JSON.parse(JSON.stringify(has(h, 'update'))), [['update', {password: validPassword}]]);
  assert.deepEqual(JSON.parse(JSON.stringify(has(h, 'signout'))), [['signout', {scope: 'local'}]]);
  assert.ok(h.visible('success-view')); await h.submit(); assert.equal(has(h, 'update').length, 1);
});

for (const change of ['host', 'session', 'event']) test('changed host/account cannot update the recovery owner', async () => {
  const h = harness(); await h.ready(); h.emit('PASSWORD_RECOVERY', session);
  if (change === 'host') h.location.origin = 'https://www.baristajobmatch.com';
  else if (change === 'session') h.setSession({user: {id: '22222222-2222-4222-8222-222222222222'}});
  else h.emit('SIGNED_OUT', null);
  await h.submit(); assert.equal(has(h, 'update').length, 0); assert.ok(h.visible('error-view'));
});

test('a rejected update preserves retry and never shows success or signs out', async () => {
  const h = harness({updateError: Error('PRIVATE_PROVIDER_ERROR')}); await h.ready(); h.emit('PASSWORD_RECOVERY', session); await h.submit();
  assert.equal(has(h, 'signout').length, 0); assert.equal(h.visible('success-view'), false); assert.equal(h.node('button').disabled, false); noRawError(h);
});

for (const options of [{signOutError: Error('PRIVATE_PROVIDER_ERROR')}, {signOutThrow: true}]) test('failed local signout accurately reports password already updated without repeating it', async () => {
  const h = harness(options); await h.ready(); h.emit('PASSWORD_RECOVERY', session); await h.submit();
  assert.ok(h.visible('success-view')); assert.match(h.node('success-copy').textContent, /password was updated, but/); noRawError(h);
  await h.submit(); assert.equal(has(h, 'update').length, 1);
});

test('repeated submit while update is in flight does not repeat the password operation', async () => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  const h = harness({updateGate: gate}); await h.ready(); h.emit('PASSWORD_RECOVERY', session);
  const first = h.submit(); await tick(); const second = h.submit(); await tick(); assert.equal(has(h, 'update').length, 1);
  release(); await Promise.all([first, second]); assert.equal(has(h, 'signout').length, 1);
});

for (const file of ['public/index.html', 'public/reset-password.html']) test(`fast successful reset stays successful after the recovery deadline: ${file}`, async () => {
  const inline = [...read(file).matchAll(/<script>([\s\S]*?)<\/script>/g)][0][1];
  const h = harness({}, inline); await h.ready(); assert.equal(h.timers.length, 1);
  h.emit('PASSWORD_RECOVERY', session); await h.submit(); assert.ok(h.visible('success-view'));
  h.timers.forEach(callback => callback()); await tick();
  assert.ok(h.visible('success-view')); assert.equal(h.visible('error-view'), false);
  h.emit('PASSWORD_RECOVERY', session); assert.ok(h.visible('success-view'));
  assert.equal(has(h, 'update').length, 1); assert.equal(has(h, 'signout').length, 1);
});
