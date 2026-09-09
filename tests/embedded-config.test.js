import test from 'node:test';
import assert from 'node:assert/strict';
import handler from '../api/config.js';

test('embedded readiness reports only a boolean and never exposes an incorrectly saved server key', () => {
  const names = ['SUPABASE_URL', 'SUPABASE_PUBLISHABLE_KEY', 'STRIPE_PUBLISHABLE_KEY', 'STRIPE_LIVEMODE', 'VERCEL_ENV'];
  const before = Object.fromEntries(names.map(name => [name, process.env[name]]));
  try {
    Object.assign(process.env, { SUPABASE_URL: 'https://fixture.supabase.co', SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_fixture', STRIPE_LIVEMODE: 'true', VERCEL_ENV: 'production' });
    for (const [key, expected] of [['pk_live_fixture', true], ['pk_test_fixture', false], ['rk_live_fixture', false], ['sk_live_fixture', false], ['', false]]) {
      process.env.STRIPE_PUBLISHABLE_KEY = key;
      const headers = {};
      let status, body;
      handler({ method: 'GET' }, { setHeader: (key, value) => { headers[key] = value; }, status: code => { status = code; return { json: result => { body = result; } }; } });
      assert.equal(status, 200);
      assert.equal(body.stripeEmbeddedCheckoutConfigured, expected);
      assert.equal(body.supabasePublishableKey, 'sb_publishable_fixture');
      assert.equal(headers['Cache-Control'], 'no-store, max-age=0');
      assert.equal(JSON.stringify(body).includes(key), key === '');
    }
  } finally {
    for (const name of names) { if (before[name] === undefined) delete process.env[name]; else process.env[name] = before[name]; }
  }
});
