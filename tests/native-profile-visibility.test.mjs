import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url), ts = require('../mobile/node_modules/typescript');
function compile(file, mocks = {}) {
  const exports = {}, source = fs.readFileSync(new URL(`../mobile/${file}`, import.meta.url), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const load = name => {
    if (Object.hasOwn(mocks, name)) return mocks[name];
    if (name === './floridaLocation') return compile('lib/floridaLocation.ts');
    throw new Error(`Unmocked import ${name}`);
  };
  vm.runInNewContext(code, { exports, require: load, Date, Math, Error, setTimeout, clearTimeout }, { filename: file });
  return exports;
}
const privacy = compile('lib/profilePrivacy.ts');
const options = { locationCity: 'Miami', availability: ['Weekday mornings'], availabilityNotes: '', openHours: 'Monday 8–4' };
const barista = { id: 'user-a', role: 'barista', display_name: 'Sample', avatar_url: 'photo', location: 'Miami, FL', bio: 'About', experience: 'One year', availability: 'Weekday mornings', pay_expectation: '$20', skills: ['Espresso'], date_of_birth: '2000-01-01', gender_identity: null, visible_to_cafes: true, is_discoverable: true };
const cafe = { id: 'user-a', role: 'cafe_owner_manager', cafe_name: 'Sample Café', avatar_url: 'photo', location: 'Miami, FL', bio: 'About', cafe_address: '1 Main St', open_hours: 'Monday 8–4', shop_type: 'Coffee bar', barista_preferences: ['Teamwork'], visible_to_cafes: true, is_discoverable: true };
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

function profileEditor(initial, { serverFields = {}, gate } = {}) {
  let saved = { ...initial }, tree, cursor = 0, refCursor = 0, effectCursor = 0;
  const states = [], refs = [], effects = [], writes = [], alerts = [];
  const jsx = (type, props) => ({ type, props: props || {} });
  const react = {
    useState(initial) { const key = cursor++; if (!(key in states)) states[key] = typeof initial === 'function' ? initial() : initial; return [states[key], value => { states[key] = typeof value === 'function' ? value(states[key]) : value; }]; },
    useRef(initial) { const key = refCursor++; return refs[key] ||= { current: initial }; },
    useCallback: fn => fn,
    useEffect(fn) { const key = effectCursor++; if (!(key in effects)) effects[key] = fn(); },
  };
  const client = { from(table) { return {
    select() { return this; }, eq() { return this; }, maybeSingle: async () => ({ data: table === 'profile_demographics' ? { date_of_birth: saved.date_of_birth, gender_identity: saved.gender_identity } : saved, error: null }),
    upsert: async () => ({ error: null }),
    update(payload) { const snapshot = { ...payload }; return { eq: () => ({ select: () => ({ single: async () => { writes.push(snapshot); if (gate) await gate.promise; saved = { ...saved, ...snapshot, ...serverFields }; return { data: saved, error: null }; } }) }) }; },
  }; } };
  const component = compile('app/profile.tsx', {
    react, 'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'Fragment' },
    'react-native': new Proxy({ StyleSheet: { create: value => value }, Platform: { OS: 'ios' }, Alert: { alert: (...args) => alerts.push(args) } }, { get: (target, key) => target[key] || key }),
    'expo-router': { router: { replace() {}, push() {} }, useFocusEffect: react.useEffect },
    'expo-image-picker': {}, '@/components/AppBottomNav': { AppBottomNav: 'AppBottomNav' }, '@/lib/supabase': { supabase: client },
    '@/lib/profilePrivacy': privacy, '@/lib/floridaLocation': compile('lib/floridaLocation.ts'),
    '@/lib/session': { getCurrentContext: async () => ({ user: { id: saved.id }, role: saved.role, profile: saved }), requireCurrentUser: async () => ({ id: saved.id }) },
  }).default;
  function render() { cursor = refCursor = effectCursor = 0; tree = component(); }
  function nodes() { const result = []; const visit = node => { if (Array.isArray(node)) return node.forEach(visit); if (!node || typeof node !== 'object') return; result.push(node); visit(node.props?.children); }; visit(tree); return result; }
  const text = node => Array.isArray(node) ? node.map(text).join('') : node && typeof node === 'object' ? text(node.props?.children) : String(node || '');
  const button = label => nodes().find(node => node.type === 'Pressable' && text(node) === label);
  const control = () => nodes().find(node => node.type === 'Switch' && node.props.accessibilityLabel === 'Show my profile in discovery');
  render();
  return { render, writes, alerts, button, control, nodes, async open() { await flush(); render(); button('Edit profile').props.onPress(); render(); }, async save() { await button('Save profile').props.onPress(); render(); } };
}

test('both profile editors save explicit discovery opt-outs and opt-ins', async () => {
  for (const initial of [barista, cafe]) {
    const ui = profileEditor(initial); await ui.open();
    assert.equal(ui.control().props.value, true);
    ui.control().props.onValueChange(false); ui.render(); await ui.save();
    assert.equal(ui.writes[0].visible_to_cafes, false); assert.match(ui.alerts.at(-1)[1], /Discovery is switched off/);
    ui.button('Edit profile').props.onPress(); ui.render(); assert.equal(ui.control().props.value, false);
    ui.control().props.onValueChange(true); ui.render(); await ui.save();
    assert.equal(ui.writes[1].visible_to_cafes, true); assert.equal(ui.alerts.at(-1)[1], 'Your profile is visible in discovery.');
  }
});

test('missing, null and false saved preferences stay off when unrelated profile fields are saved', async () => {
  for (const visible_to_cafes of [undefined, null, false]) {
    const ui = profileEditor({ ...cafe, visible_to_cafes }); await ui.open();
    assert.equal(ui.control().props.value, false);
    ui.nodes().find(node => node.props.label === 'Café name').props.onChange('Updated café'); ui.render(); await ui.save();
    assert.equal(ui.writes[0].visible_to_cafes, false);
    assert.match(ui.alerts.at(-1)[1], /switched off/);
  }
});

test('cancel restores the saved visibility preference without making a write', async () => {
  const ui = profileEditor(cafe); await ui.open();
  ui.control().props.onValueChange(false); ui.render(); ui.button('Cancel').props.onPress(); ui.render();
  ui.button('Edit profile').props.onPress(); ui.render();
  assert.equal(ui.control().props.value, true); assert.equal(ui.writes.length, 0);
});

test('visibility is captured before saving and cannot be toggled during a pending write', async () => {
  const gate = deferred(), ui = profileEditor(cafe, { gate }); await ui.open();
  ui.control().props.onValueChange(false); ui.render();
  const save = ui.button('Save profile').props.onPress(); await flush(); ui.render();
  assert.equal(ui.control().props.disabled, true); ui.control().props.onValueChange(true); ui.render();
  assert.equal(ui.control().props.value, false); assert.equal(ui.writes[0].visible_to_cafes, false);
  gate.resolve(); await save;
});

test('confirmation and the next editor use the persisted server choice instead of the submitted opt-in', async () => {
  const ui = profileEditor({ ...cafe, visible_to_cafes: false }, { serverFields: { visible_to_cafes: false, is_discoverable: false } }); await ui.open();
  ui.control().props.onValueChange(true); ui.render(); await ui.save();
  assert.equal(ui.writes[0].visible_to_cafes, true); assert.match(ui.alerts.at(-1)[1], /switched off/);
  ui.button('Edit profile').props.onPress(); ui.render(); assert.equal(ui.control().props.value, false);
});

test('an opt-in never makes incomplete or suspended profiles discoverable and gender remains optional', () => {
  for (const initial of [barista, cafe]) {
    const incomplete = { ...initial, bio: '', visible_to_cafes: true };
    const missingPayload = privacy.buildProfileUpdate(incomplete, initial.role, options);
    assert.equal(missingPayload.is_discoverable, false); assert.equal(missingPayload.visible_to_cafes, true);
    assert.equal(privacy.getProfileReadiness({ ...incomplete, ...missingPayload }, initial.role).visible, false);
    assert.match(privacy.getProfileSaveMessage({ ...incomplete, ...missingPayload }, initial.role), /stays hidden until you complete/);
    const suspended = { ...initial, suspended_at: '2026-09-07', visible_to_cafes: true };
    const suspendedPayload = privacy.buildProfileUpdate(suspended, initial.role, options);
    assert.equal(suspendedPayload.is_discoverable, false);
    assert.match(privacy.getProfileSaveMessage(suspended, initial.role), /stays hidden while your account is suspended/);
  }
  for (const gender_identity of [undefined, null, '', 'female', 'male']) {
    const payload = privacy.buildProfileUpdate({ ...barista, gender_identity }, 'barista', options);
    assert.equal(payload.is_discoverable, true); assert.equal(payload.visible_to_cafes, true);
    assert.equal('gender_identity' in payload, false);
  }
});
