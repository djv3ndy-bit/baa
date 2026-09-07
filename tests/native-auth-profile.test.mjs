import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import test from 'node:test';

const requireMobile = createRequire(new URL('../mobile/package.json', import.meta.url));
const ts = requireMobile('typescript');
const modulePath = name => new URL(`../mobile/${name}`, import.meta.url);
function compile(name, mocks = {}, cache = new Map()) {
  if (cache.has(name)) return cache.get(name);
  const source = ts.transpileModule(readFileSync(modulePath(name), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports = {};
  cache.set(name, exports);
  const load = dependency => {
    if (dependency in mocks) return mocks[dependency];
    if (dependency === './supabase' || dependency === '@/lib/supabase') return { supabase: mocks.client };
    const file = dependency.startsWith('@/') ? `${dependency.slice(2)}.ts` : dependency.startsWith('.') ? `${name.slice(0, name.lastIndexOf('/') + 1)}${dependency.replace(/^\.\//, '')}.ts` : null;
    if (file) return compile(file, mocks, cache);
    throw new Error(`Unexpected dependency ${dependency}`);
  };
  vm.runInNewContext(source, { exports, require: load, URLSearchParams, Date, Math, setTimeout, clearTimeout, fetch: mocks.fetch }, { filename: name });
  return exports;
}
const plain = value => JSON.parse(JSON.stringify(value));
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const flush = () => new Promise(resolve => setImmediate(resolve));
const privacy = compile('lib/profilePrivacy.ts');
const callback = compile('lib/authCallback.ts');
const barista = { id: 'user-a', role: 'barista', display_name: 'Sample', avatar_url: 'photo', location: 'Miami, FL', bio: 'About', experience: 'One year', availability: 'Weekdays', pay_expectation: '$20', skills: ['Espresso'], date_of_birth: '2000-01-01', visible_to_cafes: true, is_discoverable: true };
const cafe = { id: 'user-a', role: 'cafe_owner_manager', cafe_name: 'Sample Café', avatar_url: 'photo', location: 'Miami, FL', bio: 'About', cafe_address: '1 Main St', open_hours: 'Monday 8–4', shop_type: 'Coffee bar', barista_preferences: ['Teamwork'], visible_to_cafes: true, is_discoverable: true };
const options = { locationCity: 'Miami', availability: ['Weekdays'], availabilityNotes: '', openHours: 'Monday 8–4' };

function sessionClient({ role, profile, sessionError, profileError, sessions = ['user-a', 'user-a'], insertError, rpcResult = async () => ({ error: null }) } = {}) {
  let calls = 0;
  const writes = [], rpcs = [];
  const client = {
    auth: { getSession: async () => ({ data: { session: sessions[Math.min(calls++, sessions.length - 1)] ? { access_token: `token-${sessions[Math.min(calls - 1, sessions.length - 1)]}`, user: { id: sessions[Math.min(calls - 1, sessions.length - 1)], user_metadata: { role: 'barista' } } } : null }, error: sessionError }), setSession: async () => ({ data: { user: { id: 'user-a' } }, error: null }) },
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: profile === undefined ? role === undefined ? null : { id: 'user-a', role } : profile, error: profileError }) }) }), insert: async value => { writes.push(value); profile = { ...value }; return { error: insertError }; } }),
    rpc: name => ({ setHeader: (header, value) => { rpcs.push({ name, header, value }); return rpcResult(rpcs.length); } }),
  };
  return { client, writes, rpcs };
}

test('saved account role is authoritative; missing and unknown profiles never default to barista', async () => {
  for (const role of [undefined, 'unsupported', 'cafe_owner_manager']) {
    const { client } = sessionClient({ role });
    const { getCurrentContext } = compile('lib/session.ts', { client });
    const result = await getCurrentContext();
    assert.equal(result.role, role === 'cafe_owner_manager' ? role : null);
  }
});

test('context distinguishes connection failures and session switches from missing profiles', async () => {
  for (const scenario of [{ profileError: new Error('offline') }, { sessionError: new Error('storage unavailable') }, { role: 'barista', sessions: ['user-a', 'user-b'] }]) {
    const { client } = sessionClient(scenario);
    await assert.rejects(compile('lib/session.ts', { client }).getCurrentContext());
  }
  const { client } = sessionClient({ sessions: [null] });
  assert.equal((await compile('lib/session.ts', { client }).getCurrentContext()).user, null);
});

test('explicit setup inserts only for the same user and never overwrites an existing saved role', async () => {
  const draft = { role: 'barista', display_name: 'Sample', cafe_name: null, location: 'Miami, FL' };
  const saved = sessionClient({ role: 'cafe_owner_manager' });
  const result = await compile('lib/session.ts', { client: saved.client }).createExplicitProfile('user-a', draft);
  assert.equal(result.role, 'cafe_owner_manager'); assert.equal(saved.writes.length, 0);
  const missing = sessionClient();
  assert.equal((await compile('lib/session.ts', { client: missing.client }).createExplicitProfile('user-a', draft)).role, 'barista');
  assert.equal(missing.writes.length, 1);
  const switched = sessionClient({ sessions: ['user-b'] });
  await assert.rejects(compile('lib/session.ts', { client: switched.client }).createExplicitProfile('user-a', draft));
  assert.equal(switched.writes.length, 0);
});

test('saved café context waits for complimentary access and shares one initialization across concurrent callers', async () => {
  const gate = deferred();
  const backend = sessionClient({ role: 'cafe_owner_manager', rpcResult: () => gate.promise });
  const session = compile('lib/session.ts', { client: backend.client });
  let ready = false;
  const first = session.getCurrentContext().then(context => { ready = true; return context; });
  const second = session.getCurrentContext();
  await flush();
  assert.equal(ready, false);
  assert.deepEqual(backend.rpcs, [{ name: 'ensure_cafe_subscription', header: 'Authorization', value: 'Bearer token-user-a' }]);
  gate.resolve({ error: null });
  assert.equal((await first).role, 'cafe_owner_manager');
  assert.equal((await second).role, 'cafe_owner_manager');
  await session.getCurrentContext();
  assert.equal(backend.rpcs.length, 1);
});

test('failed café access preparation blocks ready context and can be retried', async () => {
  const backend = sessionClient({ role: 'cafe_owner_manager', rpcResult: async count => ({ error: count === 1 ? new Error('offline') : null }) });
  const session = compile('lib/session.ts', { client: backend.client });
  await assert.rejects(session.getCurrentContext(), /prepare your café workspace/);
  assert.equal((await session.getCurrentContext()).role, 'cafe_owner_manager');
  assert.equal(backend.rpcs.length, 2);
});

test('café creation initializes only after saving the explicit role; other roles never call the café RPC', async () => {
  const backend = sessionClient();
  const session = compile('lib/session.ts', { client: backend.client });
  const draft = { role: 'cafe_owner_manager', display_name: null, cafe_name: 'Sample Café', location: 'Miami, FL' };
  assert.equal((await session.createExplicitProfile('user-a', draft)).role, draft.role);
  assert.equal(backend.writes.length, 1);
  assert.equal(backend.rpcs.length, 1);
  for (const role of [undefined, 'unsupported', 'barista']) {
    const other = sessionClient({ role });
    await compile('lib/session.ts', { client: other.client }).getCurrentContext();
    assert.equal(other.rpcs.length, 0);
  }
});

test('session changes before café initialization prevent the RPC, and changes during it reject stale completion', async () => {
  const before = sessionClient({ role: 'cafe_owner_manager', sessions: ['user-a', 'user-b'] });
  await assert.rejects(compile('lib/session.ts', { client: before.client }).getCurrentContext(), /session changed/);
  assert.equal(before.rpcs.length, 0);
  const during = sessionClient({ role: 'cafe_owner_manager', sessions: ['user-a', 'user-a', 'user-b'] });
  await assert.rejects(compile('lib/session.ts', { client: during.client }).getCurrentContext(), /session changed/);
  assert.deepEqual(during.rpcs.map(call => call.value), ['Bearer token-user-a']);
});

test('a failed old account initialization does not evict a newer account pending request', async () => {
  let userId = 'user-a';
  const first = deferred(), second = deferred();
  const backend = sessionClient({ role: 'cafe_owner_manager', rpcResult: count => count === 1 ? first.promise : second.promise });
  backend.client.auth.getSession = async () => ({ data: { session: { user: { id: userId }, access_token: `token-${userId}` } }, error: null });
  const session = compile('lib/session.ts', { client: backend.client });
  const old = session.getCurrentContext();
  const oldRejected = assert.rejects(old, /prepare your café workspace/);
  await flush(); userId = 'user-b';
  const current = session.getCurrentContext(); await flush();
  first.resolve({ error: new Error('offline') }); await oldRejected;
  const parallel = session.getCurrentContext(); await flush();
  assert.equal(backend.rpcs.length, 2);
  assert.deepEqual(backend.rpcs.map(call => call.value), ['Bearer token-user-a', 'Bearer token-user-b']);
  second.resolve({ error: null });
  assert.equal((await current).user.id, 'user-b');
  assert.equal((await parallel).user.id, 'user-b');
});

test('real Supabase RPC keeps the captured café JWT when the shared auth provider returns another account token', async () => {
  const { createClient } = requireMobile('@supabase/supabase-js');
  const requests = [];
  const transport = createClient('https://example.invalid', 'sb_publishable_test', {
    accessToken: async () => 'token-user-b',
    global: { fetch: async (url, init) => {
      requests.push({ url: String(url), authorization: new Headers(init.headers).get('Authorization') });
      return new Response(JSON.stringify({ user_id: 'user-a', complimentary_access: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    } },
  });
  const backend = sessionClient({ role: 'cafe_owner_manager' });
  backend.client.rpc = transport.rpc.bind(transport);
  await compile('lib/session.ts', { client: backend.client }).getCurrentContext();
  assert.deepEqual(requests, [{ url: 'https://example.invalid/rest/v1/rpc/ensure_cafe_subscription', authorization: 'Bearer token-user-a' }]);
});

test('duplicate OAuth delivery exchanges once; concurrent other callbacks cannot switch the session', async () => {
  const gate = deferred(); let count = 0;
  const exchange = callback.createMobileCallbackExchange(async () => { count++; return gate.promise; });
  const url = `${callback.MOBILE_AUTH_CALLBACK_PREFIX}#access_token=a&refresh_token=r`;
  const first = exchange(url), second = exchange(url);
  assert.equal(first, second); assert.equal(count, 1);
  await assert.rejects(exchange(url.replace('access_token=a', 'access_token=b')));
  gate.resolve({ id: 'user-a' }); await first;
  assert.equal((await exchange(url)).id, 'user-a'); assert.equal(count, 1);
});

test('failed OAuth exchange can be retried, while malformed callbacks never exchange', async () => {
  let count = 0;
  const exchange = callback.createMobileCallbackExchange(async () => { if (++count === 1) throw new Error('offline'); return 'ok'; });
  const url = `${callback.MOBILE_AUTH_CALLBACK_PREFIX}#access_token=a&refresh_token=r`;
  await assert.rejects(exchange('https://invalid.example')); assert.equal(count, 0);
  await assert.rejects(exchange(url)); assert.equal(await exchange(url), 'ok');
});

test('completion requires the current role fields, photo and private DOB; optional gender never gates visibility', () => {
  assert.equal(privacy.getProfileReadiness(barista, 'barista').visible, true);
  assert.equal(privacy.getProfileReadiness(cafe, 'cafe_owner_manager').complete, true);
  assert.equal(privacy.getProfileReadiness({ ...barista, avatar_url: null }, 'barista').complete, false);
  for (const date_of_birth of ['', '2020-01-01', '2000-02-30']) assert.equal(privacy.getProfileReadiness({ ...barista, date_of_birth }, 'barista').complete, false);
  for (const gender_identity of [undefined, '', null, 'female', 'male']) assert.equal(privacy.getProfileReadiness({ ...barista, gender_identity }, 'barista').complete, true);
  assert.equal(privacy.getProfileReadiness({ ...cafe, barista_preferences: ['  '] }, 'cafe_owner_manager').complete, false);
  for (const change of [{ is_discoverable: false }, { visible_to_cafes: false }, { suspended_at: 'date' }]) assert.equal(privacy.getProfileReadiness({ ...barista, ...change }, 'barista').visible, false);
});

test('profile payload honors cleared skills, validates exact ZIP, excludes private demographics and preserves saved opt-outs', () => {
  const payload = privacy.buildProfileUpdate({ ...barista, skills_text: '', gender_identity: '', preferred_radius_miles: 100, preferred_postal_code: ' 33101 ' }, 'barista', options);
  assert.deepEqual(plain(payload.skills), []); assert.equal(payload.is_discoverable, false); assert.equal(payload.preferred_postal_code, '33101'); assert.equal(payload.visible_to_cafes, true);
  for (const key of ['date_of_birth', 'gender_identity', 'preferred_radius_miles']) assert.equal(key in payload, false);
  assert.throws(() => privacy.buildProfileUpdate({ ...barista, preferred_postal_code: '331' }, 'barista', options));
  assert.throws(() => privacy.buildProfileUpdate(barista, 'barista', { ...options, locationCity: 'Atlanta, GA' }));
});

function persistenceClient({ privateError, publicError, saved = { ...barista, is_discoverable: false } } = {}) {
  const writes = [];
  return { writes, from: table => ({
    upsert: async data => { writes.push({ table, data }); return { error: privateError }; },
    update: data => ({ eq: (_, id) => ({ select: () => ({ single: async () => { writes.push({ table, data, id }); return { data: saved, error: publicError }; } }) }) }),
  }) };
}

test('private save failure prevents public discoverability; successful save uses the normalized server row', async () => {
  const demographics = { date_of_birth: '2000-01-01', gender_identity: null };
  const failed = persistenceClient({ privateError: new Error('private table unavailable') });
  await assert.rejects(privacy.persistProfileUpdate(failed, 'user-a', 'barista', { is_discoverable: true }, demographics, async () => {}));
  assert.deepEqual(failed.writes.map(row => row.table), ['profile_demographics']);
  const client = persistenceClient();
  const saved = await privacy.persistProfileUpdate(client, 'user-a', 'barista', { is_discoverable: true }, demographics, async () => {});
  assert.equal(saved.is_discoverable, false);
  assert.deepEqual(client.writes.map(row => row.table), ['profile_demographics', 'profiles']);
  assert.equal('date_of_birth' in client.writes[1].data, false);
});

test('session change between private and public updates prevents writing public data to a different account', async () => {
  const client = persistenceClient(); let checks = 0;
  await assert.rejects(privacy.persistProfileUpdate(client, 'user-a', 'barista', {}, { date_of_birth: '2000-01-01', gender_identity: null }, async () => { if (++checks === 2) throw new Error('session changed'); }));
  assert.equal(client.writes.length, 1);
});

// Exercise the actual screens with deterministic hooks, navigation and network.
// No native backend, real account, media library, or email is used.
function screen(name, mocks) {
  const states = [], refs = [], effects = [], alerts = [], routes = [];
  let cursor = 0, refCursor = 0, effectCursor = 0, tree;
  const jsx = (type, props) => ({ type, props: props || {} });
  const native = new Proxy({ Platform: { OS: 'ios' }, StyleSheet: { create: value => value }, Alert: { alert: (...args) => alerts.push(args) }, useWindowDimensions: () => ({ width: 400, height: 900, fontScale: 1 }), ...mocks.native }, { get: (target, key) => key in target ? target[key] : key });
  const react = {
    useState: initial => { const key = cursor++; if (!(key in states)) states[key] = typeof initial === 'function' ? initial() : initial; return [states[key], value => { states[key] = typeof value === 'function' ? value(states[key]) : value; }]; },
    useRef: initial => { const key = refCursor++; return refs[key] ||= { current: initial }; },
    useCallback: fn => fn,
    useEffect: fn => { const key = effectCursor++; if (!(key in effects)) effects[key] = fn(); },
  };
  const router = { replace: value => routes.push(value), push: value => routes.push(value) };
  const component = compile(name, { ...mocks, react, 'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'Fragment' }, 'react-native': native, 'expo-router': { router, useLocalSearchParams: () => mocks.params || {}, useFocusEffect: react.useEffect }, '@/components/AppBottomNav': { AppBottomNav: 'AppBottomNav' }, 'expo-image-picker': mocks.picker || {} }).default;
  const render = () => { cursor = 0; refCursor = 0; effectCursor = 0; tree = component(); return tree; };
  const nodes = () => { const result = []; const visit = node => { if (Array.isArray(node)) return node.forEach(visit); if (!node || typeof node !== 'object') return; result.push(node); visit(node.props?.children); }; visit(tree); return result; };
  const text = node => !node ? '' : Array.isArray(node) ? node.map(text).join('') : typeof node === 'object' ? text(node.props?.children) : String(node);
  const button = label => nodes().find(node => node.type === 'Pressable' && text(node) === label);
  render();
  return { render, nodes, button, alerts, routes, blur: () => effects.forEach(cleanup => cleanup?.()) };
}

function profileBackend() {
  let saved = { ...cafe };
  const publicSave = deferred(), uploads = [];
  const client = { auth: { getSession: async () => ({ data: { session: { user: { id: 'user-a' }, access_token: 'token-user-a' } }, error: null }) },
    rpc: () => ({ setHeader: () => Promise.resolve({ error: null }) }),
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: saved, error: null }) }) }), update: payload => ({ eq: () => ({ select: () => ({ single: async () => { const result = await publicSave.promise; if (result.error) return result; saved = { ...saved, ...payload, is_discoverable: false }; return { data: saved, error: null }; } }) }) }) }),
    storage: { from: () => ({ upload: async (path, bytes) => { uploads.push({ path, bytes }); return { error: null }; }, getPublicUrl: path => ({ data: { publicUrl: `https://images.example/${path}` } }) }) },
  };
  return { client, publicSave, uploads };
}

test('actual profile editor Cancel restores saved fields instead of showing an unsaved draft as saved', async () => {
  const backend = profileBackend(); const ui = screen('app/profile.tsx', backend);
  await flush(); ui.render(); ui.button('Edit profile').props.onPress(); ui.render();
  ui.nodes().find(node => node.props.label === 'Café name').props.onChange('Unsaved draft'); ui.render();
  ui.button('Cancel').props.onPress(); ui.render(); ui.button('Edit profile').props.onPress(); ui.render();
  assert.equal(ui.nodes().find(node => node.props.label === 'Café name').props.value, cafe.cafe_name);
});

test('actual profile save locks cancel and inputs, rejects duplicate saves and confirms returned visibility', async () => {
  const backend = profileBackend(); const ui = screen('app/profile.tsx', backend);
  await flush(); ui.render(); ui.button('Edit profile').props.onPress(); ui.render();
  const first = ui.button('Save profile').props.onPress(); ui.render();
  assert.equal(ui.button('Saving profile…').props.disabled, true);
  ui.button('Saving profile…').props.onPress(); ui.render();
  assert.equal(ui.nodes().find(node => node.props.label === 'Café name').props.editable, false);
  await ui.button('Saving…').props.onPress();
  backend.publicSave.resolve({ error: null }); await first; ui.render();
  assert.ok(ui.button('Edit profile'));
  assert.match(ui.alerts.at(-1)[1], /currently hidden/);
});

test('actual profile save failure keeps the draft open for retry and never displays success', async () => {
  const backend = profileBackend(); const ui = screen('app/profile.tsx', backend);
  await flush(); ui.render(); ui.button('Edit profile').props.onPress(); ui.render();
  ui.nodes().find(node => node.props.label === 'Café name').props.onChange('Retry draft'); ui.render();
  const pending = ui.button('Save profile').props.onPress(); backend.publicSave.resolve({ error: new Error('offline') }); await pending; ui.render();
  assert.ok(ui.button('Cancel')); assert.equal(ui.nodes().find(node => node.props.label === 'Café name').props.value, 'Retry draft');
  assert.equal(ui.alerts.at(-1)[0], 'Could not finish saving');
});

test('profile completion after leaving the screen cannot replace another screen or show a stale success', async () => {
  const backend = profileBackend(); const ui = screen('app/profile.tsx', backend);
  await flush(); ui.render(); ui.button('Edit profile').props.onPress(); ui.render();
  const pending = ui.button('Save profile').props.onPress(); await flush(); ui.blur();
  backend.publicSave.resolve({ error: null }); await pending;
  assert.equal(ui.routes.length, 0); assert.equal(ui.alerts.length, 0);
});

function fillSignup(ui) {
  ui.nodes().find(node => node.type === 'Pressable' && node.props.children?.props?.children === '☕ Barista').props.onPress(); ui.render();
  ui.nodes().find(node => node.props.placeholder === 'Your full name').props.onChangeText('Sample Person');
  ui.nodes().find(node => node.props.accessibilityLabel === 'City').props.onChangeText('Miami');
  const email = ui.nodes().find(node => node.props.placeholder === 'you@example.com');
  if (email) {
    email.props.onChangeText('sample@example.invalid');
    ui.nodes().find(node => node.props.placeholder === 'At least 10 characters').props.onChangeText('test-password');
    ui.nodes().find(node => node.props.placeholder === 'Repeat your password').props.onChangeText('test-password');
  }
  ui.nodes().find(node => node.props.accessibilityRole === 'checkbox').props.onPress(); ui.render();
}

test('signup requires an explicit role and never writes a profile without a confirmed session', async () => {
  const gate = deferred(); let signups = 0, writes = 0;
  const client = { auth: { getSession: async () => ({ data: { session: null }, error: null }), signUp: async () => { signups++; return gate.promise; } }, from: () => { writes++; throw new Error('Unauthenticated write'); } };
  const ui = screen('app/signup.tsx', { client }); await flush(); ui.render();
  await ui.button('Create account').props.onPress(); assert.equal(ui.alerts.at(-1)[0], 'Choose your account type');
  fillSignup(ui);
  const first = ui.button('Create account').props.onPress(); ui.render();
  assert.equal(ui.nodes().find(node => node.props.placeholder === 'Your full name').props.editable, false);
  await ui.button('Saving account…').props.onPress(); await flush(); assert.equal(signups, 1);
  gate.resolve({ data: { user: { id: 'synthetic-user' }, session: null }, error: null }); await first;
  assert.equal(writes, 0); assert.equal(ui.routes.at(-1).pathname, '/verify-email');
});

test('OAuth setup collects role and consent without another password signup, and inserts the selected role', async () => {
  const backend = sessionClient(); let signupCalls = 0; backend.client.auth.signUp = async () => { signupCalls++; };
  const ui = screen('app/signup.tsx', { client: backend.client, params: { complete: '1' } }); await flush(); ui.render();
  assert.equal(ui.nodes().some(node => node.props.placeholder === 'At least 10 characters'), false);
  fillSignup(ui); await ui.button('Finish account setup').props.onPress();
  assert.equal(signupCalls, 0); assert.equal(backend.writes.length, 1); assert.equal(backend.writes[0].role, 'barista');
  assert.equal(ui.routes.at(-1), '/profile');
});

test('signup rejected by the network preserves the completed form and enables retry', async () => {
  const client = { auth: { getSession: async () => ({ data: { session: null }, error: null }), signUp: async () => { throw new Error('offline'); } } };
  const ui = screen('app/signup.tsx', { client }); await flush(); ui.render(); fillSignup(ui);
  await ui.button('Create account').props.onPress(); ui.render();
  assert.equal(ui.button('Create account').props.disabled, false);
  assert.equal(ui.nodes().find(node => node.props.placeholder === 'Your full name').props.value, 'Sample Person');
  assert.equal(ui.alerts.at(-1)[0], 'Unable to finish account setup');
});

test('reset request prevents duplicate sends and does not navigate or alert over a screen opened later', async () => {
  const gate = deferred(); let requests = 0;
  const client = { auth: { resetPasswordForEmail: async () => { requests++; return gate.promise; } } };
  const ui = screen('app/forgot-password.tsx', { client });
  ui.nodes().find(node => node.type === 'TextInput').props.onChangeText('sample@example.invalid'); ui.render();
  const first = ui.button('Send reset link').props.onPress(); ui.render();
  await ui.button('Sending…').props.onPress(); assert.equal(requests, 1); ui.blur();
  gate.resolve({ error: null }); await first; assert.equal(ui.routes.length, 0); assert.equal(ui.alerts.length, 0);
});

test('media picker result from a cancelled profile edit cannot appear in a reopened draft', async () => {
  const backend = profileBackend(); const gate = deferred();
  const picker = { launchImageLibraryAsync: async () => gate.promise, UIImagePickerPreferredAssetRepresentationMode: { Compatible: 'compatible' } };
  const ui = screen('app/profile.tsx', { ...backend, picker }); await flush(); ui.render(); ui.button('Edit profile').props.onPress(); ui.render();
  const picking = ui.nodes().find(node => node.props.label === 'Café logo or profile picture').props.onPress();
  ui.button('Cancel').props.onPress(); ui.render(); ui.button('Edit profile').props.onPress(); ui.render();
  gate.resolve({ canceled: false, assets: [{ uri: 'file://photo.jpg', fileName: 'old-photo.jpg', fileSize: 20, mimeType: 'image/jpeg' }] }); await picking; ui.render();
  assert.equal(ui.nodes().find(node => node.props.label === 'Café logo or profile picture').props.value, 'Current picture saved ✓');
});

test('warm callback uses the current Expo route fragment rather than a stale initial app URL', async () => {
  let exchanges = 0;
  const { client } = sessionClient({ role: 'cafe_owner_manager' });
  client.auth.setSession = async () => { exchanges++; return { data: { user: { id: 'user-a' } }, error: null }; };
  const ui = screen('app/auth/callback.tsx', { client, params: { '#': 'access_token=warm-token&refresh_token=refresh' }, native: { Linking: { getInitialURL: async () => 'baristamatch://home', addEventListener: () => ({ remove() {} }) } } });
  await flush(); ui.render(); ui.blur();
  assert.equal(exchanges, 1); assert.deepEqual(ui.routes, ['/home']);
});

test('OAuth callback with no saved role routes to explicit setup without writing metadata defaults', async () => {
  const backend = sessionClient();
  const ui = screen('app/auth/callback.tsx', { client: backend.client, params: { access_token: 'token', refresh_token: 'refresh' }, native: { Linking: { getInitialURL: async () => null, addEventListener: () => ({ remove() {} }) } } });
  await flush(); ui.render(); ui.blur();
  assert.equal(backend.writes.length, 0); assert.equal(ui.routes.at(-1).pathname, '/signup'); assert.equal(ui.routes.at(-1).params.complete, '1');
});

test('callback completing after the screen loses focus cannot replace a newer destination', async () => {
  const gate = deferred(); const { client } = sessionClient({ role: 'barista' });
  client.auth.setSession = async () => gate.promise;
  const ui = screen('app/auth/callback.tsx', { client, params: { '#': 'access_token=token&refresh_token=refresh' }, native: { Linking: { getInitialURL: async () => null, addEventListener: () => ({ remove() {} }) } } });
  ui.blur(); gate.resolve({ data: { user: { id: 'user-a' } }, error: null }); await flush();
  assert.equal(ui.routes.length, 0);
});
