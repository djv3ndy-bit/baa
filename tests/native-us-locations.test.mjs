import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { loadTypescript, plain } from './approved-update/load-typescript.mjs';

const location = loadTypescript('mobile/lib/usLocation.ts');
const { jobPayload, draftFromJob, blankJobDraft } = loadTypescript('mobile/lib/jobEditor.ts', { './usLocation': location });
const { buildProfileUpdate } = loadTypescript('mobile/lib/profilePrivacy.ts', { './usLocation': location });
const browser = { window: {} };
vm.runInNewContext(readFileSync(new URL('../us-location.js', import.meta.url), 'utf8'), browser);
const states = 'AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY'.split(' ');
const draft = { ...plain(blankJobDraft), title: 'Test barista role', address1: '123 Test Street', city: 'Example City', postalCode: '12345', hourlyPay: '20', maximumPay: '24', skills: 'Espresso', description: 'Synthetic test role' };

test('exactly the 50 states and Washington, DC are supported', () => {
  assert.deepEqual(Object.keys(location.US_STATES).sort(), [...states].sort());
  assert.equal(location.normalizeUSState('D.C.'), 'DC');
  for (const value of ['', 'PR', 'GU', 'VI', 'AS', 'MP', 'ZZ', 'Ontario', 'Canada', 'US']) assert.equal(location.normalizeUSState(value), '');
});

for (const state of states) test(`${state}: signup location, both profile roles, jobs and local matching use the selected state`, () => {
  const expected = `Example City, ${state}`;
  for (const lib of [location, browser.window.BaristaMatchLocation]) {
    assert.equal(lib.normalizeUSLocation(`Example City, ${state.toLowerCase()}`), expected);
    assert.equal(lib.normalizeUSLocation(`Example City, ${location.US_STATES[state]}`), expected);
    assert.equal(lib.normalizeUSLocation('Example City', state), expected);
    assert.equal(lib.usJobMatchesWorkArea({ location: expected }, { city: 'Example City', state }), true);
    assert.equal(lib.usCandidateMatchesCafe({ location: expected }, { location: expected }), true);
    const other = state === 'FL' ? 'NY' : 'FL';
    assert.equal(lib.usJobMatchesWorkArea({ location: expected }, { city: 'Example City', state: other }), false);
    assert.equal(lib.usCandidateMatchesCafe({ location: expected }, { location: `Example City, ${other}` }), false);
  }
  for (const role of ['barista', 'cafe_owner_manager']) {
    const payload = buildProfileUpdate({ role, location: 'Miami, FL', date_of_birth: '2000-01-01', visible_to_cafes: false }, role, { locationCity: 'Example City', locationState: state, availability: [], availabilityNotes: '', openHours: '' });
    assert.equal(payload.location, expected);
    assert.equal(payload.visible_to_cafes, false);
    if (role === 'barista') assert.equal(payload.preferred_state, state);
  }
  const job = jobPayload({ ...draft, state: state.toLowerCase() }, ['Weekdays'], 'test-owner');
  assert.equal(job.state, state);
  assert.equal(job.location, `${expected} 12345`);
  assert.equal(draftFromJob(job).state, state);
  assert.equal(job.owner_id, 'test-owner');
});

test('city names that contain a state name keep their explicit selected state', () => {
  for (const [city, state] of [['Port Washington', 'NY'], ['New York', 'NY'], ['Washington', 'DC'], ['West New York', 'NJ']]) {
    assert.equal(location.normalizeUSLocation(city, state), `${city}, ${state}`);
    const profile = { location: 'Miami, FL', preferred_city: city, preferred_state: state };
    assert.equal(location.usJobMatchesWorkArea(profile, { city, state }), true);
    assert.equal(location.usJobMatchesWorkArea(profile, { city, state: 'FL' }), false);
  }
});

test('ZIP matching still requires the same state and valid ZIP; it does not broaden city matching', () => {
  const profile = { location: 'Brooklyn, NY', preferred_postal_code: '11201' };
  assert.equal(location.usJobMatchesWorkArea(profile, { city: 'New York', state: 'NY', postal_code: '11201-1234' }), true);
  assert.equal(location.usJobMatchesWorkArea(profile, { city: 'Brooklyn', state: 'NY', postal_code: '11202' }), false);
  assert.equal(location.usJobMatchesWorkArea(profile, { city: 'Brooklyn', state: 'FL', postal_code: '11201' }), false);
  assert.equal(location.usJobMatchesWorkArea({ ...profile, preferred_postal_code: '112' }, { state: 'NY', postal_code: '112' }), false);
  assert.equal(location.usCandidateMatchesCafe({ location: 'Brooklyn, NY', cafe_address: '123 Test St, Brooklyn, NY 11201' }, profile), true);
  assert.equal(location.usCandidateMatchesCafe({ location: 'Brooklyn, NY', cafe_address: '123 Test St, Brooklyn, FL 11201' }, profile), false);
});

test('legacy Florida city-only profiles and structured jobs keep working without rewriting their records', () => {
  assert.equal(location.usJobMatchesWorkArea({ location: 'Miami' }, { location: 'Miami, FL 33101' }), true);
  assert.equal(location.usCandidateMatchesCafe({ location: 'Miami' }, { location: 'Miami' }), true);
  assert.equal(location.usJobMatchesWorkArea({ preferred_postal_code: '33101' }, { state: 'FL', postal_code: '33101' }), true);
  assert.equal(location.usJobMatchesWorkArea({ location: 'Miami, ZZ', preferred_postal_code: '33101' }, { state: 'FL', postal_code: '33101' }), false);
  assert.equal(draftFromJob({ location: 'Seattle, WA, 98101', title: 'Existing role' }).state, 'WA');
  assert.equal(draftFromJob({ location: 'Miami', title: 'Legacy role' }).state, '');
});

test('unsupported states, conflicting state fields and missing cities cannot be submitted', () => {
  for (const value of ['Miami, ZZ', 'Toronto, ON', 'Miami', 'FL', ', NY', '12345, NY']) assert.equal(location.normalizeUSLocation(value), null);
  assert.equal(location.normalizeUSLocation('Miami, FL', 'NY'), null);
  assert.equal(location.normalizeUSLocation('Miami', 'ZZ'), null);
  assert.equal(location.normalizeUSLocation('FL', 'FL'), null);
  for (const state of ['', 'PR', 'ZZ']) {
    assert.throws(() => jobPayload({ ...draft, state }, ['Weekdays'], 'test'), /U.S. state/);
    assert.throws(() => buildProfileUpdate({}, 'cafe_owner_manager', { locationCity: 'Miami', locationState: state, availability: [], availabilityNotes: '', openHours: '' }), /U.S. state/);
  }
  assert.equal(location.usJobMatchesWorkArea({ location: 'Miami, FL', preferred_city: 'Brooklyn, NY', preferred_state: 'FL' }, { city: 'Miami', state: 'FL' }), false);
});


test('native parsing stays compatible with the deployed website ZIP and state-name fixes', () => {
  for (const lib of [location, browser.window.BaristaMatchLocation]) {
    assert.equal(lib.normalizeUSLocation('Austin TX 78701', 'NY'), null);
    assert.equal(lib.normalizeUSLocation('Austin TX 78701-1234', 'TX'), 'Austin, TX 78701-1234');
    assert.equal(lib.normalizeUSLocation('West Virginia'), null);
    assert.equal(lib.normalizeUSLocation('District of Columbia'), null);
    assert.equal(lib.usCandidateMatchesCafe({ location: 'Miami, FL', cafe_address: '123 Main St, Miami, FL, 33101' }, { location: 'Miami, FL', preferred_postal_code: '33101' }), true);
  }
});

test('saving other profile fields preserves a stored ZIP only for an unchanged home city and state', () => {
  const profile = { location: 'Brooklyn, NY 11201-1234' };
  const options = { locationCity: 'Brooklyn', locationState: 'NY', availability: [], availabilityNotes: '', openHours: '' };
  assert.equal(buildProfileUpdate(profile, 'cafe_owner_manager', options).location, profile.location);
  assert.equal(buildProfileUpdate(profile, 'cafe_owner_manager', { ...options, locationCity: 'Albany' }).location, 'Albany, NY');
  assert.equal(buildProfileUpdate(profile, 'cafe_owner_manager', { ...options, locationState: 'CT' }).location, 'Brooklyn, CT');
  assert.equal(buildProfileUpdate(profile, 'cafe_owner_manager', { ...options, locationCity: 'Brooklyn 11202' }).location, 'Brooklyn, NY 11202');
});


test('job city input is canonicalized and conflicts never produce malformed saved locations', () => {
  const base = { ...draft, state: 'NY', postalCode: '11050' };
  const result = jobPayload({ ...base, city: 'Port Washington, NY' }, ['Weekdays'], 'test');
  assert.equal(result.city, 'Port Washington');
  assert.equal(result.location, 'Port Washington, NY 11050');
  assert.throws(() => jobPayload({ ...base, city: 'Miami, FL' }, ['Weekdays'], 'test'), /matches the selected/);
  assert.throws(() => jobPayload({ ...base, city: 'Port Washington, NY 10001' }, ['Weekdays'], 'test'), /matches the selected/);
  assert.throws(() => jobPayload({ ...base, city: '12345' }, ['Weekdays'], 'test'), /matches the selected/);
  assert.equal(draftFromJob({ location: 'Port Washington, NY 11050' }).city, 'Port Washington');
  assert.equal(draftFromJob({ location: 'Miami', state: 'FL' }).city, 'Miami');
});


test('explicit state selection accepts city words such as Santa Fe without relaxing state conflicts', () => {
  for (const [city, state] of [['Santa Fe', 'NM'], ['Rancho Santa Fe', 'CA'], ['La Grange', 'TX']]) {
    assert.equal(location.normalizeUSLocation(city, state), `${city}, ${state}`);
    assert.equal(location.usJobMatchesWorkArea({ preferred_city: city, preferred_state: state }, { city, state }), true);
  }
  assert.equal(location.normalizeUSLocation('Seattle WA', 'NY'), null);
  assert.equal(location.normalizeUSLocation('Santa Fe, ZZ', 'NM'), null);
  assert.equal(location.normalizeUSLocation('Santa Fe', 'ZZ'), null);
});
