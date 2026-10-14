import assert from 'node:assert/strict';
import test from 'node:test';
import { authorizeOfficeRequest, protectedResourceMetadata } from '../server/owner-auth.mjs';
import metadataHandler from '../api/oauth-protected-resource.ts';
import mcpHandler from '../api/mcp.ts';

const origins = { SUPABASE_URL: 'https://project.example', BJM_OFFICE_BASE_URL: 'https://office.example' };
const privateSettings = {
  BJM_AI_OFFICE_OWNER_USER_ID: '11111111-1111-4111-8111-111111111111',
  BJM_AI_OFFICE_OAUTH_CLIENT_ID: 'private-office-client',
  SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_offline_test',
};
const response = () => ({
  headers: {}, statusCode: 200, body: undefined,
  setHeader(name, value) { this.headers[name] = value; },
  status(code) { this.statusCode = code; return this; },
  json(body) { this.body = body; return this; },
});

test('public discovery works with only validated origins before owner or client setup', () => {
  assert.deepEqual(protectedResourceMetadata(origins), {
    resource: 'https://office.example/mcp',
    authorization_servers: ['https://project.example/auth/v1'],
    scopes_supported: ['openid'], bearer_methods_supported: ['header'],
    resource_name: 'BaristaMatch private AI Office',
  });
  assert.deepEqual(protectedResourceMetadata({ ...origins, ...privateSettings, BJM_AI_OFFICE_AUTH_ENABLED: 'false' }), protectedResourceMetadata(origins));
  assert.doesNotMatch(JSON.stringify(protectedResourceMetadata({ ...origins, ...privateSettings })), /private-office-client|11111111|sb_publishable/);
});

test('disabled or incomplete setup challenges anonymous requests without external calls', async () => {
  let calls = 0;
  for (const settings of [origins, { ...origins, BJM_AI_OFFICE_AUTH_ENABLED: 'false' }, { ...origins, ...privateSettings, BJM_AI_OFFICE_AUTH_ENABLED: 'false' }]) {
    const result = await authorizeOfficeRequest({ headers: {} }, { env: settings, fetchImpl: async () => { calls++; throw new Error('Unexpected fetch'); } });
    assert.equal(result.ok, false);
    assert.equal(result.status, 401);
    assert.match(result.headers['WWW-Authenticate'], /resource_metadata="https:\/\/office\.example\/\.well-known\/oauth-protected-resource"/);
    assert.match(result.headers['Cache-Control'], /no-store/);
    assert.doesNotMatch(JSON.stringify(result), /private-office-client|11111111|sb_publishable/);
  }
  assert.equal(calls, 0);
});

test('discovery never authorizes bearer requests while disabled or privately unconfigured', async () => {
  let calls = 0;
  for (const settings of [origins, { ...origins, ...privateSettings }, { ...origins, ...privateSettings, BJM_AI_OFFICE_AUTH_ENABLED: 'false' }, { ...origins, BJM_AI_OFFICE_AUTH_ENABLED: 'true' }]) {
    const result = await authorizeOfficeRequest({ headers: { authorization: 'Bearer e30.e30.OFFLINE_TEST' } }, { env: settings, fetchImpl: async () => { calls++; throw new Error('Unexpected fetch'); } });
    assert.equal(result.ok, false);
    assert.equal(result.status, 503);
  }
  assert.equal(calls, 0);
});

test('unsafe or missing origins still prevent discovery and anonymous challenges', async () => {
  for (const field of ['SUPABASE_URL', 'BJM_OFFICE_BASE_URL']) {
    for (const value of ['', 'http://office.example', 'https://user:pass@office.example', 'https://office.example/path', 'https://office.example/?query=1', 'https://office.example/#fragment']) {
      const env = { ...origins, [field]: value };
      assert.throws(() => protectedResourceMetadata(env));
      const result = await authorizeOfficeRequest({ headers: {} }, { env });
      assert.equal(result.status, 503);
      assert.equal(result.headers['WWW-Authenticate'], undefined);
    }
  }
});

test('anonymous bootstrap preserves the configured Origin restriction', async () => {
  const result = await authorizeOfficeRequest({ headers: { origin: 'https://attacker.example' } }, { env: origins });
  assert.equal(result.status, 403);
  assert.equal(result.headers['WWW-Authenticate'], undefined);
});

test('actual metadata and MCP API handlers expose discovery while keeping MCP execution gated', async () => {
  const previousEnv = process.env;
  const previousFetch = globalThis.fetch;
  let calls = 0;
  process.env = { ...origins, BJM_AI_OFFICE_AUTH_ENABLED: 'false' };
  globalThis.fetch = async () => { calls++; throw new Error('Unexpected fetch'); };
  try {
    const metadata = response();
    metadataHandler({ method: 'GET' }, metadata);
    assert.equal(metadata.statusCode, 200);
    assert.equal(metadata.body.resource, 'https://office.example/mcp');
    assert.equal(metadata.headers['Cache-Control'], 'no-store');

    const anonymous = response();
    await mcpHandler({ method: 'POST', headers: {} }, anonymous);
    assert.equal(anonymous.statusCode, 401);
    assert.match(anonymous.headers['WWW-Authenticate'], /oauth-protected-resource/);
    assert.deepEqual(anonymous.body, { error: 'Authentication required.' });

    const bearer = response();
    await mcpHandler({ method: 'POST', headers: { authorization: 'Bearer e30.e30.OFFLINE_TEST' } }, bearer);
    assert.equal(bearer.statusCode, 401);
    assert.equal(calls, 0);
  } finally {
    process.env = previousEnv;
    globalThis.fetch = previousFetch;
  }
});
