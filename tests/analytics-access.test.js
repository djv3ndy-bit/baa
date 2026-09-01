import test from 'node:test';
import assert from 'node:assert/strict';
import handler from '../api/analytics.js';

function response() {
  return {
    statusCode: null,
    body: null,
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    end() { return this; },
  };
}

async function withAnalyticsEnvironment(fetchImpl, callback) {
  const previous = {
    url: process.env.SUPABASE_URL,
    publishable: process.env.SUPABASE_PUBLISHABLE_KEY,
    secret: process.env.SUPABASE_SECRET_KEY,
    fetch: global.fetch,
  };
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_PUBLISHABLE_KEY = 'test-publishable-key';
  process.env.SUPABASE_SECRET_KEY = 'test-secret-key';
  global.fetch = fetchImpl;
  try {
    await callback();
  } finally {
    for (const [key, value] of [['SUPABASE_URL', previous.url], ['SUPABASE_PUBLISHABLE_KEY', previous.publishable], ['SUPABASE_SECRET_KEY', previous.secret]]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    global.fetch = previous.fetch;
  }
}

test('rejects an unauthenticated owner access check without querying Supabase', async () => {
  await withAnalyticsEnvironment(async () => { throw new Error('fetch must not be called'); }, async () => {
    const res = response();
    await handler({ method: 'HEAD', headers: {} }, res);
    assert.equal(res.statusCode, 403);
    assert.equal(res.body, null);
  });
});

test('confirms an approved owner without loading the analytics report', async () => {
  const requests = [];
  await withAnalyticsEnvironment(async (url) => {
    requests.push(String(url));
    if (String(url).endsWith('/auth/v1/user')) return { ok: true, json: async () => ({ id: 'owner-user-id' }) };
    if (String(url).includes('/rest/v1/support_admins?')) return { ok: true, json: async () => [{ user_id: 'owner-user-id' }] };
    throw new Error(`Unexpected analytics request: ${url}`);
  }, async () => {
    const res = response();
    await handler({ method: 'HEAD', headers: { authorization: 'Bearer owner-session-token' } }, res);
    assert.equal(res.statusCode, 204);
    assert.equal(res.body, null);
    assert.equal(requests.length, 2);
    assert.equal(requests.some((url) => url.includes('/rpc/owner_')), false);
  });
});

test('rejects a signed-in user who is not on the private owner list', async () => {
  await withAnalyticsEnvironment(async (url) => {
    if (String(url).endsWith('/auth/v1/user')) return { ok: true, json: async () => ({ id: 'regular-user-id' }) };
    return { ok: true, json: async () => [] };
  }, async () => {
    const res = response();
    await handler({ method: 'HEAD', headers: { authorization: 'Bearer regular-session-token' } }, res);
    assert.equal(res.statusCode, 403);
    assert.equal(res.body, null);
  });
});
