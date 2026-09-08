import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const dashboard = fs.readFileSync(new URL('../dashboard.html', import.meta.url), 'utf8');
const quietFocus = fs.readFileSync(new URL('../dashboard-quiet-focus.js', import.meta.url), 'utf8');
function source(name) {
  const start = dashboard.search(new RegExp(`^(?:async )?function ${name}\\(`, 'm'));
  assert.ok(start >= 0, name);
  const tail = dashboard.slice(start);
  const next = tail.slice(1).search(/\n(?=(?:async )?function |Object\.defineProperty|let activeMessageApplicationId|document\.)/);
  return next < 0 ? tail : tail.slice(0, next + 1);
}
const baseFunctions = ['normalizePlace', 'floridaPlaceParts', 'legacyJobState', 'legacyJobCity', 'isFloridaPlace', 'workArea', 'workAreaLabel', 'jobMatchesBaristaLocation', 'candidateMatchesCafeLocation', 'escapeHtml', 'money', 'cafeImage', 'discoveryState', 'discoveryButton', 'incomingInterestsHtml', 'marketplaceNoticeHtml', 'searchSummaryHtml', 'applicationButton', 'jobCardHtml', 'jobsHtml', 'baristaDiscoveryHtml', 'jobDetailsHtml', 'applicationsHtml'];
function context(extra = {}, functions = []) {
  const ctx = { currentRole: 'barista', currentUser: { id: 'barista' }, currentProfile: { id: 'barista', location: 'Miami, FL' }, applications: [], discoveryInterests: [], discoveryMatches: [], discoveryProfiles: {}, candidateProfiles: [], marketJobs: [], marketplaceRefreshMessage: '', editingJobId: null, window: {}, ...extra };
  vm.createContext(ctx);
  vm.runInContext([...new Set([...baseFunctions, ...functions])].map(source).join('\n'), ctx);
  return ctx;
}
const job = { id: 'job-1', owner_id: 'cafe', title: 'Lead Barista', location: 'Miami, FL 33101', city: 'Miami', state: 'FL', postal_code: '33101', address_line1: '123 Main St', address_line2: 'Suite 2', pay_min: 23, pay_max: 25, schedule: 'Full-time', description: 'Paid training <script>bad()</script>', required_skills: ['Espresso'], owner: { cafe_name: 'Test Café', location: 'Miami, FL' } };

test('incoming interests remain actionable without local active jobs and when sender is absent from filtered candidates', () => {
  const ctx = context({ discoveryInterests: [{ sender_id: 'cafe', target_id: 'barista' }], discoveryProfiles: { cafe: { id: 'cafe', cafe_name: 'Outside search café', location: 'Orlando, FL' } } });
  assert.match(ctx.jobsHtml(), /Interested in you/);
  assert.match(ctx.jobsHtml(), /data-discovery-interest="cafe"[^>]*>Match back/);
  assert.match(ctx.jobsHtml(), /No jobs in your saved work area/);
  ctx.currentRole = 'cafe_owner_manager'; ctx.currentUser = { id: 'cafe' };
  ctx.discoveryInterests = [{ sender_id: 'barista', target_id: 'cafe' }];
  ctx.discoveryProfiles = { barista: { id: 'barista', display_name: 'Interested barista' } };
  assert.match(ctx.baristaDiscoveryHtml(), /data-view-barista="barista"/);
  assert.match(ctx.baristaDiscoveryHtml(), /Match back/);
});

test('inaccessible incoming profiles never render a connection or profile action', () => {
  const ctx = context({ discoveryInterests: [{ sender_id: 'blocked', target_id: 'barista' }] });
  const html = ctx.incomingInterestsHtml();
  assert.match(html, /Profile currently unavailable/);
  assert.doesNotMatch(html, /data-discovery-interest|data-view-cafe/);
});

test('every job has a specific details destination, full escaped details, and a repeat-safe application state', () => {
  const ctx = context({ marketJobs: [job] });
  assert.match(ctx.jobsHtml(), /data-view-job="job-1"/);
  const details = ctx.jobDetailsHtml(job);
  for (const value of ['$23–$25/hour', 'Full-time', '123 Main St', 'Suite 2', '33101', 'Espresso', 'Paid training &lt;script&gt;']) assert.ok(details.includes(value), value);
  assert.doesNotMatch(details, /<script>bad/);
  assert.match(details, /data-apply-job="job-1"/);
  ctx.applications = [{ job_id: 'job-1', status: 'interested' }];
  assert.match(ctx.jobDetailsHtml(job), /disabled>Application sent/);
  assert.doesNotMatch(ctx.jobDetailsHtml(job), /data-apply-job/);
});

test('city and ZIP matching uses supported exact semantics with a profile-city fallback', () => {
  const ctx = context();
  assert.equal(ctx.jobMatchesBaristaLocation(job), true);
  assert.equal(ctx.jobMatchesBaristaLocation({ ...job, city: 'Tallahassee' }), false);
  assert.equal(ctx.jobMatchesBaristaLocation({ location: 'Miami, FL, 33101' }), true);
  ctx.currentProfile = { location: 'Miami, FL', preferred_city: 'Fort Lauderdale', preferred_state: 'FL' };
  assert.equal(ctx.jobMatchesBaristaLocation(job), false);
  assert.equal(ctx.jobMatchesBaristaLocation({ ...job, city: 'fort lauderdale' }), true);
  ctx.currentProfile.preferred_postal_code = '33101-1234';
  assert.equal(ctx.jobMatchesBaristaLocation(job), true, 'ZIP takes precedence over city');
  assert.equal(ctx.jobMatchesBaristaLocation({ ...job, postal_code: '33301' }), false);
  assert.equal(ctx.jobMatchesBaristaLocation({ ...job, state: 'NY' }), false);
  assert.doesNotMatch(dashboard, /Within about (10|25|50|100) miles/);
});

test('café matching does not confuse similarly named Florida cities', () => {
  const ctx = context({ currentRole: 'cafe_owner_manager', currentProfile: { location: 'Miami, FL', cafe_address: '123 Main Street, Miami, FL 33101' } });
  assert.equal(ctx.candidateMatchesCafeLocation({ location: 'Miami, FL' }), true);
  assert.equal(ctx.candidateMatchesCafeLocation({ location: 'Miami Beach, FL' }), false);
  assert.equal(ctx.candidateMatchesCafeLocation({ location: 'Miami Gardens, FL' }), false);
  assert.equal(ctx.candidateMatchesCafeLocation({ location: 'Orlando, FL', preferred_postal_code: '33101' }), true);
});

test('all result pages are read before applying geography, including when the server returns shorter pages', async () => {
  const profiles = Array.from({ length: 140 }, (_, index) => ({ id: `other-${index}`, location: 'Orlando, FL' }));
  profiles.push({ id: 'local-after-100', location: 'Miami, FL' });
  const ranges = [];
  const ctx = context({ currentRole: 'cafe_owner_manager', currentUser: { id: 'cafe' }, currentProfile: { location: 'Miami, FL' }, activeClient: { from(table) {
    const query = { select() { return this; }, eq() { return this; }, order() { return this; }, async range(from, to) { ranges.push({ table, from, to }); return { data: table === 'profiles' ? profiles.slice(from, Math.min(to + 1, from + 100)) : [], error: null }; } }; return query;
  } } }, ['loadAllRows', 'loadLegacyMarketplaceData']);
  await ctx.loadLegacyMarketplaceData();
  assert.equal(ctx.candidateProfiles.length, 1);
  assert.equal(ctx.candidateProfiles[0].id, 'local-after-100');
  assert.ok(ranges.some(call => call.table === 'profiles' && call.from === 100));
  assert.ok(ranges.some(call => call.table === 'profiles' && call.from === 141));
});

test('sent café interests appear alongside applications and homepage links preserve job IDs', () => {
  const ctx = context({ marketJobs: [job, { ...job, id: 'job-2' }], discoveryInterests: [{ sender_id: 'barista', target_id: 'cafe', created_at: '2026-09-07T00:00:00Z' }], discoveryProfiles: { cafe: { id: 'cafe', cafe_name: 'Test Café' } } });
  assert.match(ctx.applicationsHtml(), /Café interests \(1\)/);
  assert.match(ctx.applicationsHtml(), /Test Café/);
  assert.match(ctx.applicationsHtml(), /Interest sent/);
  vm.runInContext(quietFocus, ctx);
  const home = ctx.window.BaristaMatchQuietFocus.render({ role: 'barista', profile: ctx.currentProfile, marketJobs: ctx.marketJobs, applications: [], discoveryInterests: ctx.discoveryInterests, discoveryMatches: [], notificationRows: [], profileStrength: 100, workAreaLabel: 'Orlando, FL' });
  assert.match(home, /<strong>1<\/strong><b>Applications &amp; interests/);
  assert.match(home, /data-view-job="job-1"/);
  assert.match(home, /data-view-job="job-2"/);
  assert.doesNotMatch(home, /Best match for you/);
  assert.match(home, /<span>Orlando, FL<\/span>/, 'search shows saved work area instead of home city');
});

test('a partially completed reciprocal match remains retryable', async () => {
  let matchAttempts = 0, destination;
  const ctx = context({ profileVisibilityReady: () => true, currentView: {}, activeClient: { from(table) { return { async insert() { if (table === 'discovery_matches') matchAttempts++; return { error: { code: '23505' } }; }, select() { return this; }, eq() { return this; }, async maybeSingle() { return { data: { id: 'reciprocal' }, error: null }; } }; } }, alert(message) { throw new Error(message); }, sendPhoneNotificationEvent() {}, openSection(section) { destination = section; } }, ['sendDiscoveryInterest']);
  ctx.loadDiscoveryData = async () => {};
  ctx.discoveryInterests = [{ sender_id: 'barista', target_id: 'cafe' }, { sender_id: 'cafe', target_id: 'barista' }];
  assert.equal(ctx.discoveryState('cafe').disabled, false);
  assert.equal(ctx.discoveryState('cafe').label, 'Finish matching');
  await ctx.sendDiscoveryInterest('cafe', { disabled: false, textContent: '' });
  assert.equal(matchAttempts, 1);
  assert.equal(destination, 'Matches');
});

function validJobForm(overrides = {}) {
  const fields = { title: 'Updated role', city: 'Miami', state: 'FL', postal_code: '33101', address_line1: '123 Main', description: 'New description', hourly_pay: '24', max_hourly_pay: '27', skills: 'Espresso', ...overrides };
  return { get: name => fields[name] ?? '', getAll: name => name === 'schedule' ? ['Full-time'] : [] };
}
test('editing updates the original owner-scoped post without replacing ID, visibility or application history', async () => {
  const original = { ...job, owner_id: 'cafe', active: false }, history = [{ id: 'app-1', job_id: job.id }];
  const filters = []; let payload;
  const ctx = context({ currentRole: 'cafe_owner_manager', currentUser: { id: 'cafe' }, profileVisibilityReady: () => true, activeClient: { from(table) { assert.equal(table, 'jobs'); return { update(value) { payload = value; return this; }, eq(key, value) { filters.push([key, value]); return this; }, select() { return this; }, async single() { Object.assign(original, payload); return { data: { id: original.id }, error: null }; } }; } } }, ['jobPayloadFromForm', 'saveJobPost']);
  await ctx.saveJobPost(validJobForm(), job.id);
  assert.deepEqual(filters, [['id', job.id], ['owner_id', 'cafe']]);
  assert.equal(original.id, job.id);
  assert.equal(original.active, false);
  assert.equal(original.title, 'Updated role');
  assert.equal(original.pay_max, 27);
  assert.equal(history[0].job_id, original.id);
  assert.equal(Object.hasOwn(payload, 'active'), false);
  assert.equal(Object.hasOwn(payload, 'owner_id'), false);
});

test('job form rejects invalid Florida geography, zero pay and reversed pay ranges before any write', () => {
  const ctx = context({}, ['jobPayloadFromForm']);
  for (const invalid of [{ state: 'NY' }, { postal_code: 'abc' }, { hourly_pay: '0' }, { max_hourly_pay: '20' }]) assert.throws(() => ctx.jobPayloadFromForm(validJobForm(invalid)));
});

test('filtering updates a visible count, announces no matches, and clearing restores results', () => {
  const rows = [{ dataset: { search: 'lead barista miami' }, hidden: false }, { dataset: { search: 'espresso trainer' }, hidden: false }];
  const search = { value: '', focus() {} }, count = { dataset: { resultNoun: 'jobs' } }, empty = {}, clear = {};
  const elements = { '#job-search': search, '#marketplace-result-count': count, '#marketplace-search-empty': empty, '[data-clear-market-search]': clear };
  const ctx = context({}, ['bindMarketplaceSearch']);
  ctx.bindMarketplaceSearch({ querySelector: selector => elements[selector], querySelectorAll: () => rows });
  search.value = 'miami'; search.oninput();
  assert.equal(count.textContent, '1 of 2 jobs');
  assert.equal(rows[1].hidden, true);
  search.value = 'nothing matches'; search.oninput();
  assert.equal(count.textContent, '0 of 2 jobs'); assert.equal(empty.hidden, false);
  clear.onclick();
  assert.equal(count.textContent, '2 of 2 jobs'); assert.equal(empty.hidden, true);
});

test('profile-save refresh removes stale geography and exposes retry after failure', async () => {
  const ctx = context({ marketJobs: [job], candidateProfiles: [{ id: 'old-area' }] }, ['refreshMarketplaceAfterProfileSave']);
  ctx.loadMarketplaceData = async () => { throw new Error('offline'); };
  assert.equal(await ctx.refreshMarketplaceAfterProfileSave(), false);
  assert.equal(ctx.marketJobs.length, 0); assert.equal(ctx.candidateProfiles.length, 0);
  assert.match(ctx.marketplaceRefreshMessage, /profile was saved/);
  assert.match(ctx.marketplaceNoticeHtml(), /data-refresh-marketplace/);
});

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function jobEditorContext() {
  const fields = ['title', 'address_line1', 'address_line2', 'city', 'state', 'postal_code', 'description', 'hourly_pay', 'max_hourly_pay', 'skills'];
  const elements = Object.fromEntries(fields.map(name => [name, { value: '', defaultValue: '' }]));
  const stateInput = dashboard.match(/<input name="state"[^>]*>/)[0];
  elements.state.defaultValue = stateInput.match(/\bvalue="([^"]*)"/)?.[1] || '';
  const button = { disabled: false, textContent: '' }, heading = {}, status = { textContent: '' };
  const schedules = [{ value: 'Full-time', checked: false }], content = { firstElementChild: {} }, navigations = [], writes = [];
  const form = {
    elements, resetCount: 0,
    reset() { this.resetCount++; for (const field of Object.values(elements)) field.value = field.defaultValue; schedules.forEach(input => { input.checked = false; }); },
    querySelector: selector => selector === 'h2' ? heading : button,
    querySelectorAll: () => schedules,
  };
  const dialog = { open: false, showModal() { this.open = true; }, close() { this.open = false; } };
  const dom = { 'job-form': form, 'job-status': status, 'job-dialog': dialog, content };
  const ctx = context({ currentRole: 'cafe_owner_manager', currentUser: { id: 'cafe' }, currentSection: 'Job Posts', currentView: {}, jobEditorVersion: 0, marketJobs: [job, { ...job, id: 'job-2', title: 'Second role' }],
    document: { getElementById: id => dom[id] },
    FormData: class {
      constructor() { this.fields = Object.fromEntries(Object.entries(elements).map(([name, input]) => [name, input.value])); this.schedules = schedules.filter(input => input.checked).map(input => input.value); }
      get(name) { return this.fields[name] || ''; }
      getAll(name) { return name === 'schedule' ? this.schedules : []; }
      [Symbol.iterator]() { return [...Object.entries(this.fields), ...this.schedules.map(value => ['schedule', value])][Symbol.iterator](); }
    },
    saveJobPost: async (data, id) => { writes.push({ id, state: data.get('state'), title: data.get('title') }); return { id: id || 'created-job' }; },
    clearPendingJobDraft() {},
    persistPendingJobDraft: () => true,
    showJobUpgradePrompt() {},
    refreshMarketplaceAfterProfileSave: async () => true,
    sendPhoneNotificationEvent() {},
    openSection: section => navigations.push(section),
    alert(message) { throw new Error(message); },
  }, ['openJobEditor', 'submitJobForm']);
  vm.runInContext(dashboard.match(/^document\.getElementById\('job-form'\)\.elements\.state\.[^\n]+/m)[0], ctx);
  return { ctx, form, elements, button, status, dialog, content, navigations, writes, submit: () => ctx.submitJobForm({ preventDefault() {}, currentTarget: form }) };
}

test('first and subsequent new job editors retain the required read-only Florida state after reset', async () => {
  const h = jobEditorContext();
  for (let post = 0; post < 2; post++) {
    h.ctx.openJobEditor();
    assert.equal(h.elements.state.readOnly, true);
    assert.equal(h.elements.state.value, 'FL');
    await h.submit();
  }
  h.ctx.openJobEditor(job.id);
  h.dialog.close();
  h.ctx.openJobEditor();
  assert.equal(h.elements.state.value, 'FL', 'editing another post must not change the new-post default');
  assert.deepEqual(h.writes.map(write => write.state), ['FL', 'FL']);
});

test('an earlier job save cannot close or reset a newer editor during either the write or refresh', async () => {
  for (const phase of ['write', 'refresh']) {
    const h = jobEditorContext(), pending = deferred();
    if (phase === 'write') h.ctx.saveJobPost = () => pending.promise;
    else h.ctx.refreshMarketplaceAfterProfileSave = () => pending.promise;
    h.ctx.openJobEditor(job.id);
    const saving = h.submit();
    await Promise.resolve();
    h.dialog.close();
    h.ctx.openJobEditor('job-2');
    h.elements.title.value = 'New draft for the second role';
    const resets = h.form.resetCount;
    pending.resolve({ id: job.id });
    await saving;
    assert.equal(h.ctx.editingJobId, 'job-2', phase);
    assert.equal(h.elements.title.value, 'New draft for the second role', phase);
    assert.equal(h.form.resetCount, resets, phase);
    assert.equal(h.dialog.open, true, phase);
    assert.equal(h.button.disabled, false, phase);
    assert.equal(h.button.textContent, 'Save changes', phase);
    assert.deepEqual(h.navigations, [], phase);
  }
});

test('an earlier failed save cannot overwrite errors or unlock a newer save', async () => {
  const h = jobEditorContext(), first = deferred(), second = deferred();
  h.ctx.saveJobPost = (data, id) => id === job.id ? first.promise : second.promise;
  h.ctx.openJobEditor(job.id);
  const savingFirst = h.submit();
  h.dialog.close();
  h.ctx.openJobEditor('job-2');
  const savingSecond = h.submit();
  first.reject(new Error('First request failed'));
  await savingFirst;
  assert.equal(h.button.disabled, true);
  assert.equal(h.button.textContent, 'Saving…');
  assert.equal(h.status.textContent, '');
  second.resolve({ id: 'job-2' });
  await savingSecond;
  assert.equal(h.dialog.open, false);
  assert.deepEqual(h.navigations, ['Job Posts']);
});

test('edits typed during publication survive and the next save updates the newly created job', async () => {
  const h = jobEditorContext(), pending = deferred(), writes = [];
  h.ctx.saveJobPost = (data, id) => { writes.push({ id, title: data.get('title') }); return pending.promise; };
  h.ctx.openJobEditor();
  h.elements.title.value = 'Original role';
  const saving = h.submit();
  h.elements.title.value = 'Newer draft';
  pending.resolve({ id: 'newly-created-job' });
  await saving;
  assert.equal(h.dialog.open, true);
  assert.equal(h.elements.title.value, 'Newer draft');
  assert.equal(h.ctx.editingJobId, 'newly-created-job');
  assert.equal(h.button.textContent, 'Save changes');
  assert.match(h.status.textContent, /newer edits/);
  assert.deepEqual(h.navigations, []);
  await h.submit();
  assert.deepEqual(writes, [{ id: null, title: 'Original role' }, { id: 'newly-created-job', title: 'Newer draft' }]);
  assert.equal(h.dialog.open, false);
});

test('canceling a pending save and opening messages preserves the conversation view', async () => {
  const h = jobEditorContext(), pending = deferred();
  h.ctx.saveJobPost = () => pending.promise;
  h.ctx.openJobEditor(job.id);
  const saving = h.submit();
  h.dialog.close();
  h.ctx.currentSection = 'Messages';
  h.content.firstElementChild = { conversation: 'match-1' };
  const resets = h.form.resetCount;
  pending.resolve({ id: job.id });
  await saving;
  assert.deepEqual(h.navigations, []);
  assert.equal(h.content.firstElementChild.conversation, 'match-1');
  assert.equal(h.form.resetCount, resets);
});

test('repeated submits during the same job save issue one write and remain retryable on failure', async () => {
  const h = jobEditorContext(), pending = deferred();
  let writes = 0;
  h.ctx.saveJobPost = () => { writes++; return pending.promise; };
  h.ctx.openJobEditor(job.id);
  h.elements.title.value = 'Keep this draft';
  const saving = h.submit();
  const duplicate = h.submit();
  pending.reject(new Error('Connection lost'));
  await Promise.all([saving, duplicate]);
  assert.equal(writes, 1);
  assert.equal(h.button.disabled, false);
  assert.equal(h.dialog.open, true);
  assert.equal(h.elements.title.value, 'Keep this draft');
  assert.equal(h.status.textContent, 'Connection lost');
});

test('viewing cached or fetched outside-area interest profiles does not alter filtered candidates', async () => {
  for (const cached of [true, false]) {
    const outside = { id: 'outside', display_name: 'Outside city barista', location: 'Orlando, FL' };
    const content = {}, heading = {};
    let lookups = 0;
    const ctx = context({ currentRole: 'cafe_owner_manager', currentUser: { id: 'cafe' }, candidateProfiles: [{ id: 'local', location: 'Miami, FL' }], discoveryProfiles: cached ? { outside } : {},
      document: { getElementById: () => content, querySelector: () => heading },
      activeClient: { from(table) {
        if (table === 'profile_views') return { insert: async () => ({ error: null }) };
        lookups++;
        return { select() { return this; }, eq() { return this; }, maybeSingle: async () => ({ data: outside, error: null }) };
      } },
      bindContentActions() {}, window: { scrollTo() {} }, console,
      alert(message) { throw new Error(message); },
    }, ['openCandidateReliable', 'openCandidate']);
    await ctx.openCandidateReliable('outside');
    assert.match(content.innerHTML, /Outside city barista/);
    assert.equal(ctx.candidateProfiles.length, 1);
    assert.equal(ctx.candidateProfiles[0].id, 'local');
    assert.match(ctx.baristaDiscoveryHtml(), />1 baristas<\/h3>/);
    assert.equal(lookups, cached ? 0 : 1);
  }
});

test('marketplace refresh only rerenders its original unchanged view and never resets a conversation', async () => {
  for (const destination of ['unchanged', 'messages', 'same-section-detail', 'returned-section', 'initial-messages']) {
    const pending = deferred(), navigations = [], content = { firstElementChild: {} };
    const ctx = context({ currentSection: destination === 'initial-messages' ? 'Messages' : 'Discover', currentView: {},
      document: { getElementById: () => content }, loadMarketplaceData: () => pending.promise,
      openSection: section => navigations.push(section), alert(message) { throw new Error(message); },
    }, ['refreshMarketplace']);
    const refreshing = ctx.refreshMarketplace({ disabled: false, textContent: 'Refresh results' });
    if (destination === 'messages') { ctx.currentSection = 'Messages'; content.firstElementChild = {}; }
    if (destination === 'same-section-detail' || destination === 'returned-section') content.firstElementChild = {};
    pending.resolve();
    await refreshing;
    assert.deepEqual(navigations, destination === 'unchanged' ? ['Discover'] : [], destination);
  }
});

test('all dashboard inline scripts and the homepage helper parse', () => {
  for (const [, attributes, body] of dashboard.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)) if (!attributes.includes('src=')) new vm.Script(body);
  new vm.Script(quietFocus);
});
