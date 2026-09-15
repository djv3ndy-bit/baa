import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTypescript, plain } from './load-typescript.mjs';
const model = loadTypescript('mobile/features/approved-dashboard/model.ts');

test('café and barista primary actions preserve their existing role destinations', () => {
  assert.equal(model.dashboardLinks('cafe_owner_manager').primary.pathname, '/post-job');
  assert.equal(model.dashboardLinks('cafe_owner_manager').jobs.pathname, '/jobs');
  assert.equal(model.dashboardLinks('barista').primary.pathname, '/discover');
  assert.deepEqual(plain(model.dashboardLinks('barista').sent), { pathname: '/discover', params: { tab: 'sent' } });
});
test('specific job IDs are retained for management and discovery', () => {
  assert.deepEqual(plain(model.jobDestination('barista', 'job-a')), { pathname: '/discover', params: { jobId: 'job-a' } });
  assert.deepEqual(plain(model.jobDestination('cafe_owner_manager', 'job-b')), { pathname: '/post-job', params: { jobId: 'job-b' } });
});
test('matching systems never exchange their conversation identifiers', () => {
  for (const kind of ['application', 'discovery']) assert.deepEqual(plain(model.matchDestination({ kind, id: 'match-a' })), { pathname: '/chat/[id]', params: { id: 'match-a', kind } });
});
test('unread text does not suggest an obligation to reply', () => {
  assert.equal(model.unreadLabel(1), '1 unread message');
  assert.equal(model.unreadLabel(2), '2 unread messages');
  assert.equal(model.unreadLabel(0), '0 unread messages');
});
test('large counts are compact while invalid counts never display NaN', () => {
  assert.equal(model.countLabel(12000), '12K');
  assert.equal(model.countLabel(9999), '9999');
  assert.equal(model.countLabel(NaN), '0');
  assert.equal(model.countLabel(-1), '0');
});
test('raw backend errors and secrets do not reach dashboard copy', () => {
  assert.doesNotMatch(model.safeDashboardError({ message: 'SQL secret details' }), /SQL|secret/);
  assert.match(model.safeDashboardError({ status: 401 }), /Sign in again/);
  assert.match(model.safeDashboardError({ status: 403 }), /cannot access/);
});

function dataHarness(role, options = {}) {
  const calls = [], id = 'own-account';
  const ownedJob = { id: 'own-job', owner_id: id, title: 'Actual role', active: true, city: 'Saved city' };
  const elsewhere = { id: 'elsewhere-job', owner_id: 'another-account', title: 'Elsewhere', active: true, city: 'Other city' };
  const client = { from(table) {
    const call = { table, filters: [] }; calls.push(call);
    const q = { select(fields) { call.fields = fields; return q; }, eq(key, value) { call.filters.push([key, value]); return q; }, order() { return q; }, maybeSingle: async () => ({ data: { date_of_birth: '1990-01-01' }, error: null }),
      rows() { if (table === 'jobs') return [ownedJob, elsewhere].filter(row => call.filters.every(([key, value]) => row[key] === value)); if (table === 'discovery_matches') return []; throw Error(table); } };
    return q;
  } };
  const loader = loadTypescript('mobile/features/approved-dashboard/loadDashboard.ts', {
    '../../lib/supabase': { supabase: client },
    '../../lib/session': { getCurrentContext: async () => options.loggedOut ? { user: null } : { user: { id }, role, profile: { id, role } }, requireCurrentUser: async value => { assert.equal(value, id); if (options.switched) throw Error('Account changed'); } },
    '../../lib/homeSummary': { loadHomeSummary: async () => ({ jobs: 1, applications: 2, matches: 1, messages: 0, alerts: 0, candidates: 0 }) },
    '../../lib/marketplace': { JOB_FIELDS: 'id,owner_id', readAllRows: async factory => factory().rows(), loadApplications: async () => [
      { id: 'pending-a', status: 'interested', job: ownedJob, barista_id: 'barista-a' },
      { id: 'matched-a', status: 'matched', job: ownedJob, barista_id: 'barista-a' },
    ], readProfiles: async () => ({ 'barista-a': { display_name: 'Account profile name' }, [id]: { cafe_name: 'Account café name' } }) },
    '../../lib/floridaLocation': { jobMatchesWorkArea: (_profile, job) => job.city === 'Saved city', workAreaLabel: () => 'Saved city' },
    '../../lib/profilePrivacy': { getProfileReadiness: () => ({ missing: [] }) },
    '../../lib/messaging': { withMessageDeadline: promise => Promise.resolve(promise) },
  });
  return { ...loader, calls };
}
test('café dashboard queries only owned jobs and uses confirmed matches', async () => {
  const h = dataHarness('cafe_owner_manager'); const data = await h.loadDashboard();
  assert.deepEqual(plain(data.jobs.map(job => job.id)), ['own-job']);
  assert.deepEqual(plain(data.matches.map(match => match.id)), ['matched-a']);
  assert.equal(data.matches[0].name, 'Account profile name');
  assert.ok(h.calls.find(call => call.table === 'jobs').filters.some(([key, value]) => key === 'owner_id' && value === 'own-account'));
});
test('barista dashboard keeps the existing geographic filter and uses actual café names', async () => {
  const h = dataHarness('barista'); const data = await h.loadDashboard();
  assert.deepEqual(plain(data.jobs.map(job => job.id)), ['own-job']);
  assert.equal(data.jobs[0].owner.cafe_name, 'Account café name');
  assert.equal(data.matches[0].name, 'Account café name');
});
test('expired session routes to login instead of rendering invented counts', async () => {
  const h = dataHarness('barista', { loggedOut: true });
  await assert.rejects(h.loadDashboard(), error => error.destination === '/login');
  assert.equal(h.calls.length, 0);
});
test('account change during dashboard load prevents returning another account’s data', async () => {
  await assert.rejects(dataHarness('barista', { switched: true }).loadDashboard(), /Account changed/);
});
