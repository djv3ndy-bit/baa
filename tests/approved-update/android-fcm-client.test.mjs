import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTypescript, plain } from './load-typescript.mjs';

const module = loadTypescript('mobile/lib/androidFcmRegistration.ts');
const key = 'sb_publishable_SYNTHETIC_ANDROID_TEST_ONLY';
const isolated = { review: true, apiBase: 'https://android-testing.baristajobmatch.com/api',
  supabaseUrl: 'https://ojvjlvojvozvhktbclcg.supabase.co', publishableKey: key };
const native = data => ({ type: 'android', data });
const deferred = () => { let resolve; return { promise: new Promise(done => { resolve = done; }), resolve }; };
const settle = async () => { for (let i = 0; i < 8; i++) await new Promise(done => setTimeout(done, 0)); };

function harness(options = {}) {
  let user = options.user === undefined ? 'cafe-a' : options.user, token = native('synthetic_fcm_a'), tokenCallback, authCallback;
  let permission = { granted: true, canAskAgain: true }, removes = 0;
  const calls = [], storage = new Map(), rows = new Map();
  if (options.saved) storage.set(module.ANDROID_FCM_TOKEN_KEY, JSON.stringify(options.saved));
  const deps = {
    requireEnabled: () => options.enabled !== false,
    userId: async () => user,
    storage: { async getItem(k) { if (options.read) await options.read(); return storage.get(k) || null; }, async setItem(k, value) { calls.push(['cache', k]); if (options.write) await options.write(); storage.set(k, value); }, async removeItem(k) { calls.push(['uncache', k]); storage.delete(k); } },
    async channel() { calls.push('channel'); }, async permissions() { calls.push('permissions'); return permission; },
    async requestPermission() { calls.push('request-permission'); return permission = { granted: options.grant !== false, canAskAgain: true }; },
    async token() { calls.push('native-token'); return options.token ? options.token() : token; },
    async invalidateNativeToken() { calls.push('invalidate'); if (options.invalidate) await options.invalidate(); token = native('synthetic_fcm_after_reset'); },
    async save(value, id) { calls.push(['save', value, id]); if (options.save) await options.save(value, id); if (rows.has(value) && rows.get(value) !== id) throw new Error('RLS ownership conflict'); rows.set(value, id); },
    async remove(value, id) { calls.push(['remove', value, id]); if (options.remove) await options.remove(value, id); if (rows.get(value) === id) rows.delete(value); },
    tokenListener(callback) { tokenCallback = callback; return () => { removes++; tokenCallback = null; }; },
    authListener(callback) { authCallback = callback; callback(user); return () => { removes++; authCallback = null; }; },
  };
  const controller = module.createAndroidFcmRegistration(deps);
  return { controller, calls, storage, rows, permission(value) { permission = value; },
    token(value) { token = value; }, refresh(value) { token = value; tokenCallback?.(value); },
    account(value, notify = true) { user = value; if (notify) authCallback?.(value); },
    saved: () => JSON.parse(storage.get(module.ANDROID_FCM_TOKEN_KEY) || 'null'), removes: () => removes };
}

test('direct FCM is available only for explicitly enabled, exact isolated Android review', () => {
  assert.equal(module.isolatedAndroidFcmEnabled('android', 'true', isolated, key), true);
  for (const platform of ['ios', 'web']) assert.equal(module.isolatedAndroidFcmEnabled(platform, 'true', isolated, key), false);
  for (const flag of [undefined, 'false', 'TRUE']) assert.equal(module.isolatedAndroidFcmEnabled('android', flag, isolated, key), false);
  for (const [name, value] of [['review', false], ['apiBase', 'https://www.baristajobmatch.com/api'],
    ['supabaseUrl', 'https://iqtpsxxlpncaeabbcxht.supabase.co'], ['publishableKey', 'other']]) {
    assert.throws(() => module.isolatedAndroidFcmEnabled('android', 'true', { ...isolated, [name]: value }, key), /isolated test build/);
  }
  for (const wrong of ['', 'sb_secret_fake', 'sb_publishable_470rDNz5G4PrUD5mvMu4Eg_LPcLOM4x']) {
    assert.throws(() => module.isolatedAndroidFcmEnabled('android', 'true', { ...isolated, publishableKey: wrong }, wrong), /isolated test build/);
  }
});

test('permission and session gates run before token collection or persistence', async () => {
  const guest = harness({ user: null }); assert.equal((await guest.controller.register(true)).status, 'no-session'); assert.deepEqual(guest.calls, ['invalidate', ['uncache', module.ANDROID_FCM_TOKEN_KEY]]);
  const denied = harness(); denied.permission({ granted: false, canAskAgain: false });
  assert.equal((await denied.controller.register(true)).status, 'denied'); assert.deepEqual(denied.calls, ['channel', 'permissions']);
  const accepted = harness(); accepted.permission({ granted: false, canAskAgain: true });
  assert.equal((await accepted.controller.register(true)).status, 'enabled');
  assert.ok(accepted.calls.indexOf('channel') < accepted.calls.indexOf('native-token'));
  assert.deepEqual(accepted.saved(), { token: 'synthetic_fcm_a', userId: 'cafe-a' });
  assert.ok(accepted.calls.some(value => Array.isArray(value) && value[0] === 'cache' && value[1] === module.ANDROID_FCM_TOKEN_KEY));
});

test('malformed, wrong-provider and Expo tokens cannot be persisted', async () => {
  for (const token of [{ type: 'ios', data: 'apns' }, native(''), native('has whitespace'), native('bad\u0000token'),
    native('x'.repeat(2049)), native('é'.repeat(1025)), native('ExponentPushToken[fake]')]) {
    const h = harness(); h.token(token); await assert.rejects(h.controller.register(), /token is unavailable/);
    assert.equal(h.rows.size, 0); assert.equal(h.saved(), null);
  }
});

test('account change during native-token collection prevents any database write', async () => {
  const gate = deferred(), h = harness({ token: () => gate.promise });
  const pending = h.controller.register(); await settle(); h.account('barista-b', false); gate.resolve(native('synthetic_old_account_token'));
  assert.equal((await pending).status, 'no-session'); assert.equal(h.rows.size, 0); assert.equal(h.saved(), null);
  assert.ok(h.calls.includes('invalidate'));
});

test('token refresh replaces only this account token without fetching recursively', async () => {
  const h = harness(), stop = h.controller.listen(); await h.controller.register(); h.calls.length = 0;
  h.refresh(native('synthetic_fcm_rotated')); await settle();
  assert.deepEqual([...h.rows], [['synthetic_fcm_rotated', 'cafe-a']]);
  assert.deepEqual(h.saved(), { token: 'synthetic_fcm_rotated', userId: 'cafe-a' });
  assert.ok(h.calls.some(value => Array.isArray(value) && value[0] === 'remove' && value[1] === 'synthetic_fcm_a'));
  assert.ok(!h.calls.includes('native-token')); stop(); assert.equal(h.removes(), 2);
  h.refresh(native('synthetic_after_stop')); await settle(); assert.equal(h.rows.size, 1);
});

test('unexpected account replacement invalidates old native delivery before new registration', async () => {
  const h = harness(), stop = h.controller.listen(); await h.controller.register(); h.calls.length = 0;
  h.account('barista-b'); await h.controller.register();
  assert.ok(h.calls.indexOf('invalidate') < h.calls.indexOf('native-token'));
  assert.equal(h.rows.get('synthetic_fcm_after_reset'), 'barista-b');
  assert.equal(h.rows.get('synthetic_fcm_a'), 'cafe-a'); // Its native token is invalid; never delete another owner's row.
  assert.ok(!h.calls.some(value => Array.isArray(value) && value[0] === 'remove' && value[2] === 'cafe-a'));
  stop();
});

test('failed native invalidation retains the cleanup handle and blocks the replacement account', async () => {
  const h = harness({ invalidate: async () => { throw new Error('native reset failed'); } }); h.controller.listen(); await h.controller.register();
  const old = h.saved(); h.account('barista-b'); await settle();
  await assert.rejects(h.controller.register(), /native reset failed/);
  assert.deepEqual(h.saved(), old); assert.equal(h.rows.size, 1);
});

test('logout waits an issued save, removes owned token and invalidates native delivery', async () => {
  const gate = deferred(), h = harness({ save: () => gate.promise }); h.controller.listen();
  const registration = h.controller.register(); await settle(); const logout = h.controller.unregister('cafe-a');
  h.refresh(native('synthetic_during_logout')); gate.resolve(); await Promise.all([registration, logout]); await settle();
  assert.equal(h.rows.size, 0); assert.equal(h.saved(), null); assert.ok(h.calls.includes('invalidate'));
  assert.ok(!h.calls.some(value => Array.isArray(value) && value[0] === 'save' && value[1] === 'synthetic_during_logout'));
});

test('logout failure or changed identity cannot discard the cached cleanup handle', async () => {
  const h = harness({ remove: async () => { throw new Error('delete failed'); } }); await h.controller.register();
  await assert.rejects(h.controller.unregister('cafe-a'), /delete failed/); assert.equal(h.saved().userId, 'cafe-a');
  const changed = harness(); await changed.controller.register(); changed.account('barista-b', false);
  await assert.rejects(changed.controller.unregister('cafe-a'), /account changed/); assert.equal(changed.saved().userId, 'cafe-a');
});

test('unknown-result registration failure invalidates native delivery, retaining the handle if reset fails', async () => {
  for (const fails of [false, true]) {
    const h = harness({ save: async () => { throw new Error('uncertain response'); },
      invalidate: async () => { if (fails) throw new Error('native reset failed'); } });
    await assert.rejects(h.controller.register(), fails ? /native reset failed/ : /uncertain response/);
    assert.ok(h.calls.includes('invalidate'));
    assert.equal(h.saved()?.token || null, fails ? 'synthetic_fcm_a' : null);
  }
});

test('signed-out cold start invalidates cached and uncached native delivery without querying another account row', async () => {
  for (const cached of [false, true]) {
    const h = harness({ user: null, ...(cached ? { saved: { userId: 'cafe-a', token: 'synthetic_fcm_a' } } : {}) });
    h.rows.set('synthetic_fcm_a', 'cafe-a'); const stop = h.controller.listen(); await settle();
    assert.ok(h.calls.includes('invalidate')); assert.equal(h.saved(), null);
    assert.equal(h.rows.get('synthetic_fcm_a'), 'cafe-a'); assert.ok(!h.calls.some(call => Array.isArray(call) && call[0] === 'remove'));
    stop();
  }
});

test('expired-session cleanup retains its handle on invalidation failure and retries on signed-out unregister', async () => {
  let fails = true;
  const h = harness({ user: null, saved: { userId: 'cafe-a', token: 'synthetic_fcm_a' },
    invalidate: async () => { if (fails) throw new Error('native reset failed'); } });
  await assert.rejects(h.controller.register(), /native reset failed/); assert.equal(h.saved().userId, 'cafe-a');
  fails = false; await h.controller.unregister('cafe-a'); assert.equal(h.saved(), null);
  assert.ok(!h.calls.includes('native-token'));
});

test('cold-start cleanup queued for a guest never resets a newly authenticated account', async () => {
  const h = harness({ user: null }), stop = h.controller.listen(); h.account('barista-b');
  await settle(); assert.ok(!h.calls.includes('invalidate'));
  await h.controller.register(); assert.equal(h.rows.get('synthetic_fcm_a'), 'barista-b'); stop();
});

test('missing or misleading current-account cache cannot transfer a prior-owner native token after RLS denial', async () => {
  for (const cached of [false, true]) for (const fails of [false, true]) {
    let failReset = fails;
    const h = harness({ user: 'barista-b', ...(cached ? { saved: { userId: 'barista-b', token: 'synthetic_fcm_a' } } : {}),
      invalidate: async () => { if (failReset) throw new Error('native reset failed'); } });
    h.rows.set('synthetic_fcm_a', 'cafe-a');
    await assert.rejects(h.controller.register(), fails ? /native reset failed/ : /RLS ownership conflict/);
    assert.equal(h.rows.get('synthetic_fcm_a'), 'cafe-a'); assert.ok(h.calls.includes('invalidate'));
    assert.equal(h.saved()?.userId || null, fails ? 'barista-b' : null);
    assert.ok(!h.calls.some(call => Array.isArray(call) && call[0] === 'remove' && call[2] === 'cafe-a'));
    failReset = false; await h.controller.register(); assert.equal(h.rows.get('synthetic_fcm_after_reset'), 'barista-b');
  }
});

test('confirmed deletion cleans native delivery without relying on an Auth row or deleting server rows', async () => {
  for (const user of [null, 'cafe-a']) {
    const h = harness({ user, saved: { userId: 'cafe-a', token: 'synthetic_fcm_a' } });
    await h.controller.confirmedDeletion('cafe-a');
    assert.equal(h.saved(), null); assert.ok(h.calls.includes('invalidate'));
    assert.ok(!h.calls.some(call => Array.isArray(call) && ['save', 'remove'].includes(call[0])));
  }
});

test('confirmed deletion preserves another active account or foreign cached cleanup handle', async () => {
  for (const [user, owner] of [['barista-b', 'cafe-a'], [null, 'barista-b'], ['cafe-a', 'barista-b']]) {
    const h = harness({ user, saved: { userId: owner, token: 'synthetic_fcm_a' } });
    await h.controller.confirmedDeletion('cafe-a');
    assert.equal(h.saved().userId, owner); assert.ok(!h.calls.includes('invalidate'));
  }
});

test('confirmed deletion waits an issued registration and blocks refresh while retaining failed-cleanup state', async () => {
  const gate = deferred(); let fails = true;
  const h = harness({ save: () => gate.promise, invalidate: async () => { if (fails) throw new Error('native reset failed'); } });
  const stop = h.controller.listen(), pending = h.controller.register(); await settle();
  const cleanup = h.controller.confirmedDeletion('cafe-a'); h.refresh(native('late_refresh')); gate.resolve();
  await pending; await assert.rejects(cleanup, /native reset failed/); await settle();
  assert.equal(h.saved().userId, 'cafe-a'); assert.ok(!h.rows.has('late_refresh'));
  fails = false; h.account(null, false); await h.controller.confirmedDeletion('cafe-a'); assert.equal(h.saved(), null); stop();
});

function adapter({ platform = 'android', flag = 'true', environment = isolated, device = false, sessionRead, nativeError, invalidateError, expoError, storageError, initialUser = 'cafe-a', initialResponse = null, responseRead, pushRoute } = {}) {
  let user = initialUser, responseCallback, tokenCallback;
  const calls = [], routes = [], storage = new Map(), authCallbacks = [];
  const notifications = {
    AndroidImportance: { HIGH: 4 }, IosAuthorizationStatus: { PROVISIONAL: 3 },
    setNotificationHandler() {}, async setNotificationChannelAsync() { calls.push('channel'); },
    async getPermissionsAsync() { return { granted: true, canAskAgain: true }; }, async requestPermissionsAsync() { return { granted: true, canAskAgain: true }; },
    async getDevicePushTokenAsync() { calls.push('native'); if (nativeError) throw new Error(nativeError); return native('native_adapter_token'); },
    async unregisterForNotificationsAsync() { calls.push('native-unregister'); if (invalidateError) throw new Error(invalidateError); },
    async setAutoServerRegistrationEnabledAsync(enabled) { calls.push(['expo-auto', enabled]); },
    async getExpoPushTokenAsync() { calls.push('expo'); if (expoError) throw new Error(expoError); return { data: 'ExponentPushToken[synthetic]' }; },
    addPushTokenListener(callback) { tokenCallback = callback; return { remove() { calls.push('token-stop'); tokenCallback = null; } }; },
    async getLastNotificationResponseAsync() { return responseRead ? responseRead() : initialResponse; },
    addNotificationResponseReceivedListener(callback) { responseCallback = callback; return { remove() { calls.push('response-stop'); } }; },
    async clearLastNotificationResponseAsync() { calls.push('clear-response'); },
  };
  const supabase = {
    auth: { async getSession() { return sessionRead ? sessionRead() : { data: { session: user ? { user: { id: user } } : null } }; },
      onAuthStateChange(callback) { authCallbacks.push(callback); return { data: { subscription: { unsubscribe() { calls.push('auth-stop'); } } } }; } },
    from(table) { return {
      async upsert(row, options) { calls.push(['upsert', table, plain(row), plain(options)]); return {}; },
      delete() { const filters = []; const query = { eq(name, value) { filters.push([name, value]); return query; }, then(resolve) { calls.push(['delete', table, filters]); return Promise.resolve({}).then(resolve); } }; return query; },
    }; },
  };
  const routing = loadTypescript('mobile/lib/notificationRouting.ts');
  const push = loadTypescript('mobile/lib/pushNotifications.ts', {
    'react-native': { Platform: { OS: platform } }, '@react-native-async-storage/async-storage': { default: {
      async getItem(k) { if (storageError) throw new Error(storageError); return storage.get(k) || null; }, async setItem(k, value) { storage.set(k, value); }, async removeItem(k) { storage.delete(k); },
    } }, 'expo-constants': { default: { easConfig: { projectId: 'synthetic-expo-project' } } },
    'expo-device': { isDevice: device }, 'expo-notifications': notifications, 'expo-router': { router: { push: route => { pushRoute?.(route); routes.push(route); } } },
    './supabase': { supabase }, './notificationRouting': routing, './androidFcmRegistration': module,
    '../features/review-mode/environment': { getAppEnvironment: () => environment },
  }, { process: { env: { EXPO_PUBLIC_ANDROID_DIRECT_FCM_ENABLED: flag, EXPO_PUBLIC_ANDROID_TEST_SUPABASE_PUBLISHABLE_KEY: key } } });
  return { push, calls, routes, storage, token: token => tokenCallback?.(token), account(id, event = id ? 'SIGNED_IN' : 'SIGNED_OUT') { user = id; authCallbacks.forEach(callback => callback(event, id ? { user: { id } } : null)); },
    response(data, id = 'notification-one') { responseCallback({ actionIdentifier: 'default', notification: { request: { identifier: id, content: { data } } } }); } };
}

test('actual isolated Android adapter permits the Play-services emulator, writes only FCM and cleans up owned rows', async () => {
  const h = adapter(), stop = h.push.listenForPhoneNotifications();
  assert.equal((await h.push.registerForPhoneNotifications()).status, 'enabled');
  const write = h.calls.find(call => Array.isArray(call) && call[0] === 'upsert');
  assert.equal(write[1], 'android_device_push_tokens');
  assert.deepEqual(write[2], { fcm_token: 'native_adapter_token', user_id: 'cafe-a', platform: 'android', firebase_project_id: 'baristamatch', package_name: 'com.baristajobmatch.app', enabled: true });
  assert.deepEqual(write[3], { onConflict: 'fcm_token' }); assert.ok(!h.calls.includes('expo'));
  assert.ok(h.calls.findIndex(call => Array.isArray(call) && call[0] === 'expo-auto' && call[1] === false) < h.calls.indexOf('native'));
  await h.push.unregisterThisDeviceNotifications('cafe-a');
  assert.ok(h.calls.some(call => Array.isArray(call) && call[0] === 'delete' && call[1] === 'android_device_push_tokens'
    && JSON.stringify(call[2]) === JSON.stringify([['fcm_token', 'native_adapter_token'], ['user_id', 'cafe-a']])));
  assert.ok(h.calls.includes('native-unregister')); assert.equal(h.storage.size, 0); stop();
  assert.ok(h.calls.includes('token-stop'));
});

test('iOS Expo token registration/cache/logout and notification routing remain unchanged', async () => {
  const h = adapter({ platform: 'ios', device: true }), stop = h.push.listenForPhoneNotifications();
  assert.equal((await h.push.registerForPhoneNotifications()).status, 'enabled');
  assert.ok(h.calls.includes('expo')); assert.ok(!h.calls.includes('native'));
  assert.ok(!h.calls.some(call => Array.isArray(call) && call[0] === 'expo-auto'));
  assert.equal(h.calls.find(call => Array.isArray(call) && call[0] === 'upsert')[1], 'device_push_tokens');
  assert.ok(h.storage.has('baristamatch_phone_token_v1')); assert.ok(!h.storage.has(module.ANDROID_FCM_TOKEN_KEY));
  h.response({ route: '/messages' }); await settle(); assert.deepEqual(h.routes, ['/messages']);
  await h.push.unregisterThisDeviceNotifications('cafe-a');
  assert.equal(h.storage.size, 0); assert.ok(!h.calls.includes('native-unregister')); stop(); assert.ok(!h.calls.includes('token-stop'));
});

test('missing direct flag retains the existing emulator restriction, while bad enabled scope never falls back to Expo', async () => {
  const off = adapter({ flag: 'false' }); assert.equal((await off.push.registerForPhoneNotifications()).status, 'unavailable'); assert.deepEqual(off.calls, []);
  const wrong = adapter({ environment: { ...isolated, review: false }, device: true });
  await assert.rejects(wrong.push.registerForPhoneNotifications(), /Android notifications could not be enabled/); assert.ok(!wrong.calls.includes('expo'));
});

test('direct FCM native-decoded body data opens only for the current recipient and ignores missing/foreign identity', async () => {
  const h = adapter(), stop = h.push.listenForPhoneNotifications();
  h.response({ route: '/messages' }, 'missing'); await settle();
  h.response({ route: '/messages', recipientUserId: 'barista-b' }, 'foreign'); await settle();
  assert.deepEqual(h.routes, []);
  const wireData = { body: JSON.stringify({ route: '/messages', type: 'message', recipientUserId: 'cafe-a' }) };
  h.response(JSON.parse(wireData.body), 'owned'); await settle(); assert.deepEqual(h.routes, ['/messages']);
  h.response(JSON.parse(wireData.body), 'owned'); await settle(); assert.deepEqual(h.routes, ['/messages']); stop();
});

test('direct notification navigation rechecks session after asynchronous ownership lookup', async () => {
  const gate = deferred(); let reads = 0;
  const h = adapter({ sessionRead: async () => ++reads === 1 ? gate.promise : { data: { session: { user: { id: 'barista-b' } } } } });
  const stop = h.push.listenForPhoneNotifications();
  h.response({ route: '/messages', recipientUserId: 'cafe-a' });
  gate.resolve({ data: { session: { user: { id: 'cafe-a' } } } }); await settle(); assert.deepEqual(h.routes, []); stop();
});

const tap = (recipientUserId = 'cafe-a', id = 'cold-notification') => ({ actionIdentifier: 'default',
  notification: { request: { identifier: id, content: { data: { route: '/messages', type: 'message', recipientUserId } } } } });

test('restored Android cold tap waits for the startup home redirect, then routes and consumes once', async () => {
  let ready = false, screen = '/';
  const h = adapter({ initialResponse: tap(), pushRoute: route => { screen = route; } });
  const stop = h.push.listenForPhoneNotifications({ isNavigationReady: () => ready });
  await settle(); assert.equal(screen, '/'); assert.deepEqual(h.routes, []); assert.ok(!h.calls.includes('clear-response'));
  // Index has now finished its account lookup and accepted the home redirect.
  screen = '/home'; ready = true; stop.retryPending(); await settle();
  assert.equal(screen, '/messages'); assert.deepEqual(h.routes, ['/messages']);
  assert.equal(h.calls.filter(call => call === 'clear-response').length, 1);
  stop.retryPending(); h.response(tap().notification.request.content.data, 'cold-notification'); await settle();
  assert.deepEqual(h.routes, ['/messages']); stop();
});

test('Android pending signed-out cold tap retries on INITIAL_SESSION without needing another SIGNED_IN', async () => {
  const h = adapter({ initialUser: null, initialResponse: tap() }), stop = h.push.listenForPhoneNotifications();
  await settle(); assert.deepEqual(h.routes, []);
  h.account('cafe-a', 'INITIAL_SESSION'); await settle(); assert.deepEqual(h.routes, ['/messages']);
  h.account('cafe-a', 'INITIAL_SESSION'); await settle(); assert.deepEqual(h.routes, ['/messages']); stop();
});

test('pending cold tap cannot route after a different account finishes startup or signs in', async () => {
  let ready = false;
  const h = adapter({ initialUser: null, initialResponse: tap() });
  const stop = h.push.listenForPhoneNotifications({ isNavigationReady: () => ready });
  await settle(); h.account('barista-b'); await settle();
  ready = true; stop.retryPending(); await settle(); assert.deepEqual(h.routes, []);
  h.account('cafe-a'); stop.retryPending(); await settle(); assert.deepEqual(h.routes, []); stop();
});

test('navigation becoming unready during session lookup retains the response for a fresh guarded retry', async () => {
  const gate = deferred(); let ready = true, reads = 0;
  const h = adapter({ initialResponse: tap(), sessionRead: async () => ++reads === 2 ? gate.promise
    : { data: { session: { user: { id: 'cafe-a' } } } } });
  const stop = h.push.listenForPhoneNotifications({ isNavigationReady: () => ready });
  await settle(); ready = false; gate.resolve({ data: { session: { user: { id: 'cafe-a' } } } }); await settle();
  assert.deepEqual(h.routes, []); assert.ok(!h.calls.includes('clear-response'));
  ready = true; stop.retryPending(); await settle(); assert.deepEqual(h.routes, ['/messages']); assert.ok(reads >= 4); stop();
});

test('concurrent Android readiness retries route a pending response only once', async () => {
  let ready = false;
  const h = adapter({ initialResponse: tap() }), stop = h.push.listenForPhoneNotifications({ isNavigationReady: () => ready });
  await settle(); ready = true; stop.retryPending(); stop.retryPending(); stop.retryPending(); await settle();
  assert.deepEqual(h.routes, ['/messages']); assert.equal(h.calls.filter(call => call === 'clear-response').length, 1); stop();
});

test('failed Android router intent retains the cold response instead of marking it handled or clearing it', async () => {
  let fails = true;
  const h = adapter({ initialResponse: tap(), pushRoute: () => { if (fails) throw new Error('root navigator not ready'); } });
  const stop = h.push.listenForPhoneNotifications(); await settle();
  assert.deepEqual(h.routes, []); assert.ok(!h.calls.includes('clear-response'));
  fails = false; stop.retryPending(); await settle(); assert.deepEqual(h.routes, ['/messages']); stop();
});

test('a live Android tap wins over a delayed old persisted response', async () => {
  const last = deferred(), h = adapter({ responseRead: () => last.promise }), stop = h.push.listenForPhoneNotifications();
  h.response({ route: '/matches', recipientUserId: 'cafe-a' }, 'new-tap'); await settle();
  last.resolve(tap()); await settle(); assert.deepEqual(h.routes, ['/matches']); stop();
});

test('an older ownership lookup cannot discard a newer pending Android tap', async () => {
  const older = deferred(), newer = deferred(); let reads = 0;
  const h = adapter({ sessionRead: async () => ++reads === 2 ? older.promise : reads === 3 ? newer.promise
    : { data: { session: { user: { id: 'cafe-a' } } } } });
  const stop = h.push.listenForPhoneNotifications();
  h.response({ route: '/messages', recipientUserId: 'cafe-a' }, 'older'); await settle();
  h.response({ route: '/matches', recipientUserId: 'cafe-a' }, 'newer'); await settle();
  older.resolve({ data: { session: { user: { id: 'cafe-a' } } } }); await settle();
  newer.resolve({ data: { session: { user: { id: 'cafe-a' } } } }); await settle();
  assert.deepEqual(h.routes, ['/matches']); stop();
});

test('disposed Android listener ignores delayed persisted and in-flight ownership responses', async () => {
  const last = deferred(), h = adapter({ responseRead: () => last.promise }), stop = h.push.listenForPhoneNotifications();
  stop(); last.resolve(tap()); stop.retryPending(); await settle(); assert.deepEqual(h.routes, []);
  const lookup = deferred(), second = adapter({ initialResponse: tap(), sessionRead: () => lookup.promise });
  const stopSecond = second.push.listenForPhoneNotifications(); await settle(); stopSecond();
  lookup.resolve({ data: { session: { user: { id: 'cafe-a' } } } }); await settle(); assert.deepEqual(second.routes, []);
});

test('iOS Expo cold-response timing and auth retry behavior ignore Android navigation readiness', async () => {
  const h = adapter({ platform: 'ios', device: true, initialResponse: tap() });
  const stop = h.push.listenForPhoneNotifications({ isNavigationReady: () => false });
  await settle(); assert.deepEqual(h.routes, ['/messages']); stop.retryPending(); await settle(); assert.deepEqual(h.routes, ['/messages']); stop();
  const guest = adapter({ platform: 'ios', device: true, initialUser: null, initialResponse: tap() });
  const stopGuest = guest.push.listenForPhoneNotifications({ isNavigationReady: () => false });
  await settle(); guest.account('cafe-a', 'INITIAL_SESSION'); await settle(); assert.deepEqual(guest.routes, []);
  guest.account('cafe-a'); await settle(); assert.deepEqual(guest.routes, ['/messages']); stopGuest();
});

test('malformed persisted cache invalidates old native delivery before replacement', async () => {
  const h = harness(); await h.controller.register();
  // Malformed persisted state triggers native invalidation before registering again.
  h.storage.set(module.ANDROID_FCM_TOKEN_KEY, 'malformed'); h.calls.length = 0;
  await h.controller.register(); assert.ok(h.calls.indexOf('invalidate') < h.calls.indexOf('native-token'));
});

test('storage read failure invalidates delivery, preserving the existing handle if native reset fails', async () => {
  const previous = { userId: 'cafe-a', token: 'native_old_token' };
  const h = harness({ saved: previous, read: async () => { throw new Error('storage unavailable'); },
    invalidate: async () => { throw new Error('native reset failed'); } });
  await assert.rejects(h.controller.register(), /native reset failed/);
  assert.deepEqual(h.saved(), previous); assert.deepEqual(h.calls, ['invalidate']); assert.equal(h.rows.size, 0);
});

test('Android review sign-in gives Google testing instructions while Apple wording stays byte-identical', () => {
  function copy(platform) {
    const react = { useState: value => [value, () => {}], useRef: current => ({ current }), useCallback: value => value, useEffect() {} };
    const native = { Platform: { OS: platform }, StyleSheet: { create: value => value }, View: 'View', Text: 'Text', ScrollView: 'ScrollView', Pressable: 'Pressable', ActivityIndicator: 'ActivityIndicator', Keyboard: {} };
    const jsx = (type, props) => ({ type, props });
    const loaded = loadTypescript('mobile/features/review-mode/ReviewLogin.tsx', {
      react, 'react/jsx-runtime': { jsx, jsxs: jsx }, 'react-native': native, 'expo-router': { router: {}, useFocusEffect() {} },
      '@/lib/supabase': { supabase: {} }, '@/lib/session': { getCurrentContext() {} },
      '@/components/ConversationKeyboardView': { ConversationKeyboardView: 'KeyboardView', ConversationTextInput: 'TextInput' },
    });
    const tree = loaded.default();
    const text = node => Array.isArray(node) ? node.map(text).join(' ') : typeof node === 'string' ? node : node && typeof node === 'object' ? text(node.props?.children) : '';
    return text(tree);
  }
  assert.match(copy('android'), /registered Google Play license tester and a test payment method/);
  assert.ok(!copy('android').includes('Apple confirms'));
  assert.ok(copy('ios').includes('Use the dedicated test account supplied for review. This session uses isolated test data. Purchases are available only when Apple confirms a Sandbox installation.'));
});


test('public Android registration and unregister errors never expose provider, token or storage details', async () => {
  const privateMessage = 'PRIVATE_FIXTURE_TOKEN_OR_PROVIDER_CONTENT';
  for (const options of [{ nativeError: privateMessage }, { storageError: privateMessage }]) {
    const h = adapter(options);
    await assert.rejects(h.push.registerForPhoneNotifications(), error => error.message === 'Android notifications could not be enabled. Please try again.');
  }
  const h = adapter({ invalidateError: privateMessage }); await h.push.registerForPhoneNotifications();
  await assert.rejects(h.push.unregisterThisDeviceNotifications('cafe-a'), error => error.message === 'Android notifications could not be removed. Please try again.');
  const ios = adapter({ platform: 'ios', device: true, expoError: privateMessage });
  await assert.rejects(ios.push.registerForPhoneNotifications(), error => error.message === privateMessage);
});

test('confirmed Android deletion always runs original auth cleanup, retaining native retry state on failure', async () => {
  for (const fails of [false, true]) {
    const h = adapter(fails ? { invalidateError: 'PRIVATE_FIXTURE_NATIVE_ERROR' } : {});
    await h.push.registerForPhoneNotifications(); h.account(null);
    const result = await h.push.clearAndroidNotificationsAfterDeletion('cafe-a', async () => { h.calls.push('auth-storage-cleanup'); return true; });
    assert.equal(result, true); assert.ok(h.calls.includes('native-unregister'));
    assert.ok(h.calls.indexOf('native-unregister') < h.calls.indexOf('auth-storage-cleanup'));
    assert.equal(h.storage.has(module.ANDROID_FCM_TOKEN_KEY), fails);
    assert.ok(!h.calls.some(call => Array.isArray(call) && call[0] === 'delete'));
  }
});

test('confirmed deletion never resets a replacement account and preserves original cleanup result/error', async () => {
  const h = adapter(); await h.push.registerForPhoneNotifications(); h.account('barista-b');
  assert.equal(await h.push.clearAndroidNotificationsAfterDeletion('cafe-a', async () => false), false);
  assert.ok(!h.calls.includes('native-unregister')); assert.ok(h.storage.has(module.ANDROID_FCM_TOKEN_KEY));
  await assert.rejects(h.push.clearAndroidNotificationsAfterDeletion('cafe-a', async () => { throw new Error('auth storage failed'); }), /auth storage failed/);
  const ios = adapter({ platform: 'ios', device: true });
  assert.equal(await ios.push.clearAndroidNotificationsAfterDeletion('cafe-a', async () => true), true);
  assert.deepEqual(ios.calls, []);
});


test('signed-out startup invalidates native delivery even when persisted-cache reads fail', async () => {
  for (const entry of ['register', 'listen', 'unregister']) {
    const h = harness({ user: null, saved: { userId: 'cafe-a', token: 'synthetic_fcm_a' }, read: async () => { throw new Error('storage read failed'); } });
    if (entry === 'listen') { const stop = h.controller.listen(); await settle(); stop(); }
    else await h.controller[entry]();
    assert.ok(h.calls.includes('invalidate')); assert.equal(h.saved(), null);
  }
});

test('post-fetch cleanup-handle persistence failure invalidates native delivery before any database write', async () => {
  for (const fails of [false, true]) {
    let failStorage = true, failReset = fails;
    const h = harness({ user: 'barista-b', write: async () => { if (failStorage) throw new Error('storage write failed'); },
      invalidate: async () => { if (failReset) throw new Error('native reset failed'); } });
    h.rows.set('synthetic_fcm_a', 'cafe-a');
    await assert.rejects(h.controller.register(), fails ? /native reset failed/ : /storage write failed/);
    assert.ok(h.calls.includes('invalidate')); assert.equal(h.rows.size, 1);
    assert.ok(!h.calls.some(call => Array.isArray(call) && call[0] === 'save'));
    failStorage = false; failReset = false; await h.controller.register();
    assert.equal(h.rows.get('synthetic_fcm_after_reset'), 'barista-b');
  }
});

test('skipped old-account deletion leaves a registered replacement account able to refresh', async () => {
  const h = harness({ user: 'barista-b' }), stop = h.controller.listen(); await h.controller.register();
  await h.controller.confirmedDeletion('cafe-a'); h.refresh(native('synthetic_b_rotated')); await settle();
  assert.equal(h.rows.get('synthetic_b_rotated'), 'barista-b'); assert.equal(h.saved().token, 'synthetic_b_rotated');
  assert.ok(!h.calls.includes('invalidate')); stop();
});


test('signed-in unreadable cache invalidates a prior-owner native token and preserves failed-reset retries', async () => {
  for (const fails of [false, true]) {
    let failRead = true, failReset = fails;
    const h = harness({ user: 'barista-b', saved: { userId: 'cafe-a', token: 'synthetic_fcm_a' },
      read: async () => { if (failRead) throw new Error('storage read failed'); },
      invalidate: async () => { if (failReset) throw new Error('native reset failed'); } });
    h.rows.set('synthetic_fcm_a', 'cafe-a');
    await assert.rejects(h.controller.register(), fails ? /native reset failed/ : /storage read failed/);
    assert.ok(h.calls.includes('invalidate')); assert.ok(!h.calls.includes('native-token'));
    assert.equal(h.rows.get('synthetic_fcm_a'), 'cafe-a');
    assert.equal(h.saved()?.userId || null, fails ? 'cafe-a' : null);
    assert.ok(!h.calls.some(call => Array.isArray(call) && ['save', 'remove'].includes(call[0])));
    failRead = false; failReset = false; h.calls.length = 0;
    await h.controller.register(); assert.equal(h.rows.get('synthetic_fcm_after_reset'), 'barista-b');
    if (fails) assert.ok(h.calls.indexOf('invalidate') < h.calls.indexOf('native-token'));
  }
});
