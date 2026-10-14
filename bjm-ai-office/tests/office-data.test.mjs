import assert from 'node:assert/strict';
import test from 'node:test';
import { createOfficeProviders } from '../server/office-data.mjs';

const env = { SUPABASE_URL: 'https://project.example', SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test', BJM_PUBLIC_URL: 'https://website.example' };
const now = () => 1800000000000;
const snapshot = (extra = {}) => ({ schema_version: 1, generated_at: new Date(now()).toISOString(),
  metrics: { profiles: 3, cafes: 1, baristas: 2, jobs: 4, applications: 5, subscriptions: 2, payments: 3 },
  support: { total_recent: 2, open: 1 }, billing: { subscriptions: { total: 2, active: 1, past_due: 0, canceling: 0 }, payments: { recent: 3, failed: 0, refunded: 0 } }, ...extra });
const token = 'SYNTHETIC.TOKEN.SIGNATURE';
const provider = (fetchImpl, extra = {}) => createOfficeProviders(token, { env, now, fetchImpl, ...extra });
const fakeFetch = (data = snapshot()) => async (_url, init) => init.method === 'HEAD' ? new Response(null, { status: 200 }) : Response.json(data);

test('one aggregate-only request is shared across five views, token remains in request headers', async () => {
  const calls = [];
  const api = provider(async (url, init) => { calls.push([url, init]); return fakeFetch()(url, init); });
  const results = await Promise.all([api.getLiveOverview(), api.getSupportSummary(), api.getBillingSummary(), api.getSystemHealth(), api.getDecisionSignals()]);
  const rpc = calls.filter(([, init]) => init.method === 'POST');
  assert.equal(rpc.length, 1);
  assert.equal(rpc[0][0], 'https://project.example/rest/v1/rpc/office_read_snapshot');
  assert.equal(rpc[0][1].headers.apikey, env.SUPABASE_PUBLISHABLE_KEY);
  assert.equal(rpc[0][1].headers.Authorization, `Bearer ${token}`);
  assert.equal(rpc[0][1].body, '{}'); assert.equal(rpc[0][1].redirect, 'error'); assert.equal(rpc[0][1].cache, 'no-store');
  assert.doesNotMatch(JSON.stringify(results), /SYNTHETIC|publishable|Authorization|session_id/);
  assert.equal(results[0].availability, 'available'); assert.equal(results[2].subscriptions.past_due, 0);
});

test('separate requests never reuse another token or cached business snapshot', async () => {
  const calls = [];
  const fetchImpl = async (_url, init) => { calls.push(init.headers.Authorization); return Response.json(snapshot({ metrics: { profiles: calls.length } })); };
  const first = provider(fetchImpl);
  const second = createOfficeProviders('OTHER.TOKEN.SIGNATURE', { env, now, fetchImpl });
  assert.equal((await first.getLiveOverview()).metrics.profiles, 1);
  assert.equal((await second.getLiveOverview()).metrics.profiles, 2);
  assert.deepEqual(calls, [`Bearer ${token}`, 'Bearer OTHER.TOKEN.SIGNATURE']);
});

for (const status of [401, 403, 404, 429, 500, 503]) {
  test(`HTTP ${status} is unavailable, never zero or leaked provider detail`, async () => {
    const api = provider(async () => new Response('private_customer_payload', { status }));
    const [overview, billing, support] = await Promise.all([api.getLiveOverview(), api.getBillingSummary(), api.getSupportSummary()]);
    assert.equal(overview.availability, 'unavailable');
    assert.ok(Object.values(overview.metrics).every(value => value === null));
    assert.ok(Object.values(billing.subscriptions).every(value => value === null));
    assert.ok(Object.values(billing.payments).every(value => value === null));
    assert.equal(support.open, null); assert.doesNotMatch(JSON.stringify([overview,billing,support]), /private_customer_payload/);
  });
}

test('unconfigured, privileged or unauthenticated factories fail closed before data requests', async () => {
  const neverFetch = async () => { throw new Error('Unexpected network'); };
  for (const configuration of [{}, { ...env, SUPABASE_SECRET_KEY: 'private' }, { ...env, SUPABASE_SERVICE_ROLE_KEY: 'private' }, { ...env, SUPABASE_URL: 'https://user:secret@project.example' }, { ...env, SUPABASE_PUBLISHABLE_KEY: 'legacy-key' }]) {
    const result = await provider(neverFetch, { env: configuration }).getBillingSummary();
    assert.equal(result.configured, false); assert.equal(result.subscriptions.total, null);
  }
  const result = await createOfficeProviders(undefined, { env, fetchImpl: neverFetch }).getLiveOverview();
  assert.equal(result.availability, 'authentication_required');
});

test('missing fields and unreadable sections stay null; explicit zero stays verified', async () => {
  const api = provider(fakeFetch(snapshot({ metrics: { profiles: 0, cafes: -1, baristas: '0', jobs: Number.MAX_SAFE_INTEGER + 1 },
    support: { total_recent: 0, open: 0 }, billing: { subscriptions: { total: 2, active: 1 }, payments: null } })));
  const overview = await api.getLiveOverview();
  assert.equal(overview.availability, 'partial'); assert.equal(overview.metrics.profiles, 0);
  for (const key of ['cafes','baristas','jobs','applications']) assert.equal(overview.metrics[key], null);
  const billing = await api.getBillingSummary();
  assert.equal(billing.availability, 'partial'); assert.equal(billing.subscriptions.active, 1); assert.equal(billing.payments.recent, null);
  assert.equal((await api.getSupportSummary()).availability, 'available');
  assert.equal((await api.getSystemHealth()).overall, 'attention');
});

test('impossible component counts are unavailable', async () => {
  const api = provider(fakeFetch(snapshot({ support: { total_recent: 1, open: 4 },
    billing: { subscriptions: { total: 0, active: 2, past_due: 3, canceling: 1 }, payments: { recent: 0, failed: 1, refunded: 2 } } })));
  assert.equal((await api.getSupportSummary()).open, null);
  const billing = await api.getBillingSummary(); assert.equal(billing.subscriptions.active, null); assert.equal(billing.payments.failed, null);
});

test('provider extras and raw customer records are dropped from every result', async () => {
  const api = provider(fakeFetch(snapshot({ access_token: token, customers: [{ email: 'private@example.test' }],
    metrics: { ...snapshot().metrics, customer: 'private@example.test' } })));
  assert.doesNotMatch(JSON.stringify(await Promise.all([api.getLiveOverview(), api.getSupportSummary(), api.getBillingSummary(), api.getDecisionSignals()])), /private@example|access_token|SYNTHETIC/);
});

for (const [label, body] of Object.entries({ wrongVersion: snapshot({schema_version:2}), absentTimestamp:snapshot({generated_at:null}), stale:snapshot({generated_at:new Date(now()-300001).toISOString()}), future:snapshot({generated_at:new Date(now()+30001).toISOString()}), array:[], rawRows:[{id:'private'}] })) {
  test(`${label} snapshot fails closed`, async () => { assert.equal((await provider(fakeFetch(body)).getLiveOverview()).availability, 'unavailable'); });
}

test('invalid JSON, oversized response and network failure fail closed', async () => {
  for (const fetchImpl of [async () => new Response('invalid'), async () => new Response('x'.repeat(17000)), async () => { throw new Error('private outage detail'); }]) {
    const result = await provider(fetchImpl).getLiveOverview();
    assert.equal(result.availability, 'unavailable'); assert.equal(result.metrics.profiles, null);
    assert.doesNotMatch(JSON.stringify(result), /private outage/);
  }
});

test('unavailable billing never invents a zero-count issue or all-clear', async () => {
  const signals = await provider(async () => new Response(null, {status:503})).getDecisionSignals();
  assert.equal(signals.length, 1); assert.equal(signals[0].agent, 'engineering-reliability');
  assert.doesNotMatch(JSON.stringify(signals), /0 past|0 failed/);
});
