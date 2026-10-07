import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Browser-only module: no native code, accounts, network, or database writes.
const browser = { window: {} };
vm.runInNewContext(readFileSync(new URL('../us-location.js', import.meta.url), 'utf8'), browser);
const location = browser.window.BaristaMatchLocation;
const states = 'AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY'.split(' ');

test('standalone website geography supports exactly all 50 states and Washington, DC', () => {
  assert.deepEqual(Object.keys(location.US_STATES).sort(), [...states].sort());
  assert.equal(location.normalizeUSState('D.C.'), 'DC');
  assert.equal(location.normalizeUSState('District of Columbia'), 'DC');
  for (const value of ['', 'PR', 'GU', 'VI', 'AS', 'MP', 'ZZ', 'Ontario', 'Canada', 'US']) assert.equal(location.normalizeUSState(value), '');
});

for (const state of states) test(`website ${state}: explicit city/state normalization and state-specific matching`, () => {
  const expected = `Example City, ${state}`;
  for (const value of [`Example City, ${state.toLowerCase()}`, `Example City, ${location.US_STATES[state]}`]) assert.equal(location.normalizeUSLocation(value), expected);
  assert.equal(location.normalizeUSLocation('Example City', state), expected);
  assert.equal(location.normalizeUSLocation(`${expected} 12345-6789`), `${expected} 12345-6789`);
  assert.equal(location.usJobMatchesWorkArea({ location: expected }, { city: 'Example City', state }), true);
  assert.equal(location.usCandidateMatchesCafe({ location: expected }, { location: expected }), true);
  const other = state === 'FL' ? 'NY' : 'FL';
  assert.equal(location.usJobMatchesWorkArea({ location: expected }, { city: 'Example City', state: other }), false);
  assert.equal(location.usCandidateMatchesCafe({ location: expected }, { location: `Example City, ${other}` }), false);
});

test('cities containing state names retain the selected state', () => {
  for (const [city, state] of [['Port Washington', 'NY'], ['New York', 'NY'], ['Washington', 'DC'], ['West New York', 'NJ']]) {
    assert.equal(location.normalizeUSLocation(city, state), `${city}, ${state}`);
    const profile = { location: 'Miami, FL', preferred_city: city, preferred_state: state };
    assert.equal(location.usJobMatchesWorkArea(profile, { city, state }), true);
    assert.equal(location.usJobMatchesWorkArea(profile, { city, state: 'FL' }), false);
  }
});

test('ZIP matching requires the same state and valid ZIP and never falls back to city', () => {
  const profile = { location: 'Brooklyn, NY', preferred_postal_code: '11201' };
  assert.equal(location.usJobMatchesWorkArea(profile, { city: 'New York', state: 'NY', postal_code: '11201-1234' }), true);
  assert.equal(location.usJobMatchesWorkArea(profile, { city: 'Brooklyn', state: 'NY', postal_code: '11202' }), false);
  assert.equal(location.usJobMatchesWorkArea(profile, { city: 'Brooklyn', state: 'FL', postal_code: '11201' }), false);
  assert.equal(location.usJobMatchesWorkArea({ ...profile, preferred_postal_code: '112' }, { state: 'NY', postal_code: '112' }), false);
  assert.equal(location.usCandidateMatchesCafe({ location: 'Brooklyn, NY', cafe_address: '123 Test St, Brooklyn, NY 11201' }, profile), true);
  assert.equal(location.usCandidateMatchesCafe({ location: 'Brooklyn, NY', cafe_address: '123 Test St, Brooklyn, FL 11201' }, profile), false);
  assert.equal(location.usCandidateMatchesCafe({ location: 'Miami, FL', cafe_address: '123 Main St, Miami, FL, 33101' }, {location:'Miami, FL',preferred_postal_code:'33101'}), true);
});

test('legacy Florida city-only profiles still match without rewriting records', () => {
  const profile = { location: 'Miami' }, serialized = JSON.stringify(profile);
  assert.equal(location.usJobMatchesWorkArea(profile, { location: 'Miami, FL 33101' }), true);
  assert.equal(location.usCandidateMatchesCafe(profile, { location: 'Miami' }), true);
  assert.equal(location.usJobMatchesWorkArea(profile, { city: 'Miami', state: 'NY' }), false);
  assert.equal(location.usJobMatchesWorkArea({ preferred_postal_code: '33101' }, { state: 'FL', postal_code: '33101' }), true);
  assert.equal(location.usJobMatchesWorkArea({ location: 'Miami, ZZ', preferred_postal_code: '33101' }, { state: 'FL', postal_code: '33101' }), false);
  assert.equal(JSON.stringify(profile), serialized);
});

test('invalid, unsupported and conflicting locations cannot enter nationwide matching', () => {
  for (const value of ['Miami, ZZ', 'Toronto, ON', 'Miami', 'FL', ', NY', '12345, NY', 'San Juan, PR', 'West Virginia', 'District of Columbia']) assert.equal(location.normalizeUSLocation(value), null);
  assert.equal(location.normalizeUSLocation('Miami, FL', 'NY'), null);
  assert.equal(location.normalizeUSLocation('Miami', 'ZZ'), null);
  assert.equal(location.normalizeUSLocation('FL', 'FL'), null);
  assert.equal(location.usJobMatchesWorkArea({ location: 'Miami, FL', preferred_city: 'Brooklyn, NY', preferred_state: 'FL' }, { city: 'Miami', state: 'FL' }), false);
});

test('signup and dashboard load the standalone geography module before application scripts', () => {
  for (const [file, entry] of [['signup.html', 'function signupDetails'], ['dashboard.html', 'function jobPayloadFromForm']]) {
    const html = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    const position = html.search(/<script src="\/us-location\.js"><\/script>/);
    assert.ok(position >= 0 && position < html.indexOf(entry), file);
  }
});

test('a ZIP suffix cannot hide a conflicting explicit state or become part of the city',()=>{
 assert.equal(location.normalizeUSLocation('Austin TX 78701','NY'),null);
 assert.equal(location.normalizeUSLocation('Austin TX 78701','TX'),'Austin, TX 78701');
 assert.equal(location.normalizeUSLocation('Austin TX 78701-1234','TX'),'Austin, TX 78701-1234');
 assert.equal(location.parseUSLocation('Austin TX 78701').city,'Austin');
 assert.equal(location.parseUSLocation('Austin TX 78701').postal,'78701');
});
