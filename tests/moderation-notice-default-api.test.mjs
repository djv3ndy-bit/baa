import test from 'node:test';
import assert from 'node:assert/strict';

// An eager worker constructor must never capture an unmocked network function
// during module loading. All actual endpoint work is installed by each fixture.
const previousImportFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('Unmocked provider access is forbidden in this integration test'); };
let handler;
try { ({ default: handler } = await import('../api/moderation-notices.js')); }
finally { globalThis.fetch = previousImportFetch; }

// Exercise the actual default API, real notice adapter, existing Resend helper
// and exact R2 staging cleaner. Every provider request is an inert local fetch.
const SECRET = 'offline_fixture_cron_secret_only_000000';
const OWNER = '11111111-1111-4111-8111-111111111111';
const UPLOAD = '22222222-2222-4222-8222-222222222222';
const DELIVERY = '33333333-3333-4333-8333-333333333333';
const NOTICE = '44444444-4444-4444-8444-444444444444';
const BASE = 'https://lmwqrxoitraofaftpwhe.supabase.co';
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

function fixture(t, options = {}) {
  const keys = ['VERCEL_ENV', 'CRON_SECRET', 'SUPABASE_URL', 'SUPABASE_SECRET_KEY', 'RESEND_API_KEY'];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  const originalFetch = globalThis.fetch, originalError = console.error;
  const calls = [], logs = [];
  Object.assign(process.env, { VERCEL_ENV: 'production', CRON_SECRET: SECRET, SUPABASE_URL: BASE,
    SUPABASE_SECRET_KEY: options.legacy ? 'fixture-legacy-service-jwt' : 'sb_secret_offline_fixture', RESEND_API_KEY: 'fixture-resend-key', ...options.env });
  console.error = (...values) => logs.push(values);
  t.after(() => {
    globalThis.fetch = originalFetch; console.error = originalError;
    for (const key of keys) previous[key] === undefined ? delete process.env[key] : process.env[key] = previous[key];
  });
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input)), body = init.body ? JSON.parse(init.body) : null;
    const call = { origin: url.origin, path: url.pathname, method: init.method || 'GET', headers: init.headers, body, redirect: init.redirect };
    calls.push(call);
    if (url.origin === 'https://api.resend.com') {
      assert.equal(url.pathname, '/emails'); assert.equal(init.headers.Authorization, 'Bearer fixture-resend-key');
      return json({ id: 'offline-confirmed-email' });
    }
    assert.equal(url.origin, BASE, 'no destination is selected from request input');
    assert.equal(init.redirect, 'error', 'every new privileged Supabase request refuses redirects');
    assert.equal(init.headers.apikey, options.legacy ? 'fixture-legacy-service-jwt' : 'sb_secret_offline_fixture');
    assert.equal(init.headers.Authorization, options.legacy ? 'Bearer fixture-legacy-service-jwt' : undefined);
    if (url.pathname.endsWith('/claim_moderation_notices')) {
      const now = Date.now();
      return json({ claimId: body.p_claim_id, deliveryId: DELIVERY, firstAttemptAt: new Date(now - 1000).toISOString(),
        items: [{ noticeId: NOTICE, eventType: 'media_pending', createdAt: new Date(now - 60000).toISOString(), dueAt: new Date(now + 86400000).toISOString() }], needsAttentionCount: 0 });
    }
    if (url.pathname.endsWith('/ack_moderation_notices')) return json(body.p_notice_ids.length);
    if (url.pathname.endsWith('/claim_staged_media_cleanup')) {
      if (options.claimFails) return json({ error: 'private fixture provider detail' }, 503);
      return json({ claimId: body.p_claim_id, items: options.emptyCleanup ? [] : [{ uploadId: UPLOAD, ownerId: OWNER, objectPath: `${OWNER}/${UPLOAD}.jpg` }] });
    }
    if (url.pathname === '/storage/v1/object/ugc-media-staging' && init.method === 'DELETE') {
      assert.deepEqual(body, { prefixes: [`${OWNER}/${UPLOAD}.jpg`] });
      return options.deleteFails ? json({ error: 'private fixture storage detail' }, 503) : json([]);
    }
    if (url.pathname.endsWith('/ack_staged_media_cleanup')) return json(options.ackMismatch ? 0 : body.p_upload_ids.length);
    throw new Error('Unexpected fixture request');
  };
  return { calls, logs, async run(req = {}) {
    const res = { code: null, body: null, headers: {}, setHeader(name, value) { this.headers[name] = value; }, status(code) { this.code = code; return this; }, json(value) { this.body = value; return this; } };
    await handler({ method: 'GET', headers: { authorization: 'Bearer ' + SECRET }, query: { to: 'ignored@example.invalid', bucket: 'cafe-images' }, ...req }, res);
    return res;
  } };
}
const sends = h => h.calls.filter(call => call.origin === 'https://api.resend.com');
const noticeAcks = h => h.calls.filter(call => call.path.endsWith('/ack_moderation_notices'));

for (const legacy of [false, true]) test(`default production API invokes the exact cleaner and delivers notices with ${legacy ? 'legacy JWT' : 'modern API-key'} service authentication`, async t => {
  const h = fixture(t, { legacy }), result = await h.run();
  assert.equal(result.code, 200); assert.deepEqual(result.body, { ok: true, notifiedItems: 1, cleanedStagingItems: 1 });
  assert.equal(h.calls.filter(call => call.path.endsWith('/claim_staged_media_cleanup')).length, 1);
  const cleanup = h.calls.find(call => call.path === '/storage/v1/object/ugc-media-staging'); assert.ok(cleanup);
  assert.deepEqual(h.calls.find(call => call.path.endsWith('/ack_staged_media_cleanup')).body.p_upload_ids, [UPLOAD]);
  assert.equal(sends(h).length, 1); assert.deepEqual(sends(h)[0].body.to, ['hello@baristajobmatch.com']);
  assert.equal(sends(h)[0].headers['Idempotency-Key'], 'bjm/moderation/' + DELIVERY);
  assert.equal(noticeAcks(h).length, 1); assert.equal(noticeAcks(h)[0].body.p_delivered, true);
  assert.doesNotMatch(JSON.stringify(result.body), /11111111|22222222|fixture|secret|objectPath/);
});

test('default API never invokes the cleaner, database or mail in preview or development', async t => {
  const h = fixture(t);
  for (const environment of ['preview', 'development', 'undefined']) {
    process.env.VERCEL_ENV = environment; assert.equal((await h.run()).code, 404);
  }
  assert.deepEqual(h.calls, []);
});

test('default API rejects missing/wrong authorization and unsupported methods before cleanup can run', async t => {
  const h = fixture(t);
  for (const authorization of [undefined, '', 'Bearer wrong']) assert.equal((await h.run({ headers: { authorization } })).code, 401);
  assert.equal((await h.run({ method: 'POST' })).code, 405); assert.deepEqual(h.calls, []);
});

test('default API still sends and acknowledges the notice when the actual cleanup claim fails, returning503', async t => {
  const h = fixture(t, { claimFails: true }), result = await h.run();
  assert.equal(result.code, 503); assert.equal(result.body.ok, false); assert.equal(result.body.notifiedItems, 1);
  assert.equal(sends(h).length, 1); assert.equal(noticeAcks(h).at(-1).body.p_delivered, true);
  assert.equal(h.calls.some(call => call.method === 'DELETE'), false);
  assert.doesNotMatch(JSON.stringify([result.body, h.logs]), /private fixture|sb_secret|fixture-resend|objectPath/);
});

test('default API preserves delivered notice ACK while a failed physical cleanup releases only its own claim and returns503', async t => {
  const h = fixture(t, { deleteFails: true }), result = await h.run();
  assert.equal(result.code, 503); assert.equal(sends(h).length, 1); assert.equal(noticeAcks(h).length, 1);
  assert.equal(noticeAcks(h)[0].body.p_delivered, true);
  const cleanupAcks = h.calls.filter(call => call.path.endsWith('/ack_staged_media_cleanup'));
  assert.equal(cleanupAcks.length, 1); assert.equal(cleanupAcks[0].body.p_deleted, false);
  assert.equal(result.body.cleanedStagingItems, undefined); assert.equal(result.body.notifiedItems, 1);
});

test('default API cannot report successful cleanup when exact R2 deletion acknowledgement is missing', async t => {
  const h = fixture(t, { ackMismatch: true }), result = await h.run();
  assert.equal(result.code, 503); assert.equal(result.body.ok, false); assert.equal(result.body.cleanedStagingItems, undefined);
  assert.equal(sends(h).length, 1); assert.equal(noticeAcks(h)[0].body.p_delivered, true);
  assert.equal(h.calls.filter(call => call.method === 'DELETE').length, 1);
});

test('an empty cleanup claim does no physical removal and still completes the actual default notice route', async t => {
  const h = fixture(t, { emptyCleanup: true }), result = await h.run();
  assert.equal(result.code, 200); assert.equal(result.body.cleanedStagingItems, 0); assert.equal(sends(h).length, 1);
  assert.equal(h.calls.some(call => call.method === 'DELETE' || call.path.endsWith('/ack_staged_media_cleanup')), false);
});
