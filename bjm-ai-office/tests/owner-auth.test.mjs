import assert from 'node:assert/strict';
import test from 'node:test';
import { authorizeOfficeRequest, protectedResourceMetadata } from '../server/owner-auth.mjs';

// Synthetic identifiers and mock tokens only. No live owner identity or sessions.
const OWNER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const env = {
  SUPABASE_URL: 'https://project.example', SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test',
  BJM_OFFICE_BASE_URL: 'https://office.example', BJM_AI_OFFICE_OWNER_USER_ID: OWNER,
  BJM_AI_OFFICE_OAUTH_CLIENT_ID: 'office-client', BJM_AI_OFFICE_AUTH_ENABLED: 'true',
};
const now = () => 1800000000000;
const baseClaims = { sub: OWNER, iss: 'https://project.example/auth/v1', aud: 'https://office.example/mcp',
  client_id: 'office-client', role: 'authenticated', scope: 'openid', session_id: OTHER,
  exp: 1800000600, iat: 1800000000 };
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const token = (claims = {}, header = {}) => `${encode({ alg: 'ES256', ...header })}.${encode({ ...baseClaims, ...claims })}.MOCK_SIGNATURE`;
const request = (claims = {}, header = {}) => ({ headers: { authorization: `Bearer ${token(claims, header)}` } });
const userResponse = (extra = {}) => Response.json({ id: OWNER, email_confirmed_at: '2026-01-01T00:00:00Z', ...extra });
const run = (req, options = {}) => authorizeOfficeRequest(req, { env, now, fetchImpl: async () => userResponse(), ...options });
const neverFetch = async () => { throw new Error('Unexpected authentication request'); };

test('verified exact owner succeeds without returning token or profile', async () => {
  let calls = 0;
  const result = await run(request(), { fetchImpl: async (url, init) => {
    calls++;
    assert.equal(url, 'https://project.example/auth/v1/user');
    assert.equal(init.method, 'GET'); assert.equal(init.redirect, 'error');
    assert.equal(init.headers.apikey, env.SUPABASE_PUBLISHABLE_KEY);
    assert.equal(init.headers.Authorization, request().headers.authorization);
    return userResponse();
  } });
  assert.deepEqual(result, { ok: true, ownerId: OWNER }); assert.equal(calls, 1);
});

test('missing activation switch fails closed', async () => {
  assert.equal((await run(request(), { env: { ...env, BJM_AI_OFFICE_AUTH_ENABLED: '' }, fetchImpl: neverFetch })).status, 503);
});
for (const field of ['BJM_AI_OFFICE_OWNER_USER_ID', 'BJM_AI_OFFICE_OAUTH_CLIENT_ID', 'SUPABASE_URL', 'SUPABASE_PUBLISHABLE_KEY', 'BJM_OFFICE_BASE_URL']) {
  test(`missing ${field} fails closed`, async () => {
    assert.equal((await run(request(), { env: { ...env, [field]: '' }, fetchImpl: neverFetch })).status, 503);
  });
}
for (const field of ['SUPABASE_SECRET_KEY', 'SUPABASE_SERVICE_ROLE_KEY']) {
  test(`rejects inherited ${field} before provider calls`, async () => {
    assert.equal((await run(request(), { env: { ...env, [field]: 'not-a-real-secret' }, fetchImpl: neverFetch })).status, 503);
  });
}
test('unauthenticated request receives discoverable OAuth challenge', async () => {
  const result = await run({ headers: {} }, { fetchImpl: neverFetch });
  assert.equal(result.status, 401); assert.match(result.headers['WWW-Authenticate'], /oauth-protected-resource/);
});
for (const [name, claims] of Object.entries({
  expired: { exp: 1799999999 }, future: { iat: 1800000031 }, notYetValid: { nbf: 1800000100 },
  missingExpiry: { exp: undefined }, longLifetime: { exp: 1800003601 },
  wrongIssuer: { iss: 'https://attacker.example/auth/v1' }, genericAudience: { aud: 'authenticated' },
  wrongClient: { client_id: 'another-client' }, regularLogin: { client_id: undefined },
  serviceRole: { role: 'service_role' }, missingScope: { scope: '' }, missingSession: { session_id: undefined },
})) {
  test(`rejects ${name} token before network`, async () => {
    assert.equal((await run(request(claims), { fetchImpl: neverFetch })).status, 401);
  });
}
for (const [name, header] of Object.entries({ unsigned: { alg: 'none' }, symmetric: { alg: 'HS256' }, critical: { crit: ['extension'] } })) {
  test(`rejects ${name} header`, async () => { assert.equal((await run(request({}, header), { fetchImpl: neverFetch })).status, 401); });
}
test('decoded owner claim cannot bypass authoritative Supabase rejection', async () => {
  assert.equal((await run(request(), { fetchImpl: async () => new Response(null, { status: 401 }) })).status, 401);
});
test('verified nonowner returns 403 even with owner-shaped metadata', async () => {
  assert.equal((await run(request({ sub: OTHER }), { fetchImpl: async () => userResponse({ id: OTHER, user_metadata: { role: 'owner', id: OWNER } }) })).status, 403);
});
test('mismatched verified user and subject is rejected', async () => {
  assert.equal((await run(request(), { fetchImpl: async () => userResponse({ id: OTHER }) })).status, 401);
});
for (const [name, user] of Object.entries({ anonymous: { is_anonymous: true }, unconfirmed: { email_confirmed_at: null }, deleted: { deleted_at: '2026-01-01' }, banned: { banned_until: '2099-01-01' } })) {
  test(`rejects ${name} owner`, async () => { assert.equal((await run(request(), { fetchImpl: async () => userResponse(user) })).status, 401); });
}
test('untrusted Origin is rejected', async () => { assert.equal((await run({ ...request(), headers: { ...request().headers, origin: 'https://attacker.example' } }, { fetchImpl: neverFetch })).status, 403); });
test('duplicate Authorization is rejected', async () => { assert.equal((await run({ ...request(), rawHeaders: ['Authorization', 'a', 'authorization', 'b'] }, { fetchImpl: neverFetch })).status, 401); });
test('token cannot be supplied through query string', async () => { assert.equal((await run({ headers: {}, url: `/mcp?access_token=${token()}` }, { fetchImpl: neverFetch })).status, 401); });
test('malformed and oversized tokens rejected', async () => {
  for (const value of ['Bearer not-a-jwt', `Bearer ${'a'.repeat(9000)}`, ['Bearer a', 'Bearer b']]) {
    assert.equal((await run({ headers: { authorization: value } }, { fetchImpl: neverFetch })).status, 401);
  }
});
test('auth outage fails closed without disclosing provider payload', async () => {
  for (const code of [429, 500, 503]) {
    const result = await run(request(), { fetchImpl: async () => new Response('sensitive provider detail', { status: code }) });
    assert.equal(result.status, 503); assert.doesNotMatch(JSON.stringify(result), /sensitive provider/);
  }
  assert.equal((await run(request(), { fetchImpl: async () => { throw new Error('private endpoint'); } })).status, 503);
});
test('invalid provider JSON rejected', async () => { assert.equal((await run(request(), { fetchImpl: async () => new Response('invalid') })).status, 503); });
test('metadata includes resource binding but no private identifiers', () => {
  const metadata = protectedResourceMetadata(env);
  assert.equal(metadata.resource, baseClaims.aud);
  assert.deepEqual(metadata.authorization_servers, [baseClaims.iss]);
  assert.doesNotMatch(JSON.stringify(metadata), new RegExp(OWNER));
});
test('unsafe configured origins fail closed', async () => {
  for (const url of ['http://office.example', 'https://user:pass@office.example', 'https://office.example/path', 'https://office.example/?a=1']) {
    assert.equal((await run(request(), { env: { ...env, BJM_OFFICE_BASE_URL: url }, fetchImpl: neverFetch })).status, 503);
  }
});
