import test from 'node:test';
import assert from 'node:assert/strict';
import handler from '../api/delete-account.js';

const OWNER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const BASE = 'https://fixture-project.supabase.co';
const response = (data, status = 200) => new Response(JSON.stringify(data), { status });

function fixture(t, options = {}) {
  const previousFetch = globalThis.fetch;
  const keys = ['SUPABASE_URL', 'SUPABASE_PUBLISHABLE_KEY', 'SUPABASE_SECRET_KEY'];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  Object.assign(process.env, { SUPABASE_URL: BASE, SUPABASE_PUBLISHABLE_KEY: 'public-fixture-key', SUPABASE_SECRET_KEY: options.legacy ? 'legacy-fixture-service-jwt' : 'sb_secret_fixture' });
  t.after(() => { globalThis.fetch = previousFetch; for (const key of keys) previous[key] === undefined ? delete process.env[key] : process.env[key] = previous[key]; });
  const calls = [], buckets = new Map(['coffee-videos', 'cafe-images', 'ugc-media-staging'].map(bucket => [bucket, new Set(options.files?.[bucket] || [])]));
  let frozen = false, deleted = false, listReads = 0;
  globalThis.fetch = async (url, input = {}) => {
    const parsed = new URL(url); assert.equal(parsed.origin, BASE, 'only the configured first-party Supabase endpoint is used');
    const call = { path: parsed.pathname, method: input.method || 'GET', body: input.body ? JSON.parse(input.body) : null, headers: input.headers, search: parsed.searchParams };
    calls.push(call);
    if (call.path === '/auth/v1/user') return response(options.authStatus === 401 ? {} : { id: OWNER, identities: options.apple ? [{ provider: 'apple' }] : [] }, options.authStatus || 200);
    if (call.path === '/rest/v1/profiles') return response(options.noProfile ? [] : [{ role: 'barista', avatar_url: `${BASE}/storage/v1/object/public/cafe-images/${OWNER}/old.jpg` }]);
    if (call.path === '/rest/v1/cafe_subscriptions') return response([]);
    if (call.path === '/rest/v1/rpc/begin_profile_media_account_deletion') {
      if (options.freezeStatus && options.freezeStatus !== 200) return response(null, options.freezeStatus);
      const value = Object.hasOwn(options, 'freezeValue') ? options.freezeValue : true;
      if (value === true) frozen = true;
      return response(value);
    }
    if (call.path.startsWith('/storage/v1/object/list/')) {
      assert.equal(frozen, true, 'every enumeration must happen after the confirmed deletion freeze'); listReads++;
      const bucket = call.path.split('/').at(-1), { prefix, offset, limit } = call.body;
      assert.equal(prefix, `${OWNER}/`);
      const entries = [...buckets.get(bucket)].filter(path => path.startsWith(prefix)).sort().map(path => ({ id: path, name: path.slice(prefix.length), metadata: {} }));
      if (options.residualStaging && bucket === 'ugc-media-staging' && listReads > 3) entries.push({ id: 'residual', name: 'unremoved.jpg', metadata: {} });
      return response(entries.slice(offset, offset + limit));
    }
    if (call.path.startsWith('/storage/v1/object/') && call.method === 'DELETE') {
      assert.equal(frozen, true, 'physical file removal cannot precede the freeze');
      if (options.storageFail) return response({}, 503);
      const bucket = call.path.split('/').at(-1);
      for (const path of call.body.prefixes) { assert.ok(path.startsWith(`${OWNER}/`)); buckets.get(bucket).delete(path); }
      return response([]);
    }
    if (call.path === `/auth/v1/admin/users/${OWNER}` && call.method === 'DELETE') {
      assert.equal(frozen, true); if (options.authDeleteStatus && options.authDeleteStatus !== 200) return response({}, options.authDeleteStatus);
      deleted = true; return response({ id: OWNER });
    }
    throw new Error('Unexpected fixture request');
  };
  const run = async overrides => {
    const res = { code: 0, body: null, setHeader() {}, status(code) { this.code = code; return this; }, json(value) { this.body = value; return this; } };
    await handler({ method: 'POST', headers: { authorization: 'Bearer fixture-owner-session' }, body: { confirmation: 'DELETE', userId: OTHER, ownerId: OTHER }, ...overrides }, res);
    return res;
  };
  return { calls, buckets, run, get frozen() { return frozen; }, get deleted() { return deleted; } };
}

test('deletion freezes only the Auth-verified owner before all three physical-storage cleanups and identity removal', async t => {
  const h = fixture(t, { apple: true, files: { 'coffee-videos': [`${OWNER}/old.mp4`], 'cafe-images': [`${OWNER}/old.jpg`, `${OTHER}/untouched.jpg`], 'ugc-media-staging': [`${OWNER}/pending.jpg`, `${OWNER}/rejected.jpg`, `${OWNER}/unsubmitted.jpg`, `${OTHER}/untouched.jpg`] } });
  const result = await h.run(); assert.equal(result.code, 200); assert.deepEqual(result.body, { success: true, appleRevocation: 'manual_required' });
  const freeze = h.calls.findIndex(call => call.path.endsWith('/begin_profile_media_account_deletion'));
  assert.ok(freeze > h.calls.findIndex(call => call.path === '/auth/v1/user'));
  assert.deepEqual(h.calls[freeze].body, { p_owner_id: OWNER });
  assert.ok(h.calls.filter(call => call.path.startsWith('/storage/')).every(call => h.calls.indexOf(call) > freeze));
  assert.ok(h.calls.findIndex(call => call.path.startsWith('/auth/v1/admin/users/')) > freeze);
  assert.equal(h.buckets.get('ugc-media-staging').has(`${OTHER}/untouched.jpg`), true);
  assert.equal([...h.buckets.values()].some(files => [...files].some(path => path.startsWith(`${OWNER}/`))), false);
  assert.equal(h.deleted, true);
});

for (const legacy of [false, true]) test(`media-deletion freeze retains the existing ${legacy ? 'legacy JWT' : 'modern API-key'} service authentication format`, async t => {
  const h = fixture(t, { legacy }); assert.equal((await h.run()).code, 200);
  const freeze = h.calls.find(call => call.path.endsWith('/begin_profile_media_account_deletion'));
  assert.equal(freeze.headers.apikey, legacy ? 'legacy-fixture-service-jwt' : 'sb_secret_fixture');
  assert.equal(freeze.headers.Authorization, legacy ? 'Bearer legacy-fixture-service-jwt' : undefined);
});

for (const invalid of [{ freezeStatus: 503 }, { freezeValue: false }, { freezeValue: null }, { freezeValue: {} }]) test(`an unconfirmed deletion freeze fails closed before any storage or identity mutation: ${JSON.stringify(invalid)}`, async t => {
  const h = fixture(t, invalid); const result = await h.run(); assert.equal(result.code, 502);
  assert.equal(result.body.success, undefined); assert.equal(result.body.appleRevocation, undefined);
  assert.equal(h.calls.some(call => call.path.startsWith('/storage/')), false); assert.equal(h.deleted, false);
});

test('a partial physical-storage failure retains the freeze and finishes through an idempotent deletion retry', async t => {
  const options = { storageFail: true, files: { 'ugc-media-staging': [`${OWNER}/pending.jpg`] } }, h = fixture(t, options);
  const failed = await h.run(); assert.equal(failed.code, 502); assert.equal(h.frozen, true); assert.equal(h.deleted, false);
  assert.equal(h.buckets.get('ugc-media-staging').has(`${OWNER}/pending.jpg`), true);
  options.storageFail = false; const retry = await h.run(); assert.equal(retry.code, 200); assert.equal(h.deleted, true);
  assert.equal(h.calls.filter(call => call.path.endsWith('/begin_profile_media_account_deletion')).length, 2);
  assert.equal(h.calls.some(call => /release.*media|delete.*marker/.test(call.path)), false, 'API does not thaw a partially cleaned owner');
});

test('a failed Auth delete after purge does not return an Apple completion and can retry with empty storage', async t => {
  const options = { authDeleteStatus: 503, apple: true, files: { 'ugc-media-staging': [`${OWNER}/private.jpg`] } }, h = fixture(t, options);
  const failed = await h.run(); assert.equal(failed.code, 502); assert.equal(failed.body.success, undefined); assert.equal(failed.body.appleRevocation, undefined);
  assert.equal(h.frozen, true); assert.equal(h.deleted, false); assert.equal(h.buckets.get('ugc-media-staging').size, 0);
  options.authDeleteStatus = 200; const retry = await h.run(); assert.equal(retry.code, 200); assert.equal(retry.body.appleRevocation, 'manual_required');
});

test('the final verification includes staged objects and refuses identity deletion when one remains', async t => {
  const h = fixture(t, { residualStaging: true }); const result = await h.run(); assert.equal(result.code, 502); assert.equal(h.deleted, false);
  assert.ok(h.calls.filter(call => call.path.endsWith('/list/ugc-media-staging')).length >= 2);
});

test('staged upload pagination enumerates every file before removing batches', async t => {
  const files = Array.from({ length: 102 }, (_, i) => `${OWNER}/fixture-${String(i).padStart(3, '0')}.jpg`);
  const h = fixture(t, { files: { 'ugc-media-staging': files } }); assert.equal((await h.run()).code, 200);
  const lists = h.calls.filter(call => call.path.endsWith('/list/ugc-media-staging'));
  assert.equal(lists[0].body.offset, 0); assert.equal(lists[1].body.offset, 100);
  const removals = h.calls.filter(call => call.path === '/storage/v1/object/ugc-media-staging' && call.method === 'DELETE');
  assert.deepEqual(removals.map(call => call.body.prefixes.length), [100, 2]); assert.equal(h.buckets.get('ugc-media-staging').size, 0);
});

test('an already-missing profile still freezes and purges its owned staging prefix before Auth removal', async t => {
  const h = fixture(t, { noProfile: true, files: { 'ugc-media-staging': [`${OWNER}/unreferenced.jpg`] } });
  assert.equal((await h.run()).code, 200); assert.equal(h.buckets.get('ugc-media-staging').size, 0); assert.equal(h.deleted, true);
});

test('failed authentication and missing explicit confirmation never create a marker or remove files', async t => {
  const h = fixture(t, { authStatus: 401 }); assert.equal((await h.run()).code, 401); assert.equal(h.frozen, false);
  assert.equal(h.calls.length, 1); h.calls.length = 0;
  assert.equal((await h.run({ body: { confirmation: 'wrong' } })).code, 400); assert.deepEqual(h.calls, []);
});
