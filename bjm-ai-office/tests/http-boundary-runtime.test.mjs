import assert from 'node:assert/strict';
import test from 'node:test';
import handler from '../api/mcp.ts';
import { requireOfficeOwner } from '../server/owner-auth.mjs';

const OWNER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const env = {
  SUPABASE_URL: 'https://project.example', SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test',
  BJM_OFFICE_BASE_URL: 'https://office.example', BJM_AI_OFFICE_OWNER_USER_ID: OWNER,
  BJM_AI_OFFICE_OAUTH_CLIENT_ID: 'office-client', BJM_AI_OFFICE_AUTH_ENABLED: 'true',
};
function request(sub = OWNER, role = 'bjm_office_reader') {
  const now = Math.floor(Date.now() / 1000);
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const token = `${encode({ alg: 'ES256' })}.${encode({ sub, role, session_id: OTHER,
    iss: 'https://project.example/auth/v1', aud: 'https://office.example/mcp', client_id: 'office-client',
    scope: 'openid', iat: now, exp: now + 600 })}.MOCK_SIGNATURE`;
  return { method: 'POST', headers: { authorization: `Bearer ${token}` } };
}
function response() {
  return { headers: {}, code: 200, body: undefined,
    setHeader(key, value) { this.headers[key] = value; },
    status(code) { this.code = code; return this; },
    json(body) { this.body = body; return this; },
    on() { assert.fail('MCP transport must not be created for a denied request'); },
  };
}

test('actual Vercel handler denies anonymous, customer-role, nonowner and revoked-session requests before MCP creation', async () => {
  const originalEnv = { ...process.env };
  const originalFetch = globalThis.fetch;
  Object.assign(process.env, env);
  delete process.env.SUPABASE_SECRET_KEY;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  try {
    const cases = [
      { req: { method: 'POST', headers: {} }, expected: 401, authCalls: 0 },
      { req: request(OWNER, 'authenticated'), expected: 401, authCalls: 0 },
      { req: request(OTHER), expected: 403, authCalls: 1, user: OTHER },
      { req: request(), expected: 401, authCalls: 1, revoked: true },
      { req: { method: 'PUT', headers: {} }, expected: 405, authCalls: 0 },
    ];
    for (const item of cases) {
      let calls = 0;
      globalThis.fetch = async (url, init) => {
        calls++;
        assert.equal(url, 'https://project.example/auth/v1/user');
        assert.equal(init.headers.Authorization, item.req.headers.authorization);
        return item.revoked ? new Response(null, { status: 401 })
          : Response.json({ id: item.user, email_confirmed_at: '2026-01-01T00:00:00Z' });
      };
      const res = response();
      await handler(item.req, res);
      assert.equal(res.code, item.expected);
      assert.equal(calls, item.authCalls);
      assert.match(res.headers['Cache-Control'], /no-store/);
      assert.doesNotMatch(JSON.stringify(res.body), /MOCK_SIGNATURE|sb_publishable_test/);
      if (res.code === 401) assert.match(res.headers['WWW-Authenticate'], /oauth-protected-resource/);
    }
  } finally { process.env = originalEnv; globalThis.fetch = originalFetch; }
});

test('the verified owner credential is returned only as private request context', async () => {
  const originalEnv = { ...process.env };
  const originalFetch = globalThis.fetch;
  Object.assign(process.env, env);
  delete process.env.SUPABASE_SECRET_KEY;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  globalThis.fetch = async () => Response.json({ id: OWNER, email_confirmed_at: '2026-01-01T00:00:00Z' });
  try {
    const req = request();
    const res = response();
    const context = await requireOfficeOwner(req, res);
    assert.equal(context.ownerId, OWNER);
    assert.equal(context.accessToken, req.headers.authorization.slice(7));
    assert.equal(res.body, undefined);
  } finally { process.env = originalEnv; globalThis.fetch = originalFetch; }
});
