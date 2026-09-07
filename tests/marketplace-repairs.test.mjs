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
  const home = ctx.window.BaristaMatchQuietFocus.render({ role: 'barista', profile: ctx.currentProfile, marketJobs: ctx.marketJobs, applications: [], discoveryInterests: ctx.discoveryInterests, discoveryMatches: [], notificationRows: [], profileStrength: 100 });
  assert.match(home, /<strong>1<\/strong><b>Applications &amp; interests/);
  assert.match(home, /data-view-job="job-1"/);
  assert.match(home, /data-view-job="job-2"/);
  assert.doesNotMatch(home, /Best match for you/);
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

test('all dashboard inline scripts and the homepage helper parse', () => {
  for (const [, attributes, body] of dashboard.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)) if (!attributes.includes('src=')) new vm.Script(body);
  new vm.Script(quietFocus);
});
