import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { File } from 'node:buffer';

// Execute the actual dashboard event handlers and the unchanged media controller.
// All transport is inert; profile mutations are forbidden unless an existing-Save
// regression test explicitly enables them. No browser/package dependency in CI.
const html = fs.readFileSync(new URL('../dashboard.html', import.meta.url), 'utf8');
const helper = fs.readFileSync(new URL('../profile-media-review.js', import.meta.url), 'utf8');
const start = html.indexOf('let profileSaveInProgress=');
const end = html.indexOf("document.getElementById('job-cancel')", start);
assert(start > 0 && end > start);
const handlers = html.slice(start, end);
const U = '11111111-1111-4111-8111-111111111111';
const V = '22222222-2222-4222-8222-222222222222';
const ids = { avatar_url: '33333333-3333-4333-8333-333333333333', bar_picture_url: '44444444-4444-4444-8444-444444444444', video_path: '55555555-5555-4555-8555-555555555555' };
const image = () => new File(['exact synthetic PNG bytes'], 'logo.png', { type: 'image/png' });
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }

function element() {
  return { disabled: false, children: [], style: {}, attributes: {}, textContent: '',
    append(...nodes) { this.children.push(...nodes); }, replaceChildren(...nodes) { this.children = nodes; },
    setAttribute(k, v) { this.attributes[k] = v; }, removeAttribute(k) { delete this.attributes[k]; },
    close() { this.open = false; }, showModal() { this.open = true; },
  };
}
function input(value = '') {
  const node = element(); node.files = []; node.checked = false;
  Object.defineProperty(node, 'value', { get() { return value; }, set(v) { value = v; if (v === '') node.files = []; } });
  return node;
}
function fixture({ role = 'cafe_owner_manager', allowProfileWrites = false } = {}) {
  const calls = [], rows = [], intents = new Map(), nodes = {}, hooks = {};
  const fields = {};
  for (const name of ['barista_image', 'cafe_image', 'bar_picture', 'video', 'name', 'location', 'bio', 'date_of_birth', 'gender_identity', 'skills', 'availability_notes', 'experience', 'pay_expectation', 'preferred_city', 'preferred_state', 'preferred_postal_code', 'preferred_radius_miles', 'cafe_address', 'shop_type']) fields[name] = input();
  Object.assign(fields.name, { value: 'TEST ONLY Café' }); fields.location.value = 'Miami, FL'; fields.bio.value = 'Unsaved draft must remain';
  fields.cafe_address.value = '123 Sample Street'; fields.shop_type.value = 'Neighborhood café';
  const form = nodes['profile-form'] = element(); form.elements = fields;
  const submit = nodes['profile-media-submit'] = element(); submit.textContent = 'Submit media for review';
  const save = element(); save.textContent = 'Save profile';
  const cancel = nodes['profile-cancel'] = element();
  const controls = [...Object.values(fields), submit, save, cancel];
  form.querySelectorAll = () => controls; form.querySelector = selector => selector === '[type="submit"]' ? save : null;
  form.reset = () => { for (const field of Object.values(fields)) field.value = ''; };
  const dialog = nodes['profile-dialog'] = element(); dialog.open = true;
  nodes['profile-media-review'] = element(); nodes['profile-status'] = element();
  const profile = { id: U, role, cafe_name: 'TEST ONLY hidden café', display_name: 'TEST ONLY barista', location: 'Miami, FL', is_discoverable: false, visible_to_cafes: false, avatar_url: 'https://old.example/approved.png', bar_picture_url: null, video_path: null, suspended_at: null };
  const session = { user: { id: U }, access_token: 'inert-owner-token', expires_at: Date.now() / 1000 + 3600 };
  const client = {
    auth: { getSession: async () => { if (hooks.session) await hooks.session(); return { data: { session }, error: null }; } },
    rpc(name, args) { return { async setHeader(k, value) {
      calls.push({ op: 'rpc', name, args, header: value });
      if (hooks.beforeRpc) await hooks.beforeRpc(name, args);
      let data;
      if (name === 'my_profile_media_reviews') data = rows.map(row => ({ ...row }));
      else if (name === 'reserve_profile_media_upload') {
        const owner = value === 'Bearer inert-second-owner-token' ? V : U;
        const id = ids[args.p_field], ext = args.p_mime_type === 'video/mp4' ? 'mp4' : args.p_mime_type === 'image/jpeg' ? 'jpg' : 'png';
        data = { upload_id: id, bucket: 'ugc-media-staging', object_path: `${owner}/${id}.${ext}`, expires_at: new Date(Date.now() + 600000).toISOString() };
        intents.set(args.p_field, data);
      } else if (name === 'submit_profile_media_review') {
        data = { request_id: ids[args.p_field], field: args.p_field, status: 'pending', submitted_at: new Date().toISOString(), reviewed_at: null, rejection_code: null, published_value: null, can_publish: false };
        if (!rows.some(row => row.request_id === data.request_id)) rows.push(data);
      } else if (name === 'cancel_profile_media_review') { rows.find(row => row.request_id === args.p_request_id).status = 'cancelled'; data = true; }
      else throw Error('Unexpected RPC');
      if (hooks.afterRpc) await hooks.afterRpc(name, args);
      return { data, error: null };
    } }; },
    storage: { from(bucket) { return { async upload(object, file, options) {
      calls.push({ op: 'upload', bucket, object, file, bytes: Buffer.from(await file.arrayBuffer()).toString('hex'), options });
      if (hooks.upload) await hooks.upload();
      return { data: { path: object }, error: null };
    } }; } },
    from(table) {
      let payload;
      const query = { update(p) { calls.push({ op: 'update', table, payload: p }); if (!allowProfileWrites) throw Error('Profile mutation forbidden'); payload = p; return query; },
        upsert(p) { calls.push({ op: 'upsert', table, payload: p }); throw Error('Profile upsert forbidden'); },
        select() { return query; }, eq() { return query; }, single() { return query; }, setHeader() { return query; },
        then(resolve, reject) { return Promise.resolve().then(async () => { if (hooks.profile) await hooks.profile(); return { data: { ...profile, ...payload }, error: null }; }).then(resolve, reject); },
      }; return query;
    },
  };
  class FormDataSnapshot {
    constructor() { this.values = Object.fromEntries(Object.entries(fields).map(([name, field]) => [name, field.disabled ? null : field.files[0] || field.value])); }
    get(name) { return this.values[name] ?? ''; } getAll() { return []; } set(name, value) { this.values[name] = value; }
  }
  const context = vm.createContext({ console, Date, Map, Set, Promise, Error, File, FormData: FormDataSnapshot,
    document: { getElementById: id => nodes[id] ??= element(), createElement: () => element() },
    currentUser: { id: U }, currentRole: role, currentProfile: { ...profile }, currentDemographics: {}, activeClient: client, currentSection: 'Café Profile', currentView: {},
    collectOpeningHours: () => 'Monday 7 AM–5 PM', isFloridaPlace: () => true, validBaristaBirthDate: () => true,
    collectAvailability: () => '', profileVisibilityReady: () => { calls.push({ op: 'visibility-normalization' }); return true; },
    refreshMarketplaceAfterProfileSave: async () => true, openSection: () => {},
    BaristaMatchLocation: { normalizeUSLocation: v => v }, fetch: () => { throw Error('Network forbidden'); },
  }); context.window = context;
  vm.runInContext(helper, context); vm.runInContext(handlers, context);
  vm.runInContext('renderProfileMediaReview(ensureProfileMediaController().state())', context);
  return { calls, rows, intents, hooks, fields, form, submit, save, cancel, dialog, nodes, profile, session, context,
    run: code => vm.runInContext(code, context), submitMedia: () => submit.onclick(),
    saveProfile: () => form.onsubmit({ preventDefault() {}, currentTarget: form }),
    state: () => vm.runInContext('profileMediaController?.state()', context),
    choose(name, file) { fields[name].files = [file]; fields[name].value = file.name; },
  };
}
function forbiddenWrites(f) { return f.calls.filter(c => ['update', 'upsert', 'visibility-normalization'].includes(c.op)); }
const reserves = f => f.calls.filter(c => c.op === 'rpc' && c.name === 'reserve_profile_media_upload');

test('new action is a normal labelled non-submit control, separate from Save profile', () => {
  assert.match(html, /type="button" id="profile-media-submit" aria-describedby="profile-media-submit-help">Submit media for review/);
  assert.match(html, /Your unsaved profile details and discovery settings stay unchanged/);
  assert(html.indexOf('id="profile-media-review"') < html.indexOf('id="profile-media-submit"'), 'Existing retention disclosure panel must precede intake');
});
test('media-only submits exact selected logo without text validation, profile/discovery or financial writes', async () => {
  const f = fixture(), file = image(); f.fields.location.value = 'Invalid unsaved location'; f.choose('cafe_image', file);
  const before = JSON.stringify(f.context.currentProfile); await f.submitMedia();
  assert.deepEqual(forbiddenWrites(f), []); assert.equal(JSON.stringify(f.context.currentProfile), before);
  assert.equal(f.fields.location.value, 'Invalid unsaved location'); assert.equal(f.fields.bio.value, 'Unsaved draft must remain');
  const uploaded = f.calls.find(c => c.op === 'upload'); assert.equal(uploaded.file, file);
  assert.equal(uploaded.bytes, Buffer.from(await file.arrayBuffer()).toString('hex')); assert.equal(uploaded.bucket, 'ugc-media-staging');
  assert.equal(uploaded.options.upsert, false); assert.equal(uploaded.options.headers.Authorization, 'Bearer inert-owner-token');
  assert.equal(f.rows[0].field, 'avatar_url'); assert.equal(f.rows[0].status, 'pending'); assert.equal(f.fields.cafe_image.files.length, 0);
  assert.equal(f.dialog.open, true); assert.match(f.nodes['profile-status'].textContent, /profile details, discovery settings and current media are unchanged/);
  assert(f.calls.filter(c => c.op === 'rpc').every(c => c.header === 'Bearer inert-owner-token'));
});
test('barista action selects its photo/video, never hidden café fields', async () => {
  const f = fixture({ role: 'barista' }); f.choose('barista_image', image());
  const video = new File(['synthetic video'], 'skills.mp4', { type: 'video/mp4' }); f.choose('video', video); f.choose('cafe_image', image());
  await f.submitMedia(); assert.deepEqual(reserves(f).map(c => c.args.p_field), ['avatar_url', 'video_path']);
  assert.deepEqual(forbiddenWrites(f), []); assert.equal(f.calls.filter(c => c.op === 'upload')[1].file, video);
});
test('no selection and a closed dialog cause no transport or writes', async () => {
  const f = fixture(); await f.submitMedia(); assert.equal(f.calls.length, 0);
  assert.match(f.nodes['profile-status'].textContent, /Choose a photo or video/);
  f.choose('cafe_image', image()); f.dialog.close(); await f.submitMedia(); assert.equal(f.calls.length, 0);
});
test('invalid file fails closed with draft and hidden profile intact', async () => {
  const f = fixture(); const file = new File(['unsafe'], 'logo.svg', { type: 'image/svg+xml' }); f.choose('cafe_image', file);
  await f.submitMedia(); assert.equal(reserves(f).length, 0); assert.deepEqual(forbiddenWrites(f), []);
  assert.equal(f.fields.cafe_image.files[0], file); assert.equal(f.context.currentProfile.is_discoverable, false);
});
test('shared busy lock prevents duplicate media intake, Save, Cancel and Escape while upload is pending', async () => {
  const f = fixture(), gate = deferred(); f.choose('cafe_image', image()); f.hooks.upload = () => gate.promise;
  const pending = f.submitMedia(); while (!f.calls.some(c => c.op === 'upload')) await tick();
  await f.submitMedia(); await f.saveProfile(); f.cancel.onclick(); let prevented = false; f.dialog.oncancel({ preventDefault() { prevented = true; } });
  assert(prevented); assert.equal(f.dialog.open, true); assert.equal(reserves(f).length, 1); assert.deepEqual(forbiddenWrites(f), []);
  gate.resolve(); await pending; assert.equal(f.submit.disabled, false); assert.equal(f.fields.bio.disabled, false);
  f.cancel.onclick(); assert.equal(f.dialog.open, false);
});
test('an existing ordinary Save holds the same lock against the new action', async () => {
  const f = fixture({ allowProfileWrites: true }), gate = deferred(); f.hooks.profile = () => gate.promise;
  const save = f.saveProfile(); while (!f.calls.some(c => c.op === 'update')) await tick();
  await f.submitMedia(); assert.equal(reserves(f).length, 0); gate.resolve(); await save;
  assert.equal(f.calls.filter(c => c.op === 'update').length, 2); assert.equal(f.calls.filter(c => c.op === 'visibility-normalization').length, 1);
});
for (const mismatch of ['foreign-session', 'expired-session']) test(`${mismatch} cannot reserve or write`, async () => {
  const f = fixture(); f.choose('cafe_image', image());
  if (mismatch === 'foreign-session') f.session.user.id = V; else f.session.expires_at = 0;
  await f.submitMedia(); assert.equal(f.calls.length, 0); assert.deepEqual(forbiddenWrites(f), []);
});
for (const stage of ['session', 'reserve', 'upload']) test(`account/role/generation switch after ${stage} stops later writes and old UI`, async () => {
  const f = fixture(); f.choose('cafe_image', image()); const switchOwner = () => { f.context.currentUser = { id: V }; f.context.currentRole = 'barista'; f.run('invalidateProfileMediaSession()'); f.nodes['profile-status'].textContent = 'New account'; };
  if (stage === 'session') f.hooks.session = switchOwner;
  if (stage === 'reserve') f.hooks.afterRpc = name => { if (name === 'reserve_profile_media_upload') switchOwner(); };
  if (stage === 'upload') f.hooks.upload = switchOwner;
  await f.submitMedia(); assert.deepEqual(forbiddenWrites(f), []); assert.equal(f.nodes['profile-status'].textContent, 'New account');
  if (stage === 'session') assert.equal(f.calls.length, 0);
  if (stage === 'reserve') assert.equal(f.calls.filter(c => c.op === 'upload').length, 0);
  assert.equal(f.calls.filter(c => c.name === 'submit_profile_media_review').length, 0);
  assert.equal(f.dialog.open, false); assert.equal(f.state(), undefined);
});
test('controller busy check blocks media-only while a refresh is pending', async () => {
  const f = fixture(), gate = deferred(); f.choose('cafe_image', image()); f.hooks.beforeRpc = name => name === 'my_profile_media_reviews' ? gate.promise : undefined;
  const check = f.run('profileMediaController.refresh()'); while (!f.calls.length) await tick(); await f.submitMedia();
  assert.equal(reserves(f).length, 0); assert.equal(f.submit.disabled, true); gate.resolve(); await check; assert.equal(f.submit.disabled, false);
});
test('unknown upload stays in the same controller across Cancel, and explicit continuation uses no second reserve', async () => {
  const f = fixture(); f.choose('cafe_image', image()); let lost = true; f.hooks.upload = () => { if (lost) { lost = false; throw Error('connection lost'); } };
  await f.submitMedia(); assert.equal(f.state().drafts[0].phase, 'upload_unknown'); assert.equal(reserves(f).length, 1);
  f.cancel.onclick(); assert.equal(f.dialog.open, false); assert.equal(f.state().drafts.length, 1); f.dialog.showModal();
  await f.submitMedia(); assert.equal(reserves(f).length, 1); await f.run("profileMediaController.continueUpload('avatar_url')");
  assert.equal(reserves(f).length, 1); assert.equal(f.state().drafts.length, 0); assert.equal(f.rows.length, 1); assert.deepEqual(forbiddenWrites(f), []);
});
test('unknown submit reconciles the same request with no new upload/intake', async () => {
  const f = fixture(); f.choose('cafe_image', image()); let lost = true;
  f.hooks.afterRpc = name => { if (name === 'submit_profile_media_review' && lost) { lost = false; throw Error('response lost'); } };
  await f.submitMedia(); assert.equal(f.state().drafts[0].phase, 'submit_unknown'); assert.equal(f.rows.length, 1);
  await f.run("profileMediaController.continueUpload('avatar_url')"); assert.equal(reserves(f).length, 1); assert.equal(f.calls.filter(c => c.op === 'upload').length, 1);
  assert.equal(f.state().drafts.length, 0); assert.deepEqual(forbiddenWrites(f), []);
});
test('queued review action cannot race media-only across its owner-session await', async () => {
  const f = fixture(); f.choose('cafe_image', image()); const panel = f.nodes['profile-media-review'];
  const check = panel.children.find(node => node.textContent === 'Check status'); check.onclick();
  await f.submitMedia();
  assert.equal(reserves(f).length, 1); assert.equal(f.calls.filter(c => c.name === 'my_profile_media_reviews').length, 2); assert.deepEqual(forbiddenWrites(f), []);
});
for (const oldKind of ['media', 'ordinary-save']) test(`old ${oldKind} settling after account switch cannot unlock a new owner's pending media operation`, async () => {
  const f = fixture({ allowProfileWrites: oldKind === 'ordinary-save' }), oldGate = deferred(), newGate = deferred();
  let oldStarted = false, uploads = 0;
  if (oldKind === 'media') { f.choose('cafe_image', image()); f.hooks.upload = () => { uploads++; if (uploads === 1) { oldStarted = true; return oldGate.promise; } return newGate.promise; }; }
  else { f.hooks.profile = () => { oldStarted = true; return oldGate.promise; }; f.hooks.upload = () => { uploads++; return newGate.promise; }; }
  const oldPending = oldKind === 'media' ? f.submitMedia() : f.saveProfile(); while (!oldStarted) await tick();
  f.context.currentUser = { id: V }; f.context.currentProfile = { ...f.profile, id: V }; f.session.user.id = V; f.session.access_token = 'inert-second-owner-token';
  f.run('invalidateProfileMediaSession()'); assert.equal(f.run('profileSaveInProgress'), false); assert.equal(f.fields.bio.disabled, false);
  f.dialog.showModal(); f.choose('cafe_image', image()); const newPending = f.submitMedia();
  const wantedUploads = oldKind === 'media' ? 2 : 1; while (uploads < wantedUploads) await tick();
  const before = f.calls.length; oldGate.resolve(); await oldPending;
  assert.equal(f.run('profileSaveInProgress'), true); assert.equal(f.form.attributes['aria-busy'], 'true');
  assert.equal(f.save.disabled, true); assert.equal(f.submit.disabled, true); assert.equal(f.cancel.disabled, true);
  f.cancel.onclick(); let prevented = false; f.dialog.oncancel({ preventDefault() { prevented = true; } }); assert(prevented); assert.equal(f.dialog.open, true);
  await f.saveProfile(); await f.submitMedia(); assert.equal(f.calls.length, before);
  assert.equal(f.nodes['profile-status'].textContent, 'Submitting selected media privately for review…');
  newGate.resolve(); await newPending;
  assert.equal(f.run('profileSaveInProgress'), false); assert.equal(f.form.attributes['aria-busy'], undefined); assert.equal(f.cancel.disabled, false);
  assert.equal(f.context.currentProfile.id, V); assert.equal(f.context.currentProfile.is_discoverable, false);
  assert.equal(f.calls.filter(c => c.op === 'upload').at(-1).options.headers.Authorization, 'Bearer inert-second-owner-token');
  assert(f.calls.filter(c => c.name === 'submit_profile_media_review').every(c => c.args.p_object_path.startsWith(V + '/')));
});
