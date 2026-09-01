import test from 'node:test';
import assert from 'node:assert/strict';
import handler, { buildAccountDirectory } from '../api/analytics.js';

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

test('builds a privacy-minimized account directory with creation dates and locations', () => {
  const rows = buildAccountDirectory([
    { id: 'barista-id', role: 'barista', display_name: 'Taylor', location: 'Orlando, FL', preferred_city: 'Miami', preferred_state: 'FL', preferred_postal_code: '33101', created_at: '2026-08-31T10:00:00Z' },
    { id: 'cafe-id', role: 'cafe_owner_manager', cafe_name: 'Sunrise Coffee', location: 'Tampa, FL', created_at: '2026-08-30T10:00:00Z' },
    { id: 'admin-id', role: 'support_admin', display_name: 'Private Admin', created_at: '2026-09-01T10:00:00Z' },
  ], [
    { owner_id: 'cafe-id', city: 'St. Petersburg', state: 'FL', postal_code: '33701', created_at: '2026-09-01T10:00:00Z' },
  ], [
    { user_id: 'cafe-id', status: 'trialing', complimentary_access: true, stripe_subscription_id: null, owner_paused_at: null },
  ]);
  assert.deepEqual(rows.map((row) => ({ name: row.name, city: row.city, zip: row.postal_code })), [
    { name: 'Taylor', city: 'Miami', zip: '33101' },
    { name: 'Sunrise Coffee', city: 'St. Petersburg', zip: '33701' },
  ]);
  assert.equal(rows[1].subscription.pause_supported, true);
  assert.equal('email' in rows[0], false);
  assert.equal(rows.some((row) => row.user_id === 'admin-id'), false);
});

test('allows an approved owner to pause a complimentary café subscription', async () => {
  const userId = '11111111-1111-4111-8111-111111111111';
  let patchBody;
  await withAnalyticsEnvironment(async (url, options = {}) => {
    const requestUrl = String(url);
    if (requestUrl.endsWith('/auth/v1/user')) return { ok: true, json: async () => ({ id: 'owner-user-id' }) };
    if (requestUrl.includes('/rest/v1/support_admins?')) return { ok: true, json: async () => [{ user_id: 'owner-user-id' }] };
    if (requestUrl.includes('/rest/v1/cafe_subscriptions?') && options.method === 'PATCH') {
      patchBody = JSON.parse(options.body);
      return { ok: true, json: async () => [{ user_id: userId, status: 'trialing', complimentary_access: true, owner_paused_at: patchBody.owner_paused_at }] };
    }
    if (requestUrl.includes('/rest/v1/cafe_subscriptions?')) {
      return { ok: true, json: async () => [{ user_id: userId, status: 'trialing', complimentary_access: true, stripe_subscription_id: null, owner_paused_at: null }] };
    }
    throw new Error(`Unexpected request: ${requestUrl}`);
  }, async () => {
    const res = response();
    await handler({ method: 'PATCH', headers: { authorization: 'Bearer owner-session-token' }, body: { action: 'set_cafe_subscription_access', user_id: userId, enabled: false } }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    assert.ok(Number.isFinite(Date.parse(patchBody.owner_paused_at)));
    assert.equal('stripe_subscription_id' in patchBody, false);
  });
});

test('refuses to treat a platform pause as a Stripe payment pause', async () => {
  const userId = '22222222-2222-4222-8222-222222222222';
  await withAnalyticsEnvironment(async (url) => {
    const requestUrl = String(url);
    if (requestUrl.endsWith('/auth/v1/user')) return { ok: true, json: async () => ({ id: 'owner-user-id' }) };
    if (requestUrl.includes('/rest/v1/support_admins?')) return { ok: true, json: async () => [{ user_id: 'owner-user-id' }] };
    if (requestUrl.includes('/rest/v1/cafe_subscriptions?')) {
      return { ok: true, json: async () => [{ user_id: userId, stripe_subscription_id: 'sub_connected', owner_paused_at: null }] };
    }
    throw new Error(`Unexpected request: ${requestUrl}`);
  }, async () => {
    const res = response();
    await handler({ method: 'PATCH', headers: { authorization: 'Bearer owner-session-token' }, body: { action: 'set_cafe_subscription_access', user_id: userId, enabled: false } }, res);
    assert.equal(res.statusCode, 409);
    assert.match(res.body.error, /Stripe billing/);
  });
});

test('does not grant complimentary access through a resume request unless the owner paused it', async () => {
  const userId = '33333333-3333-4333-8333-333333333333';
  let patchRequested = false;
  await withAnalyticsEnvironment(async (url, options = {}) => {
    const requestUrl = String(url);
    if (requestUrl.endsWith('/auth/v1/user')) return { ok: true, json: async () => ({ id: 'owner-user-id' }) };
    if (requestUrl.includes('/rest/v1/support_admins?')) return { ok: true, json: async () => [{ user_id: 'owner-user-id' }] };
    if (requestUrl.includes('/rest/v1/cafe_subscriptions?') && options.method === 'PATCH') patchRequested = true;
    if (requestUrl.includes('/rest/v1/cafe_subscriptions?')) {
      return { ok: true, json: async () => [{ user_id: userId, complimentary_access: false, stripe_subscription_id: null, owner_paused_at: null }] };
    }
    throw new Error(`Unexpected request: ${requestUrl}`);
  }, async () => {
    const res = response();
    await handler({ method: 'PATCH', headers: { authorization: 'Bearer owner-session-token' }, body: { action: 'set_cafe_subscription_access', user_id: userId, enabled: true } }, res);
    assert.equal(res.statusCode, 409);
    assert.match(res.body.error, /not paused by the owner/);
    assert.equal(patchRequested, false);
  });
});
