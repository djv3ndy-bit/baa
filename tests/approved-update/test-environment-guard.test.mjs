import test from 'node:test';
import assert from 'node:assert/strict';
import { assertIsolatedTestEnvironment, UnsafeTestEnvironment, productionProjectRef } from '../../scripts/native-release/test-environment.mjs';

const ref = 'abcdefghijklmnopqrst';
const key = 'sb_publishable_synthetic_test_configuration';
const secret = 'sb_secret_synthetic_test_configuration';
const setup = () => ({
  BJM_TEST_PROJECT_REF: ref,
  SUPABASE_URL: `https://${ref}.supabase.co`,
  EXPO_PUBLIC_SUPABASE_URL: `https://${ref}.supabase.co`,
  SUPABASE_PUBLISHABLE_KEY: key,
  EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: key,
  SUPABASE_SECRET_KEY: secret,
  VERCEL_ENV: 'preview', NATIVE_BILLING_ENVIRONMENT: 'Sandbox', STRIPE_LIVEMODE: 'false',
  STRIPE_RESTRICTED_KEY: 'rk_test_synthetic',
  BJM_TEST_API_ORIGIN: 'https://synthetic-bjm-testing.vercel.app',
  PUBLIC_SITE_URL: 'https://synthetic-bjm-testing.vercel.app',
  EXPO_PUBLIC_API_BASE_URL: 'https://synthetic-bjm-testing.vercel.app/api',
});
const blocked = patch => assert.throws(() => assertIsolatedTestEnvironment({ ...setup(), ...patch }), UnsafeTestEnvironment);

test('isolated test configuration returns identities only, without credentials', () => {
  assert.deepEqual(assertIsolatedTestEnvironment(setup()), {
    projectRef: ref, apiOrigin: 'https://synthetic-bjm-testing.vercel.app', billingEnvironment: 'Sandbox', stripeMode: 'test',
  });
});
test('production project is rejected even when both clients agree on it', () => {
  blocked({ BJM_TEST_PROJECT_REF: productionProjectRef, SUPABASE_URL: `https://${productionProjectRef}.supabase.co`, EXPO_PUBLIC_SUPABASE_URL: `https://${productionProjectRef}.supabase.co` });
});
test('mixed backend and mobile projects are rejected before sending a request', () => {
  blocked({ SUPABASE_URL: `https://${productionProjectRef}.supabase.co` });
  blocked({ EXPO_PUBLIC_SUPABASE_URL: `https://${productionProjectRef}.supabase.co` });
});
test('missing mobile API configuration cannot silently fall back to the live website', () => {
  blocked({ EXPO_PUBLIC_API_BASE_URL: undefined });
  blocked({ EXPO_PUBLIC_API_BASE_URL: 'https://www.baristajobmatch.com/api' });
  blocked({ PUBLIC_SITE_URL: 'https://www.baristajobmatch.com' });
});
test('production deployment and live Stripe credentials or mode are rejected', () => {
  blocked({ VERCEL_ENV: 'production' }); blocked({ NATIVE_BILLING_ENVIRONMENT: 'Production' });
  blocked({ STRIPE_LIVEMODE: 'true' }); blocked({ STRIPE_RESTRICTED_KEY: 'rk_live_synthetic' });
});
test('credentials, query strings, lookalike domains and different API hosts are rejected', () => {
  for (const value of ['http://synthetic-bjm-testing.vercel.app', 'https://user:password@synthetic-bjm-testing.vercel.app', 'https://synthetic-bjm-testing.vercel.app?query=1', 'https://synthetic-bjm-testing.vercel.app.attacker.example']) blocked({ BJM_TEST_API_ORIGIN: value });
  blocked({ EXPO_PUBLIC_API_BASE_URL: 'https://different-preview.vercel.app/api' });
});
test('server secrets cannot be exposed through any Expo public variable', () => {
  blocked({ EXPO_PUBLIC_UNKNOWN: secret });
  blocked({ EXPO_PUBLIC_UNKNOWN: 'rk_test_synthetic' });
  blocked({ EXPO_PUBLIC_UNKNOWN: '-----BEGIN PRIVATE KEY-----\nsynthetic' });
});
test('legacy Supabase keys must belong to the intended test project and role', () => {
  const jwt = payload => `header.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`;
  const publicJwt = jwt({ ref, role: 'anon' });
  assert.equal(assertIsolatedTestEnvironment({ ...setup(), SUPABASE_PUBLISHABLE_KEY: publicJwt, EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: publicJwt, SUPABASE_SECRET_KEY: jwt({ ref, role: 'service_role' }) }).projectRef, ref);
  blocked({ SUPABASE_SECRET_KEY: jwt({ ref: productionProjectRef, role: 'service_role' }) });
  blocked({ EXPO_PUBLIC_UNKNOWN: jwt({ ref, role: 'service_role' }) });
});
test('configuration errors do not echo secret values', () => {
  const bad = 'rk_live_do_not_print_this_secret';
  try { assertIsolatedTestEnvironment({ ...setup(), STRIPE_RESTRICTED_KEY: bad }); assert.fail('Expected rejection'); }
  catch (error) { assert.ok(error instanceof UnsafeTestEnvironment); assert.ok(!error.message.includes(bad)); }
});
