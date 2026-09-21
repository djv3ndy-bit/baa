import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTypescript, plain } from './load-typescript.mjs';
const { SectionMemoryStore } = loadTypescript('mobile/features/section-memory/store.ts');
const { createSectionMemorySession } = loadTypescript('mobile/features/section-memory/session.ts', { './store': { sectionMemory: new SectionMemoryStore() } });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function fixture(options = {}) { let clock = 1000; const store = new SectionMemoryStore(() => clock, options.ttl ?? 300000, options.maxEntries ?? 12, options.maxCharacters ?? 2000000); store.setSession('production', 'a', 900000); return { store, tick: n => clock += n, lease: store.lease() }; }
test('only a successful account-scoped snapshot is reused, with independent copies', () => {
 const { store, lease } = fixture(), data = { name: 'Saved', skills: ['Coffee'] };
 assert.equal(store.read(lease, 'profile'), undefined);
 assert.equal(store.save(lease, 'profile', 'a', 'barista', data), true);
 data.skills.push('Unsaved'); const draft = store.read(lease, 'profile'); draft.name = 'Draft'; draft.skills.push('New');
 assert.deepEqual(plain(store.read(lease, 'profile')), { name: 'Saved', skills: ['Coffee'] });
});
for (const [name, transition] of [
 ['sign-out', s => s.setSession('production', null)],
 ['another account', s => s.setSession('production', 'b', 900000)],
 ['test environment', s => s.setSession('sandbox', 'a', 900000)],
 ['same account after logout', s => { s.setSession('production', null); s.setSession('production', 'a', 900000); }],
]) test(`${name} clears data and rejects a late request from the previous session`, () => {
 const { store, lease } = fixture(); let notifications = 0; store.subscribe(() => notifications++);
 store.save(lease, 'messages', 'a', 'barista', ['private']); transition(store);
 assert.equal(store.read(store.lease(), 'messages'), undefined); assert.equal(store.current(lease), false);
 assert.equal(store.save(lease, 'messages', 'a', 'barista', ['late']), false); assert.ok(notifications);
});
test('token refresh for the same account keeps screens; expired sessions cannot read or write snapshots', () => {
 const { store, lease } = fixture(); store.save(lease, 'home', 'a', 'barista', []);
 store.setSession('production', 'a', 900001); assert.equal(store.current(lease), true); assert.deepEqual(plain(store.read(lease, 'home')), []);
 store.setSession('production', 'a', 1000); assert.equal(store.read(lease, 'home'), undefined); assert.equal(store.save(lease, 'home', 'a', 'barista', []), false);
});
test('five-minute expiry, bounded size, and separate filtered lists', () => {
 const { store, lease, tick } = fixture({ maxEntries: 2 });
 for (const key of ['matches', 'matches:job-a']) store.save(lease, key, 'a', 'barista', key);
 assert.equal(store.read(lease, 'matches:job-b'), undefined);
 store.save(lease, 'profile', 'a', 'barista', 'profile'); assert.equal(store.read(lease, 'matches'), undefined);
 tick(300000); assert.equal(store.read(lease, 'profile'), undefined);
 const bounded = fixture({ maxCharacters: 10 }); bounded.store.save(bounded.lease, 'x', 'a', 'barista', '12345'); bounded.store.save(bounded.lease, 'y', 'a', 'barista', '12345');
 assert.equal(bounded.store.read(bounded.lease, 'x'), undefined);
 assert.equal(bounded.store.save(bounded.lease, 'z', 'a', 'barista', '12345678901'), false);
});
test('role change invalidates every screen before accepting the new role; mismatched owners cannot write', () => {
 const { store, lease } = fixture(); store.save(lease, 'home', 'a', 'barista', {});
 assert.equal(store.save(lease, 'jobs', 'b', 'cafe_owner_manager', {}), false);
 assert.equal(store.save(lease, 'jobs', 'a', 'cafe_owner_manager', {}), false); assert.equal(store.read(store.lease(), 'home'), undefined);
 assert.equal(store.save(store.lease(), 'jobs', 'a', 'cafe_owner_manager', {}), true);
});
test('failed snapshots and explicit invalidation are recoverable', () => {
 const { store, lease } = fixture(); const circular = {}; circular.self = circular;
 assert.equal(store.save(lease, 'home', 'a', 'barista', circular), false);
 store.save(lease, 'home', 'a', 'barista', {}); store.forget(lease, 'home'); assert.equal(store.read(lease, 'home'), undefined);
 assert.equal(store.save(lease, 'home', 'a', 'barista', {}), true);
});
function client(pending) { let callback, stopped = 0, calls = 0; return { auth: { getSession: () => { calls++; return pending.promise; }, onAuthStateChange: cb => { callback = cb; return { data: { subscription: { unsubscribe: () => stopped++ } } }; } }, emit: session => callback('CHANGE', session), get stopped() { return stopped; }, get calls() { return calls; } }; }
const session = id => ({ user: { id }, expires_at: 1000 });
test('initialization is shared and auth events win over a stale initial read', async () => {
 const { store } = fixture(), initialize = createSectionMemorySession(store), pending = deferred(), auth = client(pending);
 const first = initialize(auth, 'production'); assert.equal(initialize(auth, 'production'), first); assert.equal(auth.calls, 1);
 auth.emit(session('b')); pending.resolve({ data: { session: session('a') }, error: null }); await first;
 assert.equal(store.lease().accountId, 'b'); auth.emit(null); assert.equal(store.lease().accountId, null);
});
test('switching environments ignores an old client event and pending request', async () => {
 const { store } = fixture(), initialize = createSectionMemorySession(store), p = deferred(), q = deferred(), old = client(p), next = client(q);
 const a = initialize(old, 'production'), b = initialize(next, 'sandbox'); old.emit(session('wrong'));
 p.resolve({ data: { session: session('wrong') }, error: null }); q.resolve({ data: { session: session('right') }, error: null }); await Promise.all([a, b]);
 assert.equal(old.stopped, 1); assert.equal(store.lease().scope, 'sandbox'); assert.equal(store.lease().accountId, 'right');
});
test('failed initial session read does not block the app; a later sign-in enables display memory', async () => {
 const { store } = fixture(), initialize = createSectionMemorySession(store), pending = deferred(), auth = client(pending);
 const first = initialize(auth, 'production'); pending.reject(new Error('offline')); await first;
 assert.equal(store.lease().accountId, null); assert.equal(auth.stopped, 0);
 auth.emit(session('a')); assert.equal(store.lease().accountId, 'a');
});
test('an error from an old initial read does not clear a newer authenticated session', async () => {
 const { store } = fixture(), initialize = createSectionMemorySession(store), pending = deferred(), auth = client(pending);
 const first = initialize(auth, 'production'); auth.emit(session('b')); pending.reject(new Error('stale failure')); await first;
 assert.equal(store.lease().accountId, 'b');
});
test('optional display-memory initialization cannot hold the app behind its startup gate', async () => {
 let values = [], cursor = 0, effect, initialized = 0;
 const react = { useState(initial) { const i = cursor++; if (!(i in values)) values[i] = initial; return [values[i], v => { values[i] = v; }]; }, useEffect: fn => { effect = fn; } };
 const jsx = (type, props) => ({ type, props });
 const { AppEnvironmentGate } = loadTypescript('mobile/features/review-mode/AppEnvironmentGate.tsx', {
  react, 'react/jsx-runtime': { jsx, jsxs: jsx }, 'react-native': { StyleSheet: { create: v => v }, View: 'View', Text: 'Text', ActivityIndicator: 'ActivityIndicator' },
  '@/lib/supabase': { initializeSupabaseEnvironment: async () => {}, supabase: {}, AUTH_STORAGE_KEY: 'test' },
  '@/features/section-memory/session': { initializeSectionMemory: () => { initialized++; return new Promise(() => {}); } },
 });
 AppEnvironmentGate({ children: 'APP' }); const cleanup = effect(); await Promise.resolve(); await Promise.resolve(); cursor = 0;
 assert.equal(AppEnvironmentGate({ children: 'APP' }), 'APP'); assert.equal(initialized, 1); cleanup();
});
