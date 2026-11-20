import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const browser = { window: {} };
for (const file of ['us-location.js', 'marketplace-location-search.js']) {
  vm.runInNewContext(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'), browser);
}
const searchLocation = browser.window.BaristaMatchSearchLocation;
const data = JSON.parse(readFileSync(new URL('../assets/us-postal-centers.json', import.meta.url), 'utf8'));
const index = searchLocation.createIndex(data);
const ids = result => Array.from(result.rows, row => row.id);
const job = (id, city, state, postal_code) => ({ id, city, state, postal_code });

test('postal data covers every supported state and keeps leading-zero ZIPs', () => {
  assert.equal(new Set(data.rows.map(row => row[2])).size, 51);
  assert.ok(index.postals.has('MA:02108'));
  assert.ok(index.postals.has('AK:99501'));
  assert.ok(index.postals.has('HI:96813'));
  assert.ok(index.postals.has('DC:20001'));
  assert.match(data.attribution, /GeoNames/);
});

test('Miami radius includes nearby cities and excludes farther Florida cities', () => {
  const search = searchLocation.resolveSearch(index, { state: 'Florida', place: 'Miami', radius: 25 });
  const rows = [job('far', 'Orlando', 'FL', '32801'), job('near', 'Miami Beach', 'FL', '33139'), job('center', 'Miami', 'FL', '33101')];
  const result = searchLocation.filterResults(index, search, rows, 'barista');
  assert.deepEqual(ids(result), ['center', 'near']);
  assert.equal(search.sameState, true);
  assert.ok(result.distances.get('near') > result.distances.get('center'));
  assert.match(search.label, /Within 25 miles of Miami, FL/);
});

test('a relocation search selects the new state without modifying the profile or rows', () => {
  const profile = { location: 'Miami, FL', preferred_city: 'Miami', preferred_state: 'FL' };
  const before = JSON.stringify(profile);
  const rows = [job('austin', 'Austin', 'TX', '78701'), job('miami', 'Miami', 'FL', '33101')];
  const rowsBefore = JSON.stringify(rows);
  const search = searchLocation.resolveSearch(index, { state: 'TX', place: 'Austin, TX', radius: 25 });
  assert.deepEqual(ids(searchLocation.filterResults(index, search, rows, 'barista')), ['austin']);
  assert.equal(JSON.stringify(profile), before);
  assert.equal(JSON.stringify(rows), rowsBefore);
});

test('same-state searches stay inside state lines and can explicitly include nearby other states', () => {
  const rows = [job('dc', 'Washington', 'DC', '20001'), job('va', 'Arlington', 'VA', '22201')];
  const options = { state: 'DC', place: '20001', radius: 10 };
  assert.deepEqual(ids(searchLocation.filterResults(index, searchLocation.resolveSearch(index, options), rows, 'barista')), ['dc']);
  const search = searchLocation.resolveSearch(index, { ...options, sameState: false });
  assert.deepEqual(new Set(ids(searchLocation.filterResults(index, search, rows, 'barista'))), new Set(['dc', 'va']));
});

test('statewide matching ignores distance and never requires a center dataset', () => {
  const search = searchLocation.resolveSearch(null, { state: 'FL', place: '', radius: 'state', sameState: false });
  const rows = [job('miami', 'Miami', 'FL'), job('orlando', 'Orlando', 'FL'), job('austin', 'Austin', 'TX')];
  assert.deepEqual(ids(searchLocation.filterResults(null, search, rows, 'barista')), ['miami', 'orlando']);
  assert.match(search.label, /Anywhere in Florida/);
});

test('exact city and ZIP searches retain distinct city names and validate state', () => {
  const rows = [job('miami', 'Miami', 'FL', '33101'), job('beach', 'Miami Beach', 'FL', '33139'), job('ohio', 'Miami', 'OH', '45056')];
  const exactCity = searchLocation.resolveSearch(null, { state: 'FL', place: 'Miami', radius: 'city' });
  assert.deepEqual(ids(searchLocation.filterResults(null, exactCity, rows, 'barista')), ['miami']);
  const exactZip = searchLocation.resolveSearch(index, { state: 'FL', place: '33139-1234', radius: 'city' });
  assert.equal(exactZip.postal, '33139');
  assert.deepEqual(ids(searchLocation.filterResults(index, exactZip, rows, 'barista')), ['beach']);
  assert.throws(() => searchLocation.resolveSearch(index, { state: 'TX', place: '33101', radius: 25 }), /selected state/);
  assert.throws(() => searchLocation.resolveSearch(index, { state: 'FL', place: 'Austin, TX', radius: 25 }), /selected state/);
});

test('barista discovery follows preferred work areas, including relocation and legacy profiles', () => {
  const rows = [
    { id: 'moving', location: 'Miami, FL', preferred_city: 'Austin', preferred_state: 'TX', preferred_postal_code: '78701' },
    { id: 'local', location: 'Austin, TX' },
    { id: 'legacy', location: 'Miami' },
    { id: 'florida', location: 'Miami, FL', preferred_city: 'Miami', preferred_state: 'FL' }
  ];
  const texas = searchLocation.resolveSearch(index, { state: 'TX', place: 'Austin', radius: 25 });
  assert.deepEqual(new Set(ids(searchLocation.filterResults(index, texas, rows, 'cafe_owner_manager'))), new Set(['moving', 'local']));
  const florida = searchLocation.resolveSearch(index, { state: 'FL', place: 'Miami', radius: 25 });
  assert.deepEqual(new Set(ids(searchLocation.filterResults(index, florida, rows, 'cafe_owner_manager'))), new Set(['legacy', 'florida']));
});

test('legacy job location strings and structured ZIP+4 coordinates still work', () => {
  const search = searchLocation.resolveSearch(index, { state: 'TX', place: '78701', radius: 10 });
  const rows = [{ id: 'legacy', location: 'Austin, TX 78701' }, job('structured', 'Austin', 'TX', '78701-1234')];
  assert.deepEqual(new Set(ids(searchLocation.filterResults(index, search, rows, 'barista'))), new Set(['legacy', 'structured']));
});

test('unknown coordinates are counted and excluded instead of claiming a false distance', () => {
  const search = searchLocation.resolveSearch(index, { state: 'FL', place: '33101', radius: 25 });
  const result = searchLocation.filterResults(index, search, [job('unknown-city', 'Unknownville', 'FL'), job('unknown-zip', 'Miami', 'FL', '00000')], 'barista');
  assert.deepEqual(ids(result), []);
  assert.equal(result.unlocatedCount, 2);
  assert.equal(result.distances.size, 0);
  assert.throws(() => searchLocation.resolveSearch(index, { state: 'FL', place: 'Unknownville', radius: 25 }), /nearby ZIP/);
});

test('ambiguous city names within one state require a ZIP for radius search', () => {
  const ambiguous = searchLocation.createIndex({ rows: [
    ['12345', 'Example', 'NY', 40, -74], ['12346', 'Example', 'NY', 44, -74]
  ] });
  assert.throws(() => searchLocation.resolveSearch(ambiguous, { state: 'NY', place: 'Example', radius: 25 }), /nearby ZIP/);
  assert.equal(searchLocation.resolveSearch(ambiguous, { state: 'NY', place: '12345', radius: 25 }).postal, '12345');
});

test('unsupported states and arbitrary distances cannot broaden the search', () => {
  for (const state of ['PR', 'ZZ', 'Canada', '']) assert.throws(() => searchLocation.resolveSearch(index, { state, place: 'Miami', radius: 25 }), /U.S. state/);
  for (const radius of [0, 5, 2000, 'all', Infinity]) assert.throws(() => searchLocation.resolveSearch(index, { state: 'FL', place: 'Miami', radius }), /distance/);
});
