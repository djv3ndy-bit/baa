import assert from 'node:assert/strict';
import test from 'node:test';
import {createMcpHandler} from '../api/mcp.ts';
import { requireOfficeOwner } from '../server/owner-auth.mjs';
import {ChatOAuthError} from '../server/chat-oauth.mjs';

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

test('actual Vercel handler rejects all legacy customer/owner JWTs and revoked Office tokens before MCP creation', async () => {
  const originalEnv = { ...process.env };
  const originalFetch = globalThis.fetch;
  Object.assign(process.env, env, {BJM_CHAT_OAUTH_ENABLED:'true',BJM_CHAT_OAUTH_CLIENT_ID:'bjm-chat-fixture',
    BJM_CHAT_UPSTREAM_CLIENT_ID:OTHER,BJM_CHAT_OAUTH_REDIRECT_URI:'https://chatgpt.com/connector/oauth/fixture',BJM_CHAT_OAUTH_FLOW_KEY:Buffer.alloc(32,7).toString('base64url')});
  delete process.env.SUPABASE_SECRET_KEY;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  try {
    const cases = [
      { req: { method: 'POST', headers: {} }, expected: 401, authCalls: 0 },
      { req: request(OWNER, 'authenticated'), expected: 401, authCalls: 0 },
      { req: request(OTHER), expected: 401, authCalls: 0 },
      { req: request(), expected: 401, authCalls: 0 },
      { req: {method:'POST',headers:{authorization:'Bearer bjm_at_'+'a'.repeat(43)}}, expected:401,authCalls:1 },
      { req: { method: 'PUT', headers: {} }, expected: 405, authCalls: 0 },
    ];
    for (const item of cases) {
      let calls = 0;
      globalThis.fetch = async () => assert.fail('No owner Auth or data request should run');
      const handler=createMcpHandler(()=>({oauth:{async verifyAccessToken(){calls++;throw new ChatOAuthError(401,'invalid_token');}},store:async()=>assert.fail('No data read before authorization')}));
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

test('legacy helper remains isolated compatibility source and returns its credential only as private request context', async () => {
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
