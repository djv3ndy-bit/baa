import { pathToFileURL } from 'node:url';

// This is a release-tool guard, not an application billing rule. Integration
// tests must call it before constructing a client that can write test data.
export const productionProjectRef = 'lmwqrxoitraofaftpwhe';
const productionHosts = new Set([
  'baristajobmatch.com', 'www.baristajobmatch.com',
  'baa.vercel.app', 'baa-baristamatch.vercel.app',
  'baa-24zy93m74-baristamatch.vercel.app',
]);

export class UnsafeTestEnvironment extends Error {
  constructor(field) {
    super(`Test setup blocked: review ${field}. No test request was sent.`);
    this.name = 'UnsafeTestEnvironment';
    this.field = field;
  }
}

const requireValue = (condition, field) => {
  if (!condition) throw new UnsafeTestEnvironment(field);
};

function httpsUrl(value, field) {
  let url;
  try { url = new URL(value); } catch { throw new UnsafeTestEnvironment(field); }
  requireValue(url.protocol === 'https:' && !url.username && !url.password
    && !url.port && !url.search && !url.hash, field);
  return url;
}

function legacyKeyMatches(key, ref, role, field) {
  if (!key.includes('.')) return;
  let payload;
  try { payload = JSON.parse(Buffer.from(key.split('.')[1], 'base64url')); }
  catch { throw new UnsafeTestEnvironment(field); }
  // This detects a mixed-project configuration; it does not authenticate JWTs.
  requireValue(payload.ref === ref && payload.role === role, field);
}

export function assertIsolatedTestEnvironment(env) {
  const ref = env.BJM_TEST_PROJECT_REF;
  requireValue(typeof ref === 'string' && /^[a-z]{20}$/.test(ref)
    && ref !== productionProjectRef, 'BJM_TEST_PROJECT_REF');
  for (const field of ['SUPABASE_URL', 'EXPO_PUBLIC_SUPABASE_URL']) {
    const url = httpsUrl(env[field], field);
    requireValue(url.origin === `https://${ref}.supabase.co` && url.pathname === '/', field);
  }
  requireValue(env.VERCEL_ENV === 'preview', 'VERCEL_ENV');
  requireValue(env.NATIVE_BILLING_ENVIRONMENT === 'Sandbox', 'NATIVE_BILLING_ENVIRONMENT');
  requireValue(env.STRIPE_LIVEMODE === 'false', 'STRIPE_LIVEMODE');
  requireValue(/^([rs]k)_test_[A-Za-z0-9]+$/.test(env.STRIPE_RESTRICTED_KEY || ''), 'STRIPE_RESTRICTED_KEY');

  const site = httpsUrl(env.PUBLIC_SITE_URL, 'PUBLIC_SITE_URL');
  const expected = httpsUrl(env.BJM_TEST_API_ORIGIN, 'BJM_TEST_API_ORIGIN');
  requireValue(expected.hostname.endsWith('.vercel.app') && !productionHosts.has(expected.hostname)
    && expected.pathname === '/', 'BJM_TEST_API_ORIGIN');
  requireValue(site.origin === expected.origin && site.pathname === '/', 'PUBLIC_SITE_URL');
  const api = httpsUrl(env.EXPO_PUBLIC_API_BASE_URL, 'EXPO_PUBLIC_API_BASE_URL');
  requireValue(api.origin === expected.origin && /^\/api\/?$/.test(api.pathname), 'EXPO_PUBLIC_API_BASE_URL');

  const publicKey = env.SUPABASE_PUBLISHABLE_KEY;
  const secret = env.SUPABASE_SECRET_KEY;
  requireValue(typeof publicKey === 'string' && publicKey.length > 20
    && (publicKey.startsWith('sb_publishable_') || publicKey.split('.').length === 3), 'SUPABASE_PUBLISHABLE_KEY');
  requireValue(publicKey === env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY, 'EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY');
  requireValue(typeof secret === 'string' && secret.length > 20
    && (secret.startsWith('sb_secret_') || secret.split('.').length === 3), 'SUPABASE_SECRET_KEY');
  legacyKeyMatches(publicKey, ref, 'anon', 'SUPABASE_PUBLISHABLE_KEY');
  legacyKeyMatches(secret, ref, 'service_role', 'SUPABASE_SECRET_KEY');

  // No secret should enter Expo's public compile-time environment, regardless
  // of the variable name chosen for it.
  for (const [field, value] of Object.entries(env)) {
    if (!field.startsWith('EXPO_PUBLIC_') || typeof value !== 'string') continue;
    requireValue(value !== secret && !/-----BEGIN (?:EC |RSA )?PRIVATE KEY-----|\bsb_secret_|\b[rs]k_(?:live|test)_/.test(value), field);
    if (value.split('.').length === 3) {
      try {
        const payload = JSON.parse(Buffer.from(value.split('.')[1], 'base64url'));
        requireValue(payload.role !== 'service_role', field);
      } catch (error) { if (error instanceof UnsafeTestEnvironment) throw error; }
    }
  }
  return Object.freeze({ projectRef: ref, apiOrigin: expected.origin, billingEnvironment: 'Sandbox', stripeMode: 'test' });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = assertIsolatedTestEnvironment(process.env);
    console.log(JSON.stringify({ status: 'Passed', ...result,
      scope: 'Local configuration only; remote deployment and credentials still require verification' }));
  } catch (error) {
    console.error(error instanceof UnsafeTestEnvironment ? error.message : 'Test setup could not be checked. No test request was sent.');
    process.exitCode = 1;
  }
}
