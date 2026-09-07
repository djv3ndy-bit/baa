import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(new URL('../mobile/package.json', import.meta.url));
const ts = require('typescript');
const clean = value => JSON.parse(JSON.stringify(value));
const settle = async () => { for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve)); };
const deferred = () => { let resolve; return { promise: new Promise(done => resolve = done), resolve: value => resolve(value) }; };
function clientFor(handler) {
  const calls = [];
  const client = { auth: { getSession: async () => ({ data: { session: { user: { id: 'self' }, access_token: 'mock' } } }) }, from(table) {
    const call = { table, operation: 'select', filters: [], orders: [] };
    const run = async kind => { calls.push({ ...call, kind }); const result = await handler(call, kind); return kind === 'range' && Array.isArray(result.data) ? { ...result, data: result.data.slice(call.range[0], call.range[1] + 1) } : result; };
    const q = { select(fields) { call.fields = fields; return q; }, insert(payload) { call.operation = 'insert'; call.payload = payload; return q; }, update(payload) { call.operation = 'update'; call.payload = payload; return q; }, eq(key, value) { call.filters.push(['eq', key, value]); return q; }, neq(key, value) { call.filters.push(['neq', key, value]); return q; }, in(key, value) { call.filters.push(['in', key, value]); return q; }, or(value) { call.or = value; return q; }, order(key) { call.orders.push(key); return q; }, range(from, to) { call.range = [from, to]; return run('range'); }, maybeSingle() { return run('maybeSingle'); }, single() { return run('single'); }, then(resolve, reject) { return run('await').then(resolve, reject); } };
    return q;
  } };
  return { client, calls };
}
function sourceLoader({ client = clientFor(() => ({ data: [] })).client, api = async () => ({}), context = async () => ({}), react, native = {}, params = {}, routes = [], focus } = {}) {
  const modules = new Map();
  const jsx = (type, props) => ({ type, props: props || {} });
  function load(file) {
    file = resolve(root, file);
    if (modules.has(file)) return modules.get(file).exports;
    const module = { exports: {} }; modules.set(file, module);
    const source = readFileSync(file, 'utf8');
    const output = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
    function localRequire(name) {
      if (name === 'react') return react;
      if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx, Fragment: 'Fragment' };
      if (name === 'react-native') return native;
      if (name === 'expo-router') return { useFocusEffect: callback => focus(callback), useLocalSearchParams: () => params, router: { push: route => routes.push(route), replace: route => routes.push(route), back: () => routes.push('back') } };
      if (name.endsWith('/supabase') || name === './supabase') return { supabase: client };
      if (name.endsWith('/api') || name === './api') return { authenticatedApi: api };
      if (name.endsWith('/session') || name === './session') return { getCurrentContext: context };
      if (name.endsWith('/AppBottomNav')) return { AppBottomNav: () => null };
      if (name.startsWith('@/')) return load(`mobile/${name.slice(2)}.ts`);
      if (name.startsWith('./')) return load(resolve(dirname(file), `${name}.ts`));
      throw new Error(`Unexpected module ${name}`);
    }
    vm.runInNewContext(output, { module, exports: module.exports, require: localRequire, console, Date, Set, Map, Promise, Error }, { filename: file });
    return module.exports;
  }
  return load;
}
function screen(file, options = {}) {
  const hooks = []; let index = 0, focusCallback, cleanup; const routes = [], alerts = [];
  const react = { useState(initial) { const key = index++; if (!(key in hooks)) hooks[key] = typeof initial === 'function' ? initial() : initial; return [hooks[key], value => { hooks[key] = typeof value === 'function' ? value(hooks[key]) : value; }]; }, useRef(initial) { const key = index++; if (!(key in hooks)) hooks[key] = { current: initial }; return hooks[key]; }, useCallback: callback => callback };
  const native = { StyleSheet: { create: value => value }, Platform: { OS: 'ios' }, Alert: { alert: (...args) => alerts.push(args) } };
  for (const name of ['View', 'Text', 'Pressable', 'Image', 'ScrollView', 'SafeAreaView', 'TextInput', 'ActivityIndicator', 'KeyboardAvoidingView']) native[name] = name;
  const load = sourceLoader({ ...options, react, native, routes, focus: callback => { focusCallback = callback; } });
  const Component = load(file).default;
  const expand = node => Array.isArray(node) ? node.map(expand) : !node || typeof node !== 'object' ? node : typeof node.type === 'function' ? expand(node.type(node.props)) : { ...node, props: { ...node.props, children: expand(node.props.children) } };
  let tree;
  function render() { index = 0; tree = expand(Component()); return tree; }
  const text = node => Array.isArray(node) ? node.map(text).join(' ') : typeof node === 'string' || typeof node === 'number' ? String(node) : node && typeof node === 'object' ? text(node.props.children) : '';
  function all(type) { const out = []; function visit(node) { if (Array.isArray(node)) { node.forEach(visit); return; } if (node && typeof node === 'object') { if (node.type === type) out.push(node); visit(node.props.children); } } visit(tree); return out; }
  render();
  return { render, routes, alerts, text: () => text(tree), all, focus: () => { cleanup = focusCallback(); }, blur: () => cleanup?.(), press: label => { const button = all('Pressable').find(node => text(node).trim() === label); assert.ok(button, `button ${label} exists`); assert.ok(!button.props.disabled, `${label} enabled`); return button.props.onPress(); }, field: label => { const input = all('TextInput').find(node => node.props.accessibilityLabel === label); assert.ok(input, `field ${label} exists`); return input; } };
}
const readyCafe = { user: { id: 'self' }, role: 'cafe_owner_manager', profile: { id: 'self', role: 'cafe_owner_manager', location: 'Miami, FL', is_discoverable: true } };
const job = { id: 'job', owner_id: 'cafe', title: 'Lead Barista', location: 'Miami, FL 33101', city: 'Miami', state: 'FL', postal_code: '33101', address_line1: '12 Main Street', address_line2: 'Suite 2', pay_min: 20, pay_max: 25, schedule: 'Weekends', description: 'Complete role description', required_skills: ['Espresso', 'Latte art'], active: true };

test('native location matching uses exact city or ZIP and rejects shared-name cities', () => {
  const area = sourceLoader()('mobile/lib/floridaLocation.ts');
  assert.equal(area.jobMatchesWorkArea({ location: 'Miami, FL' }, { location: 'Miami Beach, FL' }), false);
  assert.equal(area.jobMatchesWorkArea({ location: 'West Palm Beach, FL' }, { location: 'Palm Beach, FL' }), false);
  assert.equal(area.jobMatchesWorkArea({ location: 'Miami, FL', preferred_city: 'Orlando', preferred_state: 'FL' }, { city: 'Orlando', state: 'FL' }), true);
  assert.equal(area.jobMatchesWorkArea({ location: 'Miami, FL', preferred_postal_code: '33101' }, { city: 'Miami', state: 'FL' }), false);
  assert.equal(area.jobMatchesWorkArea({ preferred_postal_code: '33101' }, job), true);
  assert.equal(area.jobMatchesWorkArea({ location: 'Miami, NY' }, job), false);
  assert.equal(area.candidateMatchesCafe({ location: 'Miami, FL', cafe_address: '12 Main Street Miami, FL 33101' }, { location: 'Orlando, FL', preferred_postal_code: '33101' }), true);
  assert.equal(area.candidateMatchesCafe({ location: 'Miami, FL' }, { location: 'Miami, FL', preferred_city: 'Orlando' }), false);
  assert.equal(area.workAreaLabel({ preferred_postal_code: '33101' }), 'ZIP 33101');
});
test('all pages are read before candidate geography, including profiles after the former 100 cap', async () => {
  const profiles = Array.from({ length: 230 }, (_, i) => ({ id: `person-${i}`, role: 'barista', location: i === 220 ? 'Miami, FL' : 'Orlando, FL', is_discoverable: true, visible_to_cafes: true }));
  const db = clientFor(call => {
    if (call.table !== 'profiles') return { data: [] };
    if (call.filters.some(row => row[0] === 'in')) return { data: [] };
    return { data: profiles };
  });
  const data = await sourceLoader(db)('mobile/lib/marketplace.ts').loadMarketplace('self', 'cafe_owner_manager', readyCafe.profile);
  assert.deepEqual(clean(data.candidates.map(row => row.id)), ['person-220']);
  assert.ok(db.calls.some(call => call.table === 'profiles' && call.range?.[0] === 200));
});
test('a failed later page fails loading instead of silently showing an incomplete market', async () => {
  const { readAllRows } = sourceLoader()('mobile/lib/marketplace.ts');
  await assert.rejects(readAllRows(() => ({ range: async from => from === 0 ? { data: Array(200).fill({ id: 'row' }) } : { error: new Error('offline') } })), /offline/);
});
test('incoming and sent interests remain loaded without any in-area jobs', async () => {
  const db = clientFor(call => ({ data: call.table === 'discovery_interests' ? [{ id: 'incoming', sender_id: 'far-cafe', target_id: 'self' }, { id: 'sent', sender_id: 'self', target_id: 'other-cafe' }] : call.table === 'profiles' ? [{ id: 'far-cafe', cafe_name: 'Far Cafe', location: 'Orlando, FL' }, { id: 'other-cafe', cafe_name: 'Other Cafe' }] : [] }));
  const market = sourceLoader(db)('mobile/lib/marketplace.ts');
  const data = await market.loadMarketplace('self', 'barista', { location: 'Miami, FL' });
  assert.equal(data.jobs.length, 0); assert.equal(data.interests.length, 2); assert.equal(data.profiles['far-cafe'].cafe_name, 'Far Cafe');
  assert.equal(market.interestState(data, 'self', 'far-cafe').label, 'Match back'); assert.equal(market.interestState(data, 'self', 'other-cafe').disabled, true);
});
test('per-job apply uses the application endpoint and recovers an already-saved request', async () => {
  let reads = 0, sends = 0;
  const db = clientFor(() => ({ data: ++reads === 1 ? null : { id: 'application', status: 'interested' } }));
  const market = sourceLoader({ ...db, api: async (...args) => { sends++; assert.deepEqual(clean(args), ['/apply-job', { job_id: 'job' }, 'POST', 'self']); throw new Error('response lost'); } })('mobile/lib/marketplace.ts');
  await market.applyToMarketplaceJob('job', 'self'); assert.equal(sends, 1);
  await market.applyToMarketplaceJob('job', 'self'); assert.equal(sends, 1);
  assert.ok(db.calls.every(call => call.table === 'applications'));
});
test('duplicate discovery inserts can finish a reciprocal match without update privileges', async () => {
  const db = clientFor((call, kind) => call.operation === 'insert' ? { error: { code: '23505' } } : { data: { id: kind === 'single' ? 'match' : 'reciprocal' } });
  const result = await sourceLoader(db)('mobile/lib/discovery.ts').sendDiscoveryInterest('self', 'target', 'barista');
  assert.equal(result.matchId, 'match'); assert.equal(result.matched, true); assert.ok(db.calls.every(call => call.operation !== 'update'));
});
test('discovery refuses a changed account before writing interest', async () => {
  const db = clientFor(() => ({ data: null }));
  await assert.rejects(sourceLoader(db)('mobile/lib/discovery.ts').sendDiscoveryInterest('old-account', 'target', 'barista'), /account changed/);
  assert.equal(db.calls.length, 0);
});
test('editing preserves pay range and omits active, id, and application history from updates', () => {
  const editor = sourceLoader()('mobile/lib/jobEditor.ts');
  const draft = editor.draftFromJob({ ...job, active: false });
  const payload = editor.jobPayload(draft, ['Custom retained shift'], 'self');
  assert.equal(payload.pay_max, 25); assert.equal(payload.pay_min, 20); assert.equal(payload.schedule, 'Custom retained shift');
  for (const key of ['id', 'active', 'applications']) assert.equal(key in payload, false);
  assert.throws(() => editor.jobPayload({ ...draft, postalCode: 'abc' }, ['Weekends'], 'self'), /ZIP/);
  assert.throws(() => editor.jobPayload({ ...draft, maximumPay: '19' }, ['Weekends'], 'self'), /Maximum/);
});
test('job editor blocks duplicate publishes before the account lookup resolves', async () => {
  const gate = deferred(); let pause = false, inserts = 0;
  const db = clientFor(call => { if (call.operation === 'insert') { inserts++; return { data: { id: 'new-job', active: true } }; } return { data: [] }; });
  const h = screen('mobile/app/post-job.tsx', { ...db, context: () => pause ? gate.promise : Promise.resolve(readyCafe) });
  h.focus(); await settle(); h.render();
  for (const [label, value] of [['Job title', 'Lead Barista'], ['Street address', '12 Main Street'], ['City', 'Miami'], ['ZIP code', '33101'], ['Minimum hourly pay', '20'], ['Description', 'A complete role']]) h.field(label).props.onChangeText(value);
  h.press('Full-time'); h.render(); pause = true;
  const publish = h.all('Pressable').find(node => node.props.accessibilityRole === 'button' && node.props.onPress && !node.props.accessibilityLabel && !node.props.disabled);
  assert.ok(publish); publish.props.onPress(); publish.props.onPress();
  assert.equal(inserts, 0); gate.resolve(readyCafe); await settle(); h.render();
  assert.equal(inserts, 1); assert.deepEqual(h.routes, ['/jobs']);
});
test('Discover shows a retriable load error instead of a false empty-market message and refreshes on focus', async () => {
  let attempts = 0;
  const db = clientFor(() => ({ data: [] }));
  const h = screen('mobile/app/discover.tsx', { ...db, context: async () => { attempts++; throw new Error('Profile lookup offline'); } });
  h.focus(); await settle(); h.render();
  assert.match(h.text(), /Results could not load/); assert.match(h.text(), /Profile lookup offline/); assert.doesNotMatch(h.text(), /No results in your saved area yet/);
  h.blur(); h.focus(); await settle(); assert.equal(attempts, 2);
});
test('requested-job deep links load full details even outside the saved search and apply to that job', async () => {
  const calls = [];
  const db = clientFor((call, kind) => {
    if (call.table === 'jobs') return { data: kind === 'maybeSingle' ? { ...job, city: 'Orlando', location: 'Orlando, FL 32801' } : [] };
    if (call.table === 'profiles') return { data: [{ id: 'cafe', cafe_name: 'Notification Cafe' }] };
    return { data: kind === 'maybeSingle' ? null : [] };
  });
  const h = screen('mobile/app/discover.tsx', { ...db, params: { jobId: 'job' }, context: async () => ({ user: { id: 'self' }, role: 'barista', profile: { id: 'self', location: 'Miami, FL', is_discoverable: true } }), api: async (...args) => calls.push(args) });
  h.focus(); await settle(); h.render();
  assert.match(h.text(), /Requested job/); assert.match(h.text(), /Complete role description/); assert.match(h.text(), /12 Main Street/); assert.match(h.text(), /Suite 2/); assert.match(h.text(), /Latte art/); assert.match(h.text(), /\$20–\$25/);
  h.press('Apply to this job'); await settle(); assert.equal(calls[0][0], '/apply-job'); assert.deepEqual(clean(calls[0][1]), { job_id: 'job' });
});

test('pagination follows actual server page lengths instead of assuming the requested limit', async () => {
  const { readAllRows } = sourceLoader()('mobile/lib/marketplace.ts');
  const records = Array.from({ length: 245 }, (_, id) => ({ id })), offsets = [];
  const rows = await readAllRows(() => ({ range: async from => { offsets.push(from); return { data: records.slice(from, from + 100) }; } }));
  assert.equal(rows.length, 245); assert.deepEqual(offsets, [0, 100, 200, 245]);
});

test('barista application history retains rows whose paused job is hidden by RLS', async () => {
  const db = clientFor(call => ({ data: call.fields.includes('jobs!applications_job_id_fkey!inner') ? [] : [{ id: 'application', job_id: 'paused-job', status: 'matched', barista_id: 'self', job: null }] }));
  const rows = await sourceLoader(db)('mobile/lib/marketplace.ts').loadApplications('self', 'barista');
  assert.equal(rows.length, 1); assert.equal(rows[0].status, 'matched'); assert.equal(rows[0].job, null);
});
test('Candidates keeps declined applications in history and checks pending status before changing a row', async () => {
  const application = { id: 'application', job_id: 'job', barista_id: 'barista', status: 'interested', job, barista: { id: 'barista', display_name: 'Alex', skills: ['Espresso'] } };
  const db = clientFor(call => ({ data: call.operation === 'update' ? { id: 'application', status: 'declined' } : [application] }));
  const h = screen('mobile/app/candidates.tsx', { ...db, context: async () => readyCafe });
  h.focus(); await settle(); h.render(); h.press('Decline');
  const confirm = h.alerts.at(-1)[2].find(button => button.text === 'Decline'); confirm.onPress(); await settle(); h.render();
  assert.match(h.text(), /You’re caught up/); h.press('History'); h.render(); assert.match(h.text(), /Alex/); assert.match(h.text(), /Not selected/);
  const update = db.calls.find(call => call.operation === 'update'); assert.ok(update.filters.some(filter => filter[1] === 'status' && filter[2] === 'interested')); assert.equal(update.kind, 'single');
});
test('job edit updates the existing ID, retains a paused status and pay range, and never reinserts it', async () => {
  const db = clientFor(call => ({ data: call.operation === 'update' ? { id: 'job', active: false } : { ...job, owner_id: 'self', active: false } }));
  const h = screen('mobile/app/post-job.tsx', { ...db, params: { jobId: 'job' }, context: async () => readyCafe });
  h.focus(); await settle(); h.render(); assert.equal(h.field('Maximum hourly pay (optional)').props.value, '25');
  h.field('Job title').props.onChangeText('Updated Barista'); h.render(); h.press('Save changes'); await settle();
  const writes = db.calls.filter(call => call.operation !== 'select'); assert.equal(writes.length, 1); assert.equal(writes[0].operation, 'update'); assert.equal(writes[0].payload.pay_max, 25); assert.equal('active' in writes[0].payload, false); assert.ok(writes[0].filters.some(row => row[1] === 'id' && row[2] === 'job'));
  assert.match(h.alerts.at(-1)[1], /remains paused/);
});
test('a stale Discover load cannot replace results after leaving and returning with a new saved area', async () => {
  const oldContext = deferred(); let call = 0;
  const db = clientFor(call => ({ data: call.table === 'jobs' ? [job, { ...job, id: 'orlando-job', title: 'Orlando role', city: 'Orlando', location: 'Orlando, FL' }] : [] }));
  const h = screen('mobile/app/discover.tsx', { ...db, context: () => ++call === 1 ? oldContext.promise : Promise.resolve({ user: { id: 'self' }, role: 'barista', profile: { id: 'self', location: 'Orlando, FL', is_discoverable: true } }) });
  h.focus(); h.blur(); h.focus(); await settle(); h.render(); assert.match(h.text(), /Orlando role/);
  oldContext.resolve({ user: { id: 'self' }, role: 'barista', profile: { id: 'self', location: 'Miami, FL', is_discoverable: true } }); await settle(); h.render(); assert.match(h.text(), /Orlando role/); assert.doesNotMatch(h.text(), /Lead Barista/);
});
test('Matches combines application and discovery conversations with their correct kind', async () => {
  const db = clientFor(call => ({ data: call.table === 'applications' ? [{ id: 'application', job_id: 'job', barista_id: 'self', status: 'matched', job }] : call.table === 'discovery_matches' ? [{ id: 'mutual', barista_id: 'self', cafe_id: 'cafe' }] : [{ id: 'cafe', cafe_name: 'Two Paths Cafe' }] }));
  const h = screen('mobile/app/matches.tsx', { ...db, context: async () => ({ user: { id: 'self' }, role: 'barista', profile: { id: 'self' } }) });
  h.focus(); await settle(); h.render();
  const conversations = h.all('Pressable').filter(node => node.props.accessibilityLabel?.startsWith('Message ')); assert.equal(conversations.length, 2); conversations.forEach(node => node.props.onPress());
  assert.deepEqual(clean(h.routes.map(route => route.params)), [{ id: 'mutual', kind: 'discovery' }, { id: 'application', kind: 'application' }]);
});

test('Jobs can reopen a paused role and only accepts a confirmed saved status', async () => {
  const db = clientFor(call => ({ data: call.operation === 'update' ? { id: 'job', active: true } : call.table === 'jobs' ? [{ ...job, active: false, owner_id: 'self' }] : [] }));
  const h = screen('mobile/app/jobs.tsx', { ...db, context: async () => readyCafe });
  h.focus(); await settle(); h.render(); h.press('Reopen job'); await settle(); h.render();
  assert.match(h.text(), /Active/); assert.match(h.text(), /Pause job/);
  const write = db.calls.find(call => call.operation === 'update'); assert.equal(write.payload.active, true); assert.equal(write.kind, 'single'); assert.ok(write.filters.some(row => row[1] === 'owner_id' && row[2] === 'self'));
});
test('profile video access uses a short-lived signed URL and surfaces storage denial', async () => {
  const db = clientFor(() => ({ data: [] })); let allowed = true; const requests = [];
  db.client.storage = { from: bucket => ({ createSignedUrl: async (path, seconds) => { requests.push({ bucket, path, seconds }); return allowed ? { data: { signedUrl: 'https://example.invalid/signed-video' } } : { error: new Error('Access denied') }; } }) };
  const market = sourceLoader(db)('mobile/lib/marketplace.ts');
  assert.equal(await market.profileVideoUrl('barista/video.mp4'), 'https://example.invalid/signed-video'); assert.deepEqual(requests[0], { bucket: 'coffee-videos', path: 'barista/video.mp4', seconds: 300 });
  allowed = false; await assert.rejects(market.profileVideoUrl('other/video.mp4'), /Access denied/);
});
