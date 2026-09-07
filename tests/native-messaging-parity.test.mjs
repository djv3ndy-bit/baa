import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url), ts = require('../mobile/node_modules/typescript');
function loadTs(file, mocks = {}) {
  const module = { exports: {} }, source = fs.readFileSync(new URL(`../mobile/${file}`, import.meta.url), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  vm.runInNewContext(code, { module, exports: module.exports, require: name => { if (Object.hasOwn(mocks, name)) return mocks[name]; throw new Error(`Unmocked module ${name}`); }, console, setTimeout, clearTimeout, URLSearchParams, TypeError, Error }, { filename: file });
  return module.exports;
}
const messaging = loadTs('lib/messaging.ts'), routing = loadTs('lib/notificationRouting.ts');
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
const plain = value => JSON.parse(JSON.stringify(value));
const msg = (id = 'message-1', body = 'Hello', sender_id = 'me') => ({ id, body, sender_id, created_at: '2026-09-07T12:00:00Z' });

test('draft send suppresses duplicate submits and preserves text typed while delivery is pending', async () => {
  const store = new messaging.MessageDraftStore(), pending = deferred(); let calls = 0;
  store.edit('me:application:A', '  Hello  ');
  const first = store.send('me:application:A', async () => { calls++; return pending.promise; });
  assert.equal(await store.send('me:application:A', async () => { calls++; return msg(); }), null);
  store.edit('me:application:A', 'A newer draft');
  pending.resolve(msg()); await first;
  assert.equal(calls, 1); assert.equal(store.snapshot('me:application:A').body, 'A newer draft'); assert.equal(store.snapshot('me:application:A').sending, false);
});
test('uncertain delivery retry retains its UUID; changed body and successful delivery start new attempts', async () => {
  const store = new messaging.MessageDraftStore(), attempts = [];
  store.edit('me:discovery:A', 'Hello');
  await store.send('me:discovery:A', async (body, id) => { attempts.push(id); throw new TypeError('offline'); });
  assert.equal(store.snapshot('me:discovery:A').body, 'Hello'); assert.match(store.snapshot('me:discovery:A').error, /Connection lost/);
  await store.send('me:discovery:A', async (body, id) => { attempts.push(id); return msg(); });
  assert.equal(attempts[0], attempts[1]); assert.match(attempts[0], /^[0-9a-f-]{36}$/);
  store.edit('me:discovery:A', 'Hello');
  await store.send('me:discovery:A', async (body, id) => { attempts.push(id); throw new Error('offline'); });
  store.edit('me:discovery:A', 'Changed');
  await store.send('me:discovery:A', async (body, id) => { attempts.push(id); return msg(); });
  assert.notEqual(attempts[1], attempts[2]); assert.notEqual(attempts[2], attempts[3]);
});
test('drafts and delivery errors remain isolated by account and conversation', async () => {
  const store = new messaging.MessageDraftStore(), pending = deferred();
  store.edit('me:application:A', 'Original');
  const send = store.send('me:application:A', () => pending.promise);
  store.edit('me:discovery:B', 'Other conversation'); store.edit('other:application:A', 'Other account');
  pending.reject(new Error('A failed')); await send;
  assert.equal(store.snapshot('me:discovery:B').body, 'Other conversation'); assert.equal(store.snapshot('other:application:A').body, 'Other account');
  assert.equal(store.snapshot('me:discovery:B').error, ''); assert.equal(store.snapshot('me:application:A').body, 'Original');
});
test('application delivery captures recipient, account and idempotency ID before awaiting session', async () => {
  const pending = deferred(), calls = [], input = { kind: 'application', id: 'A', senderId: 'me', body: 'Hello', clientMessageId: 'stable-id' };
  const send = messaging.deliverMessage({ auth: { getSession: () => pending.promise } }, async (...args) => { calls.push(args); return { message: msg() }; }, input);
  input.id = 'B'; input.senderId = 'someone-else';
  pending.resolve({ data: { session: { user: { id: 'me' }, access_token: 'test' } }, error: null });
  await send;
  assert.deepEqual(plain(calls[0]), ['/send-message', { application_id: 'A', body: 'Hello', client_message_id: 'stable-id' }, 'POST', 'me']);
});
test('expired or changed accounts stop a send before any database or API request', async () => {
  for (const session of [null, { user: { id: 'other' }, access_token: 'test' }]) {
    let calls = 0;
    const client = { auth: { getSession: async () => ({ data: { session }, error: null }) }, from() { calls++; } };
    await assert.rejects(messaging.deliverMessage(client, async () => { calls++; }, { kind: 'discovery', id: 'A', senderId: 'me', body: 'Hello', clientMessageId: 'stable-id' }));
    assert.equal(calls, 0);
  }
});
test('discovery retry verifies an identical stored message and keeps the original notification destination', async () => {
  const filters = [], inserts = [], apiCalls = [];
  const client = { auth: { getSession: async () => ({ data: { session: { user: { id: 'me' }, access_token: 'test' } } }) }, from() {
    let insert = false;
    return { insert(value) { inserts.push(value); insert = true; return this; }, select() { return this; }, eq(...args) { filters.push(args); return this; }, single: async () => insert ? { error: { code: '23505' } } : { data: msg('stable-id'), error: null } };
  } };
  const result = await messaging.deliverMessage(client, async (...args) => { apiCalls.push(args); }, { kind: 'discovery', id: 'match-A', senderId: 'me', body: 'Hello', clientMessageId: 'stable-id' });
  assert.equal(result.id, 'stable-id'); assert.deepEqual(plain(inserts[0]), { id: 'stable-id', match_id: 'match-A', sender_id: 'me', body: 'Hello' });
  assert.deepEqual(filters, [['id', 'stable-id'], ['match_id', 'match-A'], ['sender_id', 'me']]);
  assert.equal(apiCalls[0][1].match_id, 'match-A'); assert.equal(apiCalls[0][3], 'me');
});
test('discovery idempotency collisions never acknowledge different message contents', async () => {
  const client = { auth: { getSession: async () => ({ data: { session: { user: { id: 'me' }, access_token: 'test' } } }) }, from() {
    let insert = false; return { insert() { insert = true; return this; }, select() { return this; }, eq() { return this; }, single: async () => insert ? { error: { code: '23505' } } : { data: msg('same-id', 'Different text'), error: null } };
  } };
  let pushed = false;
  await assert.rejects(messaging.deliverMessage(client, async () => { pushed = true; }, { kind: 'discovery', id: 'A', senderId: 'me', body: 'Hello', clientMessageId: 'same-id' }), /could not be verified/);
  assert.equal(pushed, false);
});
test('latest requests reject stale responses and message reconciliation renders each ID once', () => {
  const requests = new messaging.LatestMessageRequest(), old = requests.begin(), current = requests.begin();
  assert.equal(old(), false); assert.equal(current(), true); requests.invalidate(); assert.equal(current(), false);
  assert.equal(messaging.mergeMessages([msg()], [msg()]).length, 1);
});
test('all message pages load despite a smaller server page cap and query errors are propagated', async () => {
  const source = Array.from({ length: 240 }, (_, id) => ({ id })), offsets = [];
  const rows = await messaging.allMessageRows(() => ({ range: async from => { offsets.push(from); return { data: source.slice(from, from + 100), error: null }; } }));
  assert.equal(rows.length, 240); assert.deepEqual(offsets, [0, 100, 200, 240]);
  await assert.rejects(messaging.allMessageRows(() => ({ range: async () => ({ data: null, error: { message: 'offline' } }) })));
});
test('a stalled request exits sending and preserves the same retry ID', async () => {
  const store = new messaging.MessageDraftStore(), attempts = [], pending = deferred();
  store.edit('me:discovery:A', 'Hello');
  await store.send('me:discovery:A', (_, attemptId) => { attempts.push(attemptId); return messaging.withMessageDeadline(pending.promise, 1); });
  assert.equal(store.snapshot('me:discovery:A').sending, false);
  assert.match(store.snapshot('me:discovery:A').error, /timed out/);
  assert.equal(store.snapshot('me:discovery:A').body, 'Hello');
  pending.resolve(msg());
  await store.send('me:discovery:A', async (_, attemptId) => { attempts.push(attemptId); return msg(); });
  assert.equal(attempts[0], attempts[1]);
});
test('inbox sorting and badges distinguish discovery and application unread notifications', () => {
  const rows = messaging.buildConversations('barista', [{ id: 'A', created_at: '2026-01-01', job: null }], [{ id: 'B', created_at: '2026-01-02', cafe: { cafe_name: 'Café B' } }], [{ application_id: 'A', body: 'Newest', created_at: '2026-09-07' }], [{ match_id: 'B', body: 'Older', created_at: '2026-09-06' }], [{ id: 'n1', type: 'message', application_id: 'A' }, { id: 'n2', type: 'message', discovery_match_id: 'B' }, { id: 'n3', type: 'message', discovery_match_id: 'B', read_at: 'yesterday' }]);
  assert.deepEqual(plain(rows.map(row => [row.id, row.name, row.unread])), [['A', 'Café', 1], ['B', 'Café B', 1]]);
});
test('unread loaders use the live discovery table column and read RPC is scoped to the selected match', async () => {
  const requests = [], calls = [];
  const client = { from(table) { return { select(fields) { requests.push([table, fields]); return this; }, eq() { return this; }, is() { return this; }, order() { return this; }, range: async from => ({ data: from ? [] : table === 'notifications' ? [{ id: '1', type: 'message', application_id: 'A' }] : [{ id: '2', discovery_match_id: 'B' }], error: null }) }; }, rpc: async (...args) => { calls.push(args); return { error: null }; } };
  const unread = await messaging.unreadNotifications(client, 'me');
  assert.equal(unread[1].discovery_match_id, 'B'); assert.ok(requests.some(([table, fields]) => table === 'discovery_message_notifications' && fields.includes('discovery_match_id')));
  await messaging.markChatRead(client, 'discovery', 'B'); await messaging.markChatRead(client, 'application', 'A');
  assert.deepEqual(plain(calls), [['mark_discovery_conversation_read', { p_match_id: 'B' }], ['mark_conversation_read', { p_application_id: 'A' }]]);
});

function chatHarness(options = {}) {
  const states = [], refs = [], callbacks = [], effects = [], channels = [], readCalls = [], routes = [];
  let index = 0, effectIndex = 0, focus, focusCleanup, pendingFocus, params = ['A', 'discovery'];
  const appState = { currentState: 'active', addEventListener: () => ({ remove() {} }) };
  const react = {
    useState(initial) { const slot = index++; if (!(slot in states)) states[slot] = typeof initial === 'function' ? initial() : initial; return [states[slot], value => { states[slot] = typeof value === 'function' ? value(states[slot]) : value; }]; },
    useRef(initial) { const slot = index++; return refs[slot] ||= { current: initial }; },
    useCallback(callback, deps) { const slot = index++; const previous = callbacks[slot]; if (!previous || deps.some((value, i) => value !== previous.deps[i])) callbacks[slot] = { callback, deps }; return callbacks[slot].callback; },
    useEffect(callback) { const slot = effectIndex++; if (!effects[slot]) effects[slot] = callback(); },
  };
  const client = { auth: { onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }), getSession: async () => ({ data: { session: { user: { id: 'me' }, access_token: 'test' } } }) },
    channel() { const channel = { on(event, filter, fn) { this.callback = fn; return this; }, subscribe() { return this; } }; channels.push(channel); return channel; }, removeChannel(channel) { channel.removed = true; },
    rpc: async (...args) => { readCalls.push(args); return options.read ? options.read() : { error: null }; },
    from(table) { let id; return { select() { return this; }, eq(column, value) { if (['id', 'match_id', 'application_id'].includes(column)) id = value; return this; }, order() { return this; },
      maybeSingle: async () => ({ data: options.paused ? { id, barista_id: 'me', job: null } : { id, barista_id: 'me', cafe_id: `cafe-${id}`, cafe: { cafe_name: `Café ${id}` } }, error: null }),
      range: async from => from ? { data: [], error: null } : options.load ? options.load(id) : { data: [msg(`message-${id}`, id, 'cafe')], error: null },
    }; },
  };
  const module = loadTs('lib/useConversation.ts', { react, 'react-native': { AppState: appState }, 'expo-router': { router: { replace: route => routes.push(route) }, useFocusEffect(callback) { if (callback !== focus) pendingFocus = callback; } }, './supabase': { supabase: client }, './session': { getCurrentContext: async () => ({ user: { id: 'me' }, role: 'barista' }) }, './api': { authenticatedApi: options.api || (async () => ({ message: msg() })) }, './safety': { isMessageAllowed: text => !!text.trim() }, './messaging': { ...messaging, messageDrafts: new messaging.MessageDraftStore() } });
  function render() { index = 0; effectIndex = 0; const value = module.useConversation(...params); if (pendingFocus) { focusCleanup?.(); focus = pendingFocus; pendingFocus = null; focusCleanup = focus(); } return value; }
  render();
  return { render, async settle() { await tick(); return render(); }, navigate(id, kind = 'discovery') { params = [id, kind]; render(); }, blur() { focusCleanup?.(); }, appState, readCalls, channels, routes };
}
test('switching chats ignores the older response and never marks the old conversation read', async () => {
  const pending = deferred();
  const h = chatHarness({ load: id => id === 'A' ? pending.promise : Promise.resolve({ data: [msg('B-message', 'B')], error: null }) });
  await tick(); h.navigate('B'); await h.settle(); pending.resolve({ data: [msg('A-message', 'A')], error: null });
  const state = await h.settle();
  assert.equal(state.messages[0].body, 'B'); assert.equal(h.channels[0].removed, true); assert.ok(h.readCalls.every(call => call[1].p_match_id === 'B'));
  h.blur();
});
test('background and blurred chats do not acknowledge newly fetched messages', async () => {
  const pending = deferred(), h = chatHarness({ load: () => pending.promise });
  await tick(); h.appState.currentState = 'background'; pending.resolve({ data: [msg()], error: null }); await h.settle();
  assert.equal(h.readCalls.length, 0); h.blur();
  const next = deferred(), second = chatHarness({ load: () => next.promise }); await tick(); second.blur(); next.resolve({ data: [msg()], error: null }); await second.settle(); assert.equal(second.readCalls.length, 0);
});
test('paused-job chats use authenticated metadata and still expose the correct safety target', async () => {
  const calls = [], h = chatHarness({ paused: true, api: async (...args) => { calls.push(args); return { cafe: { id: 'cafe-owner', name: 'Paused Café' }, job: { id: 'job', title: 'Old role' } }; } });
  h.navigate('application-A', 'application');
  const state = await h.settle(); assert.equal(state.ready, true); assert.equal(state.name, 'Paused Café'); assert.equal(state.otherUserId, 'cafe-owner');
  assert.equal(calls[0][0], '/conversation-details?application_id=application-A'); assert.equal(calls[0][3], 'me'); h.blur();
});
test('chat loading failures offer retry without showing a false empty conversation', async () => {
  let failed = true;
  const h = chatHarness({ load: async () => { if (failed) throw new Error('offline'); return { data: [msg()], error: null }; } });
  let state = await h.settle(); assert.equal(state.loading, false); assert.match(state.error, /offline/); assert.equal(state.messages.length, 0);
  failed = false; state.retry(); state = await h.settle(); assert.equal(state.messages.length, 1); assert.equal(state.error, ''); h.blur();
});
test('unread acknowledgement does not hide messages while it is pending and its failure stays recoverable', async () => {
  const pending = deferred(), h = chatHarness({ read: () => pending.promise });
  let state = await h.settle();
  assert.equal(state.loading, false); assert.equal(state.messages.length, 1);
  pending.resolve({ error: { message: 'offline' } }); state = await h.settle();
  assert.match(state.error, /Messages loaded/); assert.equal(state.ready, true); h.blur();
});

const id = '11111111-1111-4111-8111-111111111111';
test('notification routing preserves conversation type and requested job while rejecting external and unsupported routes', () => {
  assert.equal(routing.notificationDestination({ route: `/chat/${id}?kind=discovery` }), `/chat/${id}?kind=discovery`);
  assert.equal(routing.notificationDestination({ route: `/chat/${id}` }), `/chat/${id}?kind=application`);
  assert.equal(routing.notificationDestination({ type: 'job', jobId: id, route: '/discover' }), `/discover?jobId=${id}`);
  for (const route of ['//evil.example', '/chat/invalid', '/settings?delete=1', '/chat/'+id+'?kind=evil', 'https://example.test']) assert.equal(routing.notificationDestination({ route }), null);
});

function pushHarness(options = {}) {
  const calls = [], routes = [], stored = new Map(), listeners = {};
  let session = { user: { id: 'me' }, access_token: 'test' };
  const permission = { granted: false, status: 'denied', canAskAgain: true, ...options.permission };
  const notification = { IosAuthorizationStatus: { PROVISIONAL: 3 }, AndroidImportance: { HIGH: 4 }, setNotificationHandler() {},
    getPermissionsAsync: async () => permission,
    requestPermissionsAsync: async () => { calls.push('prompt'); return { ...permission, granted: true }; },
    getExpoPushTokenAsync: async () => { if (options.token) return options.token(); return { data: 'ExponentPushToken[test]' }; },
    setNotificationChannelAsync: async () => {}, clearLastNotificationResponseAsync: async () => { calls.push('clear'); },
    getLastNotificationResponseAsync: async () => options.last || null,
    addNotificationResponseReceivedListener(fn) { listeners.response = fn; return { remove() {} }; },
  };
  const client = { auth: { getSession: async () => ({ data: { session }, error: null }), onAuthStateChange(fn) { listeners.auth = fn; return { data: { subscription: { unsubscribe() {} } } }; } }, from() { return { upsert: async row => { calls.push(['upsert', row]); return { error: null }; }, delete() { calls.push('delete'); return this; }, eq() { return this; }, then(resolve) { return Promise.resolve({ error: null }).then(resolve); } }; } };
  const module = loadTs('lib/pushNotifications.ts', { 'react-native': { Platform: { OS: 'ios' } }, '@react-native-async-storage/async-storage': { default: { setItem: async (key, value) => stored.set(key, value), getItem: async key => stored.get(key) || null, removeItem: async key => stored.delete(key) } }, 'expo-constants': { default: { expoConfig: { extra: { eas: { projectId: 'test-project' } } } } }, 'expo-device': { isDevice: true }, 'expo-notifications': notification, 'expo-router': { router: { push: route => routes.push(route) } }, './supabase': { supabase: client }, './notificationRouting': routing });
  return { module, calls, routes, listeners, stored, permission, setSession(value) { session = value; } };
}
test('automatic registration never prompts and explicit enable reports the actual permission result', async () => {
  const h = pushHarness(); assert.equal((await h.module.registerForPhoneNotifications()).status, 'denied'); assert.equal(h.calls.length, 0);
  assert.equal((await h.module.registerForPhoneNotifications({ requestPermission: true })).status, 'enabled'); assert.equal(h.calls[0], 'prompt');
  h.permission.canAskAgain = false; assert.equal((await h.module.registerForPhoneNotifications({ requestPermission: true })).status, 'denied');
});
test('notification registration refuses account switches and logout removes saved tokens even after permission revocation', async () => {
  const pending = deferred(), switched = pushHarness({ permission: { granted: true }, token: () => pending.promise });
  const registration = switched.module.registerForPhoneNotifications(); await tick(); switched.setSession({ user: { id: 'other' } }); pending.resolve({ data: 'token' }); await assert.rejects(registration, /account changed/); assert.equal(switched.calls.length, 0);
  const h = pushHarness({ permission: { granted: true } }); await h.module.registerForPhoneNotifications(); h.permission.granted = false; await h.module.unregisterThisDeviceNotifications(); assert.ok(h.calls.includes('delete')); assert.equal(h.stored.size, 0);
});
test('notification logout refuses another account before and after token lookup', async () => {
  const changed = pushHarness({ permission: { granted: true } });
  changed.setSession({ user: { id: 'other' } });
  await assert.rejects(changed.module.unregisterThisDeviceNotifications('me'), /account changed/);
  assert.ok(!changed.calls.includes('delete'));
  const pending = deferred(), during = pushHarness({ permission: { granted: true }, token: () => pending.promise });
  const logout = during.module.unregisterThisDeviceNotifications('me');
  await tick(); during.setSession({ user: { id: 'other' } }); pending.resolve({ data: 'other-token' });
  await assert.rejects(logout, /account changed/); assert.ok(!during.calls.includes('delete'));
});
test('notification taps wait for sign-in, route once, and are ignored after listener cleanup', async () => {
  const response = { actionIdentifier: 'tap', notification: { request: { identifier: 'n1', content: { data: { route: `/chat/${id}?kind=discovery` } } } } };
  const h = pushHarness(); h.setSession(null); const stop = h.module.listenForPhoneNotifications(); h.listeners.response(response); await tick(); assert.equal(h.routes.length, 0);
  h.setSession({ user: { id: 'me' } }); h.listeners.auth('SIGNED_IN'); await new Promise(resolve => setTimeout(resolve, 5)); await tick();
  h.listeners.response(response); await tick(); assert.deepEqual(h.routes, [`/chat/${id}?kind=discovery`]);
  stop(); h.listeners.response({ ...response, notification: { request: { ...response.notification.request, identifier: 'n2' } } }); await tick(); assert.equal(h.routes.length, 1);
});

test('home totals include sent interests, incoming candidates and both message notification systems', () => {
  const home = loadTs('lib/homeSummary.ts', { '@/lib/floridaLocation': { jobMatchesWorkArea: (profile, job) => job.city === profile.preferred_city }, './messaging': messaging });
  const jobs = [{ city: 'Miami' }, { city: 'Orlando' }], apps = [{ status: 'matched' }, { status: 'interested' }], interests = [{ sender_id: 'me', target_id: 'cafe' }, { sender_id: 'new', target_id: 'me' }, { sender_id: 'matched', target_id: 'me' }], matches = [{ barista_id: 'matched', cafe_id: 'me' }], notifications = [{ id: 'a', type: 'message', application_id: 'A' }, { id: 'b', type: 'message', discovery_match_id: 'B' }, { id: 'c', type: 'match' }];
  const barista = home.summarizeHome('me', 'barista', { preferred_city: 'Miami' }, jobs, apps, interests, matches, notifications);
  assert.equal(barista.jobs, 1); assert.equal(barista.applications, 3); assert.equal(barista.matches, 2); assert.equal(barista.messages, 2);
  assert.equal(home.summarizeHome('me', 'cafe_owner_manager', {}, jobs, apps, interests, matches, notifications).candidates, 2);
});
