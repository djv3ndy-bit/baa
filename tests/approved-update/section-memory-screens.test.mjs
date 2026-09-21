import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTypescript } from './load-typescript.mjs';
const settle = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const files = { home: 'mobile/features/approved-dashboard/ApprovedHomeScreen.tsx', messages: 'mobile/app/messages.tsx', matches: 'mobile/app/matches.tsx', jobs: 'mobile/app/jobs.tsx', discover: 'mobile/app/discover.tsx', profile: 'mobile/app/profile.tsx' };
function fixture() {
 const { SectionMemoryStore } = loadTypescript('mobile/features/section-memory/store.ts'), store = new SectionMemoryStore(); store.setSession('test', 'a', Date.now() + 3600000);
 const f = { store, name: 'Saved record', role: 'cafe_owner_manager', userId: 'a', reads: 0, gate: null, fail: false, params: {} };
 f.wait = async () => { f.reads++; if (f.gate) await f.gate.promise; if (f.fail) throw new Error('Connection unavailable'); };
 f.profile = () => ({ id: f.userId, role: f.role, cafe_name: f.name, display_name: f.name, location: 'Miami, FL', skills: [], is_discoverable: true });
 f.job = () => ({ id: 'job', owner_id: f.userId, title: f.name, active: true, owner: { cafe_name: f.name } });
 return f;
}
function mount(name, f) {
 let inner = [], wrapper = [], cursor = 0, hooks = wrapper, key, cleanup, focusCallback, tree;
 const useMemo = (fn, deps) => { const i = cursor++; if (!hooks[i] || deps.some((d, j) => d !== hooks[i].deps[j])) hooks[i] = { deps, value: fn() }; return hooks[i].value; };
 const react = { useMemo, useCallback: (fn, deps) => useMemo(() => fn, deps), useSyncExternalStore: (_subscribe, snapshot) => snapshot(), useState(initial) { const i = cursor++, cells = hooks; if (!(i in cells)) cells[i] = typeof initial === 'function' ? initial() : initial; return [cells[i], v => { cells[i] = typeof v === 'function' ? v(cells[i]) : v; }]; }, useRef(initial) { const i = cursor++; return hooks[i] ||= { current: initial }; } };
 const jsx = (type, props, key) => ({ type, props: props || {}, key });
 const memory = loadTypescript('mobile/features/section-memory/useSectionMemory.tsx', { react, 'react/jsx-runtime': { jsx, jsxs: jsx }, './store': { sectionMemory: f.store } });
 const channel = { on() { return this; }, subscribe() { return this; } };
 const supabase = { auth: { onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }) }, channel: () => channel, removeChannel() {}, from(table) { return { table, select() { return this; }, eq() { return this; }, or() { return this; }, order() { return this; }, maybeSingle: async () => ({ data: {}, error: null }) }; } };
 const market = { formatJobPay: () => '$20/hr', JOB_FIELDS: '', loadApplications: async () => [], readAllRows: async fn => fn().table === 'jobs' ? [f.job()] : [{ id: 'match', cafe_id: 'a', barista_id: 'b' }], readProfiles: async () => ({ b: { display_name: f.name } }), loadMarketplace: async () => ({ jobs: [f.job()], candidates: [], applications: [], interests: [], matches: [], profiles: {} }), interestState: () => ({ disabled: false, label: 'Show interest' }), applicationStatus: s => s };
 const native = new Proxy({ StyleSheet: { create: v => v }, Platform: { OS: 'ios' }, AppState: { addEventListener: () => ({ remove() {} }) }, Alert: { alert() {} } }, { get: (o, p) => o[p] ?? p });
 const session = { getCurrentContext: async () => { await f.wait(); return { user: { id: f.userId }, role: f.role, profile: f.profile() }; }, requireCurrentUser: async () => ({ id: f.userId }) };
 const mocks = {
  react, 'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'Fragment' }, 'react-native': native, 'react-native-safe-area-context': { SafeAreaView: 'SafeAreaView' },
  'expo-router': { router: { replace() {}, push() {}, navigate() {}, back() {} }, useFocusEffect: cb => { focusCallback = cb; }, useLocalSearchParams: () => f.params },
  '@/features/section-memory/useSectionMemory': memory, '@/lib/dashboardPrism': { dashboardPrism: {}, prismPanel: {} }, '@/components/AppBottomNav': { AppBottomNav: 'AppBottomNav' },
  '@/lib/supabase': { supabase }, '../../lib/supabase': { supabase }, '@/lib/session': session, '../../lib/session': session,
  '@/lib/marketplace': market, '@/lib/discovery': {}, '@/lib/floridaLocation': { workAreaLabel: () => 'Miami', floridaCityFromLocation: s => s || '' },
  '@/lib/profilePrivacy': { getProfileReadiness: () => ({ complete: true, missing: [] }) }, 'expo-image-picker': {},
  '@/lib/messaging': { LatestMessageRequest: class { version = 0; begin() { const v = ++this.version; return () => v === this.version; } invalidate() { this.version++; } }, withMessageDeadline: p => p, messageError: () => 'Messages could not load. Please try again.', loadConversations: async () => [{ id: 'conversation', kind: 'application', name: f.name, unread: 0 }] },
  './loadDashboard': { DashboardSessionError: class extends Error {}, loadDashboard: async () => { await f.wait(); return { accountId: f.userId, role: f.role, marker: f.name }; } },
  './model': { safeDashboardError: () => 'Could not refresh' }, './ApprovedDashboard': { ApprovedDashboard: 'ApprovedDashboard' }, './DashboardPrimitives': { Action: 'Action' }, './theme': { dashboardTheme: {} },
 };
 const Wrapper = loadTypescript(files[name], mocks).default;
 function render() { hooks = wrapper; cursor = 0; const root = Wrapper(); if (root.key !== key) { cleanup?.(); inner = []; key = root.key; } hooks = inner; cursor = 0; tree = root.type(); return tree; }
 const nodes = () => { const result = []; const visit = n => { if (Array.isArray(n)) return n.forEach(visit); if (!n || typeof n !== 'object') return; result.push(n); visit(n.props?.children); }; visit(tree); return result; };
 const text = n => Array.isArray(n) ? n.map(text).join(' ') : n && typeof n === 'object' ? [text(n.props?.children), n.type === 'ApprovedDashboard' ? [n.props.data.marker, n.props.error].join(' ') : ''].join(' ') : typeof n === 'string' || typeof n === 'number' ? String(n) : '';
 render(); return { render, nodes, text: () => text(tree), focus() { cleanup = focusCallback(); }, blur() { cleanup?.(); }, spinner: () => nodes().some(n => n.type === 'ActivityIndicator'), button(label) { return nodes().find(n => n.type === 'Pressable' && text(n).trim() === label); }, get tree() { return tree; } };
}
for (const name of Object.keys(files)) {
 test(`${name}: first load waits; returning immediately shows saved data and replaces it after refresh`, async () => {
  const f = fixture(), first = mount(name, f); assert.equal(first.spinner(), true); first.focus(); await settle(); first.render(); assert.equal(first.spinner(), false);
  // Café discovery has no candidates in this fixture; its saved state is still a loaded empty result.
  if (name !== 'discover') assert.match(first.text(), /Saved record/);
  first.blur(); const gate = deferred(); f.gate = gate; const warm = mount(name, f); assert.equal(warm.spinner(), false); warm.focus(); warm.render(); assert.equal(warm.spinner(), false); assert.equal(f.reads, 2);
  if (name === 'home') assert.equal(warm.tree.props.refreshing, false);
  if (name === 'messages') assert.equal(warm.nodes().find(n => n.type === 'ScrollView').props.refreshControl.props.refreshing, false);
  f.name = 'Updated record'; gate.resolve(); await settle(); warm.render(); if (name !== 'discover') assert.match(warm.text(), /Updated record/); warm.blur();
 });
 test(`${name}: a failed refresh is visible and does not save a false success`, async () => {
  const f = fixture(), first = mount(name, f); first.focus(); await settle(); first.render(); first.blur(); f.fail = true;
  const warm = mount(name, f); warm.focus(); await settle(); warm.render(); assert.equal(warm.spinner(), false); assert.match(warm.text(), /could not|unavailable|Could not/i); warm.blur();
  // Home intentionally retains its last good dashboard with a retry notice.
  if (name !== 'home') assert.equal(mount(name, f).spinner(), true);
 });
}
test('account changes remount private content and discard an old request', async () => {
 const f = fixture(), ui = mount('messages', f); ui.focus(); await settle(); ui.render(); assert.match(ui.text(), /Saved record/);
 f.store.setSession('test', 'b', Date.now() + 3600000); f.userId = 'b'; f.gate = deferred(); ui.render(); ui.focus(); assert.equal(ui.spinner(), true); assert.doesNotMatch(ui.text(), /Saved record/);
 f.name = 'Other account'; f.gate.resolve(); await settle(); ui.render(); assert.match(ui.text(), /Other account/); ui.blur();
});
test('job-filter changes remount the screen instead of displaying another job’s saved matches', async () => {
 const f = fixture(), ui = mount('matches', f); ui.focus(); await settle(); ui.render(); assert.match(ui.text(), /Saved record/);
 f.params = { jobId: 'unseen-job' }; f.gate = deferred(); ui.render(); ui.focus(); assert.equal(ui.spinner(), true); assert.doesNotMatch(ui.text(), /Saved record/);
 f.gate.resolve(); await settle(); ui.render(); assert.match(ui.text(), /No matches yet/); ui.blur();
});
test('editing a saved profile does not allow its background refresh to overwrite the draft', async () => {
 const f = fixture(), first = mount('profile', f); first.focus(); await settle(); first.render(); first.blur(); f.gate = deferred();
 const warm = mount('profile', f); warm.focus(); warm.button('Edit profile').props.onPress(); warm.render();
 f.name = 'Background update'; f.gate.resolve(); await settle(); warm.render(); assert.match(warm.text(), /Cancel/); assert.doesNotMatch(warm.text(), /Background update/);
 assert.equal(f.store.read(f.store.lease(), 'profile').profile.cafe_name, 'Saved record'); warm.blur();
});
test('leaving an unsaved profile edit cannot replace the saved snapshot on the next visit', async () => {
 const f = fixture(), ui = mount('profile', f); ui.focus(); await settle(); ui.render(); ui.button('Edit profile').props.onPress(); ui.render();
 const field = ui.nodes().find(node => node.props?.label === 'Café name'); assert.ok(field); field.props.onChange('Unsaved draft'); ui.render(); ui.blur();
 assert.equal(f.store.read(f.store.lease(), 'profile').profile.cafe_name, 'Saved record');
 const next = mount('profile', f); assert.match(next.text(), /Saved record/); assert.doesNotMatch(next.text(), /Unsaved draft/);
});
