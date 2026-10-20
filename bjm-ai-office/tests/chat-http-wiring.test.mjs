import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFile, mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ChatOAuthError } from '../server/chat-oauth.mjs';
import { createMcpHandler } from '../api/mcp.ts';
import { createOAuthRouteHandler } from '../server/chat-http.ts';
import { createChatApp } from '../server/index.ts';
import { buildChatOutput } from '../scripts/build-chat.mjs';

function response() {
  return { headers: {}, code: 200, headersSent: false, writableEnded: false,
    setHeader(key, value) { this.headers[key] = value; },
    status(code) { this.code = code; return this; },
    json(body) { this.body = body; this.headersSent = true; this.writableEnded = true; return this; },
    on() { assert.fail('Denied request must not create an MCP transport'); },
  };
}

test('production entrypoints use only Office-owned authentication and inject the aggregate adapter after auth', async () => {
  const mcp = await readFile(new URL('../api/mcp.ts', import.meta.url), 'utf8');
  const index = await readFile(new URL('../server/index.ts', import.meta.url), 'utf8');
  const metadata = await readFile(new URL('../api/oauth-protected-resource.ts', import.meta.url), 'utf8');
  for (const source of [mcp, index, metadata]) {
    assert.doesNotMatch(source, /from ['"][^'"]*\/owner-auth\.mjs['"]/);
    assert.doesNotMatch(source, /owner\.accessToken|console\.error/);
  }
  assert.ok(mcp.indexOf('await requireChatOfficeOwner') < mcp.indexOf('createChatOfficeProviders(owner'));
  assert.match(mcp, /createOfficeMcpServer\(undefined, \{ providers \}\)/);
  assert.doesNotMatch(index, /express\.static/);
});

test('MCP method and private-runtime errors fail without creating transport or disclosing errors', async () => {
  const originalEnv = { ...process.env };
  Object.assign(process.env, {
    BJM_OFFICE_BASE_URL: 'https://office.example', SUPABASE_URL: 'https://project.example',
    SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_fixture',
    BJM_AI_OFFICE_OWNER_USER_ID: '11111111-1111-4111-8111-111111111111',
    BJM_CHAT_UPSTREAM_CLIENT_ID: '22222222-2222-4222-8222-222222222222',
    BJM_CHAT_OAUTH_CLIENT_ID: 'office-fixture', BJM_CHAT_OAUTH_REDIRECT_URI: 'https://chatgpt.com/connector/oauth/fixture',
    BJM_CHAT_OAUTH_FLOW_KEY: Buffer.alloc(32, 7).toString('base64url'), BJM_CHAT_OAUTH_ENABLED: 'true',
  });
  delete process.env.SUPABASE_SECRET_KEY;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  let calls = 0;
  const handler = createMcpHandler(async () => { calls++; throw new Error('fixture-private-connection-string'); });
  try {
    const wrongMethod = response();
    await handler({ method: 'PUT' }, wrongMethod);
    assert.equal(wrongMethod.code, 405);
    assert.equal(calls, 0);
    const unavailable = response();
    await handler({ method: 'POST', headers: { authorization: `Bearer bjm_at_${'a'.repeat(43)}` } }, unavailable);
    assert.equal(unavailable.code, 503);
    assert.equal(calls, 1);
    assert.match(unavailable.headers['Cache-Control'], /no-store/);
    assert.equal(unavailable.headers['Referrer-Policy'], 'no-referrer');
    assert.doesNotMatch(JSON.stringify(unavailable), /fixture-private-connection-string/);
  } finally { process.env = originalEnv; }
});

test('anonymous and malformed credentials get a genuine Office challenge with public origin only and no private runtime', async () => {
  const originalEnv = { ...process.env };
  process.env = { BJM_OFFICE_BASE_URL: 'https://office.example' };
  let calls = 0;
  const handler = createMcpHandler(() => { calls++; throw new Error('Private runtime must not initialize for discovery'); });
  try {
    for (const req of [
      { method: 'POST', headers: {} },
      { method: 'POST', headers: { authorization: 'Bearer fixture.supabase.jwt' } },
      { method: 'POST', headers: { authorization: `Bearer bjm_at_${'a'.repeat(43)}` }, rawHeaders: ['Authorization', 'one', 'Authorization', 'two'] },
    ]) {
      const res = response();
      await handler(req, res);
      assert.equal(res.code, 401);
      assert.match(res.headers['WWW-Authenticate'], /https:\/\/office\.example\/\.well-known\/oauth-protected-resource/);
      assert.match(res.headers['WWW-Authenticate'], /scope="office.read"/);
      assert.deepEqual(res.body, { error: 'Authentication required.' });
    }
    assert.equal(calls, 0);
  } finally { process.env = originalEnv; }
});

test('OAuth wrappers dispatch only their exact owned handler and redact unexpected private failures', async () => {
  for (const [action, method] of [['authorize', 'GET'], ['ownerCallback', 'GET'], ['token', 'POST'], ['revoke', 'POST']]) {
    let called = 0;
    const handler = createOAuthRouteHandler(action, method, () => ({ oauth: { [action]: async (_req, res) => { called++; res.status(200).json({ ok: true }); } } }));
    const denied = response();
    await handler({ method: method === 'POST' ? 'GET' : 'POST' }, denied);
    assert.equal(denied.code, 405);
    assert.equal(called, 0);
    assert.equal(denied.headers.Allow, method);
    const accepted = response();
    await handler({ method }, accepted);
    assert.equal(accepted.code, 200);
    assert.equal(called, 1);
    const failed = response();
    await createOAuthRouteHandler(action, method, () => { throw new Error('fixture-private-oauth-payload'); })({ method }, failed);
    assert.equal(failed.code, 503);
    assert.doesNotMatch(JSON.stringify(failed), /fixture-private-oauth-payload/);
  }
});

test('local HTTP discovery/OAuth precede MCP auth, liveness is public, and body/frontend limits hold', async () => {
  const originalEnv = { ...process.env };
  process.env.BJM_OFFICE_BASE_URL = 'https://office.example';
  const actions = [];
  let runtimeCalls = 0;
  const oauth = Object.fromEntries(['authorize', 'ownerCallback', 'token', 'revoke'].map(action => [action, async (req, res) => {
    actions.push({ action, body: req.body });
    res.status(200).json({ ok: true });
  }]));
  const app = createChatApp(() => { runtimeCalls++; return { oauth }; });
  const server = createServer(app);
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;
    for (const path of ['/health', '/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-authorization-server']) {
      const res = await fetch(`${base}${path}`);
      assert.equal(res.status, 200, path);
      const body = await res.json();
      assert.equal(res.headers.get('cache-control'), 'no-store');
      if (path.includes('protected-resource')) assert.deepEqual(body.scopes_supported, ['office.read']);
      if (path.includes('authorization-server')) assert.equal(body.issuer, 'https://office.example');
    }
    assert.equal(runtimeCalls, 0, 'Public metadata and liveness must not initialize the database runtime');
    const anonymous = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(anonymous.status, 401);
    assert.match(anonymous.headers.get('www-authenticate'), /scope="office.read"/);
    await anonymous.json();
    assert.equal(runtimeCalls, 0, 'Anonymous challenge must not initialize the private runtime');
    for (const [path, method] of [['/oauth/authorize', 'GET'], ['/oauth/owner/callback', 'GET'], ['/oauth/token', 'POST'], ['/oauth/revoke', 'POST']]) {
      const res = await fetch(`${base}${path}`, method === 'GET' ? {} : { method, headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'client_id=public-fixture&scope=office.read' });
      assert.equal(res.status, 200, path);
      await res.json();
    }
    assert.deepEqual(actions.map(item => item.action), ['authorize', 'ownerCallback', 'token', 'revoke']);
    assert.deepEqual(actions[2].body, { client_id: 'public-fixture', scope: 'office.read' });
    for (const [contentType, body] of [['application/json', JSON.stringify({ payload: 'x'.repeat(17000) })], ['application/x-www-form-urlencoded', `payload=${'x'.repeat(17000)}`]]) {
      const before = actions.length;
      const res = await fetch(`${base}/oauth/token`, { method: 'POST', headers: { 'Content-Type': contentType }, body });
      assert.equal(res.status, 413);
      assert.deepEqual(await res.json(), { error: 'Invalid request.' });
      assert.equal(actions.length, before);
    }
    const malformed = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"fixture-private-input":' });
    assert.equal(malformed.status, 400);
    assert.doesNotMatch(await malformed.text(), /fixture-private-input/);
    for (const path of ['/', '/assets/office.js', '/assets/office.css']) {
      const res = await fetch(`${base}${path}`);
      assert.equal(res.status, 404, path);
      assert.deepEqual(await res.json(), { error: 'Not found.' });
    }
  } finally {
    if (server.listening) {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
    process.env = originalEnv;
  }
});

test('real SDK initializes and reads all five reports through the actual API with verified context and aggregate-only store', async () => {
  const originalEnv = { ...process.env };
  const originalFetch = globalThis.fetch;
  const ownerId = '11111111-1111-4111-8111-111111111111';
  const accessHash = 'a'.repeat(64);
  const token = `bjm_at_${'b'.repeat(43)}`;
  Object.assign(process.env, {
    BJM_OFFICE_BASE_URL: 'https://office.example', SUPABASE_URL: `https://${'a'.repeat(20)}.supabase.co`,
    SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_fixture', BJM_AI_OFFICE_OWNER_USER_ID: ownerId,
    BJM_CHAT_UPSTREAM_CLIENT_ID: '22222222-2222-4222-8222-222222222222',
    BJM_CHAT_OAUTH_CLIENT_ID: 'office-fixture', BJM_CHAT_OAUTH_REDIRECT_URI: 'https://chatgpt.com/connector/oauth/fixture',
    BJM_CHAT_OAUTH_FLOW_KEY: Buffer.alloc(32, 7).toString('base64url'), BJM_CHAT_OAUTH_ENABLED: 'true',
    BJM_PUBLIC_URL: 'https://website.fixture.example',
  });
  delete process.env.SUPABASE_SECRET_KEY;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  let verified = 0, snapshots = 0, revoked = false, heads = 0, lastHttpStatus;
  const generatedAt = new Date().toISOString();
  const snapshot = {
    schema_version: 1, generated_at: generatedAt,
    metrics: { profiles: 2, cafes: 1, baristas: 1, jobs: 3, applications: 4, subscriptions: 1, payments: 0 },
    support: { total_recent: 0, open: 0 },
    billing: { subscriptions: { total: 1, active: 1, past_due: 0, canceling: 0 }, payments: { recent: 0, failed: 0, refunded: 0 } },
    unapproved_customer_payload: 'PRIVATE_RAW_ROW_CANARY',
  };
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), 'https://website.fixture.example/');
    assert.equal(init.method, 'HEAD');
    assert.equal(init.headers?.Authorization, undefined);
    heads++;
    return new Response(null, { status: 200 });
  };
  const store = { snapshot: async (...args) => {
    assert.deepEqual(args, [accessHash, 'office-fixture', 'https://office.example/mcp']);
    snapshots++;
    return structuredClone(snapshot);
  } };
  const oauth = { verifyAccessToken: async value => {
    assert.equal(value, token);
    verified++;
    if (revoked) throw new ChatOAuthError(401, 'invalid_token');
    return { ownerId, accessHash };
  } };
  const server = createServer(createChatApp(() => ({ store, oauth })));
  const client = new Client({ name: 'actual-api-offline-fixture', version: '1.0.0' });
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.address().port}/mcp`), {
      fetch: async (input, init) => {
        const response = await originalFetch(input, init);
        lastHttpStatus = response.status;
        return response;
      },
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    });
    await client.connect(transport);
    assert.match(client.getInstructions(), /BJM AI Team works in this chat on request/);
    assert.equal(client.getServerCapabilities().resources, undefined);
    const { tools } = await client.listTools();
    assert.equal(tools.length, 5);
    for (const tool of tools) {
      assert.deepEqual(tool._meta.securitySchemes, [{ type: 'oauth2', scopes: ['office.read'] }]);
      const result = await client.callTool({ name: tool.name, arguments: {} });
      assert.notEqual(result.isError, true, tool.name);
      assert.doesNotMatch(JSON.stringify(result), new RegExp(`PRIVATE_RAW_ROW_CANARY|${token}|${accessHash}|${ownerId}|sb_publishable_fixture`));
      if (tool.name === 'get_owner_overview') {
        assert.equal(result.structuredContent.business.availability, 'available');
        assert.equal(result.structuredContent.business.generated_at, generatedAt);
        assert.equal(result.structuredContent.business.metrics.profiles, 2);
      }
      if (tool.name === 'get_billing_summary') assert.equal(result.structuredContent.billing.subscriptions.active, 1);
      if (tool.name === 'get_ai_team_status') assert.equal(result.structuredContent.agents.length, 19);
    }
    assert.equal(snapshots, 4, 'Each data request gets its own aggregate-only provider closure');
    assert.equal(heads, 3);
    assert.ok(verified >= 7, 'Every HTTP request must pass the owner boundary');
    revoked = true;
    const before = snapshots;
    await assert.rejects(() => client.callTool({ name: 'get_owner_overview', arguments: {} }), /Authentication required/i);
    assert.equal(lastHttpStatus, 401, 'Revoked credential must receive the actual HTTP401 boundary');
    assert.equal(snapshots, before, 'Revoked credential must not reach the data adapter');
  } finally {
    await client.close();
    if (server.listening) {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
    globalThis.fetch = originalFetch;
    process.env = originalEnv;
  }
});

test('chat build output contains only robots.txt and removes stale frontend output', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'bjm-chat-build-test-'));
  const output = join(temporary, 'dist-chat');
  try {
    await mkdir(output);
    await writeFile(join(output, 'index.html'), 'stale legacy frontend');
    await buildChatOutput(output);
    assert.deepEqual(await readdir(output), ['robots.txt']);
    assert.equal(await readFile(join(output, 'robots.txt'), 'utf8'), 'User-agent: *\nDisallow: /\n');
  } finally { await rm(temporary, { recursive: true, force: true }); }
});
