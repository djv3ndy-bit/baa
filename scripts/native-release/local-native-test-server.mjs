import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';

// Local verification only. Load existing app API handlers unchanged, using the
// isolated hosted database. Never serve source files or return configuration.
const path = process.argv[2];
if (!path || (statSync(path).mode & 0o077)) throw new Error('Owner-only test configuration required');
const config = JSON.parse(readFileSync(path, 'utf8'));
const ref = 'iqtpsxxlpncaeabbcxht';
const origin = `https://${ref}.supabase.co`;
if (config.BJM_TEST_PROJECT_REF !== ref || config.SUPABASE_URL !== origin
  || !config.SUPABASE_SECRET_KEY?.startsWith('sb_secret_')) throw new Error('Unexpected test configuration');
for (const key of Object.keys(process.env)) {
  if (/^(SUPABASE_|STRIPE_|APPLE_IAP_|GOOGLE_PLAY_|RESEND_|NATIVE_|BILLING_|PUBLIC_SITE_URL$)/.test(key)) delete process.env[key];
}
Object.assign(process.env, config, {
  VERCEL_ENV: 'preview', NATIVE_BILLING_ENVIRONMENT: 'Sandbox',
  NATIVE_PURCHASES_ENABLED: 'false', BILLING_ENABLED: 'true', STRIPE_LIVEMODE: 'false',
  PUBLIC_SITE_URL: 'http://127.0.0.1:3999',
});
// Optional, explicitly approved test-only credentials allow provider management
// checks. Native purchases and real payment credentials remain unavailable.
const paymentsPath = process.argv[3];
if (paymentsPath) {
  if (statSync(paymentsPath).mode & 0o077) throw new Error('Owner-only payment test configuration required');
  const payments = JSON.parse(readFileSync(paymentsPath, 'utf8'));
  if (payments.BJM_TEST_PROJECT_REF !== ref
    || payments.STRIPE_EXPECTED_ACCOUNT_ID !== 'acct_1UANO72euSkBN6zq'
    || payments.STRIPE_PRICE_ID !== 'price_1UEqOV2euSkBN6zqUJJE5G81'
    || !payments.STRIPE_RESTRICTED_KEY?.startsWith('rk_test_')
    || !payments.STRIPE_PUBLISHABLE_KEY?.startsWith('pk_test_')) throw new Error('Approved Stripe test configuration required');
  Object.assign(process.env, {
    STRIPE_RESTRICTED_KEY: payments.STRIPE_RESTRICTED_KEY,
    STRIPE_PUBLISHABLE_KEY: payments.STRIPE_PUBLISHABLE_KEY,
    STRIPE_ACCOUNT_ID: payments.STRIPE_EXPECTED_ACCOUNT_ID,
    STRIPE_MONTHLY_PRICE_ID: payments.STRIPE_PRICE_ID,
  });
}
// A private one-shot fixture exercises native recovery through real handlers.
// This runner is never deployed; the fixture cannot be set through HTTP.
const authFaultPath = join(dirname(path), 'auth-response-once.json');
const request = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (url.origin !== origin) throw new Error('External provider access is disabled in this local account test');
  const started = Date.now();
  if (url.pathname === '/auth/v1/user' && existsSync(authFaultPath)) {
    if (statSync(authFaultPath).mode & 0o077) throw new Error('Owner-only test fixture required');
    const fault = JSON.parse(readFileSync(authFaultPath, 'utf8'));
    if (![429, 503].includes(fault.status)) throw new Error('Only retryable test faults are supported');
    unlinkSync(authFaultPath);
    console.log(JSON.stringify({testDatabasePath: url.pathname, injectedTestStatus: fault.status, consumedOnce: true}));
    return new Response(JSON.stringify({error: 'Controlled test outage'}), {status: fault.status, headers: {'Content-Type':'application/json'}});
  }
  try {
    const response = await request(input, { ...init, redirect: 'error' });
    if (!response.ok || process.env.BJM_TRACE_TEST_REQUESTS === '1') console.log(JSON.stringify({
      testDatabasePath: url.pathname, status: response.status, milliseconds: Date.now() - started,
    }));
    return response;
  } catch (error) {
    console.error(JSON.stringify({testDatabasePath:url.pathname,status:'connection_failed',milliseconds:Date.now()-started}));
    throw error;
  }
};
const routes = new Map([
  ['billing-status', ['account-billing', 'status']], ['public-config', ['config']],
  ['create-portal-session', ['account-billing', 'portal']],
  ...['config', 'account-billing', 'native-billing', 'native-purchases', 'apply-job',
    'match-application', 'conversation-details', 'send-message', 'report-error', 'delete-account',
    'push-event'].map(name => [name, [name]]),
]);
const server = createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.status = code => { res.statusCode = code; return res; };
  res.json = body => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(body)); return res; };
  try {
    if (req.headers.host !== '127.0.0.1:3999' && req.headers.host !== 'localhost:3999') return res.status(400).json({ error: 'Unexpected test host' });
    const url = new URL(req.url, 'http://127.0.0.1:3999');
    if (process.env.BJM_TRACE_TEST_REQUESTS === '1') {
      const started = Date.now();
      res.on('finish', () => console.log(JSON.stringify({testApiPath: url.pathname, status: res.statusCode, milliseconds: Date.now() - started})));
    }
    const target = routes.get(url.pathname.replace(/^\/api\//, ''));
    if (!url.pathname.startsWith('/api/') || !target) return res.status(404).json({ error: 'Test route unavailable' });
    const module = await import(new URL(`../../api/${target[0]}.js`, import.meta.url));
    req.query = Object.fromEntries(url.searchParams);
    if (target[1]) req.query.action = target[1];
    if (module.config?.api?.bodyParser !== false && req.method !== 'GET') {
      let bytes = 0; const chunks = [];
      for await (const chunk of req) { bytes += chunk.length; if (bytes > 100_000) return res.status(413).json({ error: 'Test request too large' }); chunks.push(chunk); }
      const body = Buffer.concat(chunks).toString(); req.body = body ? JSON.parse(body) : {};
    }
    await module.default(req, res);
  } catch {
    console.error('A local account-test request failed; no credentials logged.');
    if (!res.headersSent) res.status(503).json({ error: 'The local test request could not complete.' });
    else res.end();
  }
});
server.listen(3999, '127.0.0.1', () => console.log(JSON.stringify({
  status: 'Listening', url: 'http://127.0.0.1:3999', projectRef: ref,
  scope: paymentsPath
    ? 'Existing API handlers with isolated database and approved Stripe test credentials; native purchases/email/push disabled'
    : 'Existing API handlers with isolated database; external payment/email/push providers disabled',
})));
