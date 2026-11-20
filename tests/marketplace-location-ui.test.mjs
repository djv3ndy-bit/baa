import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const dashboard = fs.readFileSync(new URL('../dashboard.html', import.meta.url), 'utf8');
const postalData = { rows: [
  ['33101', 'Miami', 'FL', 25.774, -80.194],
  ['33139', 'Miami Beach', 'FL', 25.79, -80.13],
  ['32801', 'Orlando', 'FL', 28.542, -81.379],
  ['78701', 'Austin', 'TX', 30.267, -97.743],
  ['10001', 'New York', 'NY', 40.75, -73.997]
] };

function source(name) {
  const start = dashboard.search(new RegExp(`^(?:async )?function ${name}\\(`, 'm'));
  assert.ok(start >= 0, `Dashboard function ${name} exists`);
  const tail = dashboard.slice(start);
  const next = tail.slice(1).search(/\n(?=(?:async )?function |Object\.defineProperty|let activeMessageApplicationId|document\.)/);
  return next < 0 ? tail : tail.slice(0, next + 1);
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const jobs = [
  { id: 'miami', city: 'Miami', state: 'FL', postal_code: '33101', owner: { cafe_name: 'Miami Café' } },
  { id: 'beach', city: 'Miami Beach', state: 'FL', postal_code: '33139', owner: { cafe_name: 'Beach Café' } },
  { id: 'orlando', city: 'Orlando', state: 'FL', postal_code: '32801', owner: { cafe_name: 'Orlando Café' } },
  { id: 'austin', city: 'Austin', state: 'TX', postal_code: '78701', owner: { cafe_name: 'Austin Café' } }
];
const candidates = [
  { id: 'miami', location: 'Miami, FL' },
  { id: 'beach', location: 'Miami Beach, FL' },
  { id: 'moving', location: 'Miami, FL', preferred_city: 'Austin', preferred_state: 'TX' }
];
const ids = rows => Array.from(rows, row => row.id);

function harness(overrides = {}) {
  const requests = [], navigations = [];
  const button = { disabled: false }, status = { textContent: '' }, reset = {};
  const form = {
    elements: {
      search_state: { value: 'FL' }, search_place: { value: 'Miami' },
      search_radius: { value: 'city' }, search_same_state: { checked: true }
    },
    querySelector(selector) {
      return selector === '[type="submit"]' ? button : selector === '#marketplace-location-status' ? status : null;
    }
  };
  let visibleForm = form;
  const ctx = {
    window: {}, AbortSignal, currentRole: 'barista', currentUser: { id: 'account-1' }, currentProfile: { location: 'Miami, FL' },
    currentSection: 'Discover', currentView: {}, availableMarketJobs: structuredClone(jobs), availableCandidateProfiles: structuredClone(candidates),
    marketJobs: [], candidateProfiles: [], marketplaceLocationSearch: null, marketplaceLocationIndex: null,
    marketplaceLocationIndexPromise: null, marketplaceLocationRequest: 0, marketplaceTextQuery: '', marketplaceUnlocatedCount: 0,
    marketplaceLocationDistances: new Map(), discoveryInterests: [], discoveryMatches: [], discoveryProfiles: {},
    activeClient: { from() { throw new Error('Changing a search must not write or read profile records.'); } },
    fetch: async url => {
      requests.push(url);
      assert.equal(url, '/assets/us-postal-centers.json');
      return { ok: true, json: async () => postalData };
    },
    document: { getElementById: id => id === 'marketplace-location-form' ? visibleForm : null },
    openSection: (...args) => navigations.push(args),
    ...overrides
  };
  vm.createContext(ctx);
  for (const file of ['us-location.js', 'marketplace-location-search.js']) {
    vm.runInContext(fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'), ctx);
  }
  const functions = ['normalizePlace', 'floridaPlaceParts', 'workArea', 'workAreaLabel', 'escapeHtml',
    'jobMatchesBaristaLocation', 'candidateMatchesCafeLocation', 'defaultMarketplaceLocation', 'marketplaceLocationFormHtml',
    'loadMarketplaceLocationIndex', 'applyMarketplaceLocation', 'resetMarketplaceLocation', 'clearMarketplaceSearchSession',
    'bindMarketplaceLocationForm', 'bindMarketplaceSearch', 'discoveryState', 'discoveryButton', 'incomingInterestsHtml'];
  vm.runInContext(functions.map(source).join('\n'), ctx);
  const content = { querySelector: selector => selector === '#marketplace-location-form' ? form : selector === '[data-reset-search-area]' ? reset : null };
  ctx.applyMarketplaceLocation();
  ctx.bindMarketplaceLocationForm(content);
  return {
    ctx, form, button, status, reset, requests, navigations,
    detach: () => { visibleForm = null; },
    submit(options = {}) {
      const fields = form.elements;
      for (const [name, value] of Object.entries(options)) {
        const field = fields[`search_${name}`];
        if (name === 'same_state') field.checked = value;
        else field.value = String(value);
      }
      return form.onsubmit({ preventDefault() {} });
    }
  };
}

test('the actual location form broadens cached jobs by miles and applies relocation without profile writes', async () => {
  const h = harness(), profileBefore = JSON.stringify(h.ctx.currentProfile), sourceBefore = JSON.stringify(h.ctx.availableMarketJobs);
  assert.deepEqual(ids(h.ctx.marketJobs), ['miami']);
  await h.submit({ radius: 25 });
  assert.deepEqual(ids(h.ctx.marketJobs), ['miami', 'beach']);
  assert.equal(h.requests.length, 1);
  assert.ok(h.ctx.marketplaceLocationDistances.has('beach'));
  await h.submit({ state: 'TX', place: 'Austin', radius: 25 });
  assert.deepEqual(ids(h.ctx.marketJobs), ['austin']);
  assert.equal(h.ctx.marketplaceLocationSearch.state, 'TX');
  assert.equal(h.requests.length, 1, 'subsequent searches reuse the loaded index');
  assert.equal(JSON.stringify(h.ctx.currentProfile), profileBefore);
  assert.equal(JSON.stringify(h.ctx.availableMarketJobs), sourceBefore);
  assert.equal(h.button.disabled, false);
});

test('café location searches use preferred work areas while retaining owner jobs and cached candidates', async () => {
  const h = harness({ currentRole: 'cafe_owner_manager', marketJobs: [{ id: 'owned-job' }] });
  const candidatesBefore = JSON.stringify(h.ctx.availableCandidateProfiles);
  assert.deepEqual(ids(h.ctx.candidateProfiles), ['miami']);
  await h.submit({ state: 'TX', place: 'Austin', radius: 25 });
  assert.deepEqual(ids(h.ctx.candidateProfiles), ['moving']);
  assert.deepEqual(ids(h.ctx.marketJobs), ['owned-job']);
  assert.equal(JSON.stringify(h.ctx.availableCandidateProfiles), candidatesBefore);
});

test('statewide and exact-city searches work without fetching the miles dataset', async () => {
  const h = harness();
  await h.submit({ radius: 'state', state: 'FL', place: '' });
  assert.deepEqual(ids(h.ctx.marketJobs), ['miami', 'beach', 'orlando']);
  assert.equal(h.requests.length, 0);
  await h.submit({ radius: 'city', state: 'TX', place: 'Austin' });
  assert.deepEqual(ids(h.ctx.marketJobs), ['austin']);
  assert.equal(h.requests.length, 0);
  h.form.elements.search_radius.value = 'state';
  h.form.elements.search_radius.onchange();
  assert.equal(h.form.elements.search_place.disabled, true);
  assert.equal(h.form.elements.search_place.required, false);
});

test('invalid locations and failed data loads preserve the last successful results', async () => {
  const h = harness();
  await h.submit({ state: 'TX', place: 'Austin', radius: 'city' });
  const selection = h.ctx.marketplaceLocationSearch;
  await h.submit({ state: 'ZZ', place: 'Miami', radius: 'city' });
  assert.equal(h.ctx.marketplaceLocationSearch, selection);
  assert.deepEqual(ids(h.ctx.marketJobs), ['austin']);
  assert.match(h.status.textContent, /U.S. state/);
  assert.equal(h.button.disabled, false);
  h.ctx.fetch = async () => ({ ok: false });
  await h.submit({ state: 'FL', place: 'Miami', radius: 25 });
  assert.equal(h.ctx.marketplaceLocationSearch, selection);
  assert.deepEqual(ids(h.ctx.marketJobs), ['austin']);
  assert.match(h.status.textContent, /temporarily unavailable/);
  assert.equal(h.ctx.marketplaceLocationIndexPromise, null, 'a failed load remains retryable');
});

test('Reset returns to the current profile work area and clears temporary text and distances', async () => {
  const h = harness();
  await h.submit({ state: 'TX', place: 'Austin', radius: 25 });
  h.ctx.marketplaceTextQuery = 'espresso';
  h.ctx.currentProfile = { location: 'Miami, FL', preferred_city: 'Miami Beach', preferred_state: 'FL' };
  h.reset.onclick();
  assert.equal(h.ctx.marketplaceLocationSearch, null);
  assert.equal(h.ctx.marketplaceTextQuery, '');
  assert.equal(h.ctx.marketplaceLocationDistances.size, 0);
  assert.deepEqual(ids(h.ctx.marketJobs), ['beach']);
  assert.equal(h.ctx.defaultMarketplaceLocation().place, 'miami beach');
  assert.deepEqual(Array.from(h.navigations.at(-1)).slice(0, 1), ['Discover']);
});

test('an in-flight miles search cannot override Reset or a newer successful search', async () => {
  for (const operation of ['reset', 'new-search']) {
    const h = harness(), pending = deferred();
    h.ctx.loadMarketplaceLocationIndex = () => pending.promise;
    const waiting = h.submit({ state: 'TX', place: 'Austin', radius: 25 });
    if (operation === 'reset') h.reset.onclick();
    else await h.submit({ state: 'FL', place: '', radius: 'state' });
    pending.resolve(h.ctx.window.BaristaMatchSearchLocation.createIndex(postalData));
    await waiting;
    if (operation === 'reset') {
      assert.equal(h.ctx.marketplaceLocationSearch, null);
      assert.deepEqual(ids(h.ctx.marketJobs), ['miami']);
    } else {
      assert.equal(h.ctx.marketplaceLocationSearch.radius, 'state');
      assert.deepEqual(ids(h.ctx.marketJobs), ['miami', 'beach', 'orlando']);
    }
  }
});

test('account switch clears cached results and suppresses stale search completion and errors', async () => {
  for (const outcome of ['resolve', 'reject']) {
    const h = harness(), pending = deferred();
    h.ctx.loadMarketplaceLocationIndex = () => pending.promise;
    const waiting = h.submit({ state: 'TX', place: 'Austin', radius: 25 });
    h.ctx.clearMarketplaceSearchSession();
    h.ctx.currentUser = { id: 'account-2' };
    h.ctx.marketplaceTextQuery = 'new account query';
    h.detach();
    const oldStatus = h.status.textContent;
    if (outcome === 'resolve') pending.resolve(h.ctx.window.BaristaMatchSearchLocation.createIndex(postalData));
    else pending.reject(new Error('old account error'));
    await waiting;
    assert.equal(h.ctx.marketplaceLocationSearch, null);
    assert.equal(h.ctx.marketplaceTextQuery, 'new account query');
    for (const key of ['marketJobs', 'candidateProfiles', 'availableMarketJobs', 'availableCandidateProfiles']) assert.equal(h.ctx[key].length, 0, key);
    assert.equal(h.status.textContent, oldStatus, 'stale errors never alter the detached account form');
    assert.equal(h.navigations.length, 0);
  }
});

test('leaving the search form suppresses its pending location change', async () => {
  const h = harness(), pending = deferred();
  h.ctx.loadMarketplaceLocationIndex = () => pending.promise;
  const waiting = h.submit({ state: 'TX', place: 'Austin', radius: 25 });
  h.ctx.currentSection = 'Matches';
  h.detach();
  pending.resolve(h.ctx.window.BaristaMatchSearchLocation.createIndex(postalData));
  await waiting;
  assert.equal(h.ctx.marketplaceLocationSearch, null);
  assert.deepEqual(ids(h.ctx.marketJobs), ['miami']);
  assert.equal(h.navigations.length, 0);
});

function textSearchContent() {
  const search = { value: '', focus() {} }, count = { dataset: { resultNoun: 'jobs' } }, empty = {}, clear = {};
  const rows = [{ dataset: { search: 'espresso trainer' } }, { dataset: { search: 'lead barista' } }];
  const elements = { '#job-search': search, '#marketplace-result-count': count, '#marketplace-search-empty': empty, '[data-clear-market-search]': clear };
  return { search, count, empty, clear, rows, querySelector: selector => elements[selector], querySelectorAll: () => rows };
}

test('text and location selections survive section navigation and rebinding', async () => {
  const h = harness();
  await h.submit({ state: 'TX', place: 'Austin', radius: 'city' });
  const firstView = textSearchContent();
  h.ctx.bindMarketplaceSearch(firstView);
  firstView.search.value = 'espresso';
  firstView.search.oninput();
  const selection = h.ctx.marketplaceLocationSearch;
  const content = { innerHTML: '' }, heading = {};
  h.ctx.messageRealtimeChannel = null;
  h.ctx.sectionPages = {};
  h.ctx.matchesHtml = () => '<p>Matches</p>';
  h.ctx.jobsHtml = () => h.ctx.marketplaceLocationFormHtml();
  h.ctx.bindContentActions = () => {};
  h.ctx.markSectionNotificationsRead = () => {};
  h.ctx.window.BaristaMatchQuietFocus = { menuLabel: name => name, syncMobileNav() {} };
  h.ctx.window.scrollTo = () => {};
  h.ctx.document = {
    querySelectorAll: () => [], querySelector: selector => selector === '.top h1' ? heading : null,
    getElementById: id => id === 'content' ? content : null
  };
  vm.runInContext(source('openSection'), h.ctx);
  h.ctx.openSection('Matches', {}, 'barista');
  h.ctx.openSection('Discover', {}, 'barista');
  assert.equal(h.ctx.marketplaceLocationSearch, selection);
  assert.equal(h.ctx.marketplaceTextQuery, 'espresso');
  assert.match(content.innerHTML, /value="TX" selected/);
  assert.match(content.innerHTML, /value="Austin"/);
  const returningView = textSearchContent();
  h.ctx.bindMarketplaceSearch(returningView);
  assert.equal(returningView.search.value, 'espresso');
  assert.equal(returningView.rows[1].hidden, true);
  assert.equal(returningView.count.textContent, '1 of 2 jobs');
});

test('incoming interests and mutual matches remain intact when their location is outside the applied area', async () => {
  const h = harness({
    discoveryInterests: [{ id: 'interest', sender_id: 'outside-cafe', target_id: 'account-1' }],
    discoveryMatches: [{ id: 'match', barista_id: 'account-1', cafe_id: 'matched-cafe' }],
    discoveryProfiles: { 'outside-cafe': { id: 'outside-cafe', cafe_name: 'New York Café', location: 'New York, NY' } }
  });
  const interestsBefore = JSON.stringify(h.ctx.discoveryInterests), matchesBefore = JSON.stringify(h.ctx.discoveryMatches);
  await h.submit({ state: 'TX', place: 'Austin', radius: 25 });
  assert.equal(JSON.stringify(h.ctx.discoveryInterests), interestsBefore);
  assert.equal(JSON.stringify(h.ctx.discoveryMatches), matchesBefore);
  assert.match(h.ctx.incomingInterestsHtml(), /New York Café/);
  assert.match(h.ctx.incomingInterestsHtml(), /data-discovery-interest="outside-cafe"/);
  assert.match(h.ctx.incomingInterestsHtml(), /Match back/);
});
