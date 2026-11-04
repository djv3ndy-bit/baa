import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createHash, createPrivateKey, X509Certificate } from 'node:crypto';
import { appleProvider, googleProvider, verifiedGoogleNotification } from './providers.mjs';
import { PurchaseVerificationError } from './verifiedStatus.mjs';
import { checkedBillingContext } from './billingContext.mjs';

// These identities are the existing app.json bundle/package and eas.json app.
const bundleId = 'com.baristajobmatch.app';
const appAppleId = 6807117736;
const rootHashes = {
  'AppleIncRootCertificate.cer': 'b0b1730ecbc7ff4505142c49f1295e6eda6bcaed7e2c68c5be91b5a11001f024',
  'AppleRootCA-G2.cer': 'c2b9b042dd57830e7d117dac55ac8ae19407d38e41d88f3215bc3a890444a050',
  'AppleRootCA-G3.cer': '63343abfb89a6a03ebb57e9b3f5fa7be7c4f5c756f3017b3a8c488c3653e9179',
};
const check = condition => { if (!condition) throw new PurchaseVerificationError('SERVER_CONFIGURATION'); };
const value = (environment, key, pattern) => {
  const result = environment[key]; check(typeof result === 'string' && pattern.test(result)); return result;
};

export function appleRootCertificates(now = Date.now()) {
  return Object.entries(rootHashes).map(([name, hash]) => {
    const data = readFileSync(new URL(`./certificates/${name}`, import.meta.url));
    check(createHash('sha256').update(data).digest('hex') === hash);
    const certificate = new X509Certificate(data);
    check(certificate.ca && certificate.verify(certificate.publicKey) && Date.parse(certificate.validFrom) <= now && Date.parse(certificate.validTo) > now);
    return data;
  });
}

export function readProviderConfiguration(provider, env = process.env) {
  check(['apple', 'google'].includes(provider));
  const environment = value(env, 'NATIVE_BILLING_ENVIRONMENT', /^(Sandbox|Production)$/);
  // A preview or staging service cannot silently start processing live receipts.
  check(env.VERCEL_ENV !== 'production' || environment === 'Production');
  check(environment !== 'Production' || env.VERCEL_ENV === 'production');
  if (provider === 'apple') {
    const productId = value(env, 'APPLE_IAP_PRODUCT_ID', /^[A-Za-z0-9_.-]{1,255}$/);
    const issuerId = value(env, 'APPLE_IAP_ISSUER_ID', /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i);
    const keyId = value(env, 'APPLE_IAP_KEY_ID', /^[A-Z0-9]{10}$/);
    const privateKey = value(env, 'APPLE_IAP_PRIVATE_KEY', /^-----BEGIN PRIVATE KEY-----[\s\S]+-----END PRIVATE KEY-----\s*$/);
    try {
      const key = createPrivateKey(privateKey);
      check(key.asymmetricKeyType === 'ec' && key.asymmetricKeyDetails?.namedCurve === 'prime256v1');
    } catch { throw new PurchaseVerificationError('SERVER_CONFIGURATION'); }
    return { provider, environment, productId, issuerId, keyId, privateKey, bundleId, appAppleId };
  }
  const productId = value(env, 'GOOGLE_PLAY_PRODUCT_ID', /^[a-z0-9][a-z0-9_.]{0,254}$/);
  const basePlanId = value(env, 'GOOGLE_PLAY_BASE_PLAN_ID', /^[a-z0-9][a-z0-9-]{0,62}$/);
  const audience = value(env, 'GOOGLE_PLAY_PUSH_AUDIENCE', /^https:\/\/[^\s]{1,2000}$/);
  const serviceAccountEmail = value(env, 'GOOGLE_PLAY_PUSH_SERVICE_ACCOUNT_EMAIL', /^[a-z0-9._-]+@[a-z0-9.-]+\.iam\.gserviceaccount\.com$/);
  let credentials;
  try { credentials = JSON.parse(value(env, 'GOOGLE_PLAY_SERVICE_ACCOUNT_JSON', /^[\s\S]{1,32768}$/)); }
  catch { throw new PurchaseVerificationError('SERVER_CONFIGURATION'); }
  check(credentials?.type === 'service_account' && typeof credentials.client_email === 'string'
    && /^[a-z0-9._-]+@[a-z0-9.-]+\.iam\.gserviceaccount\.com$/.test(credentials.client_email)
    && typeof credentials.private_key === 'string' && credentials.private_key.startsWith('-----BEGIN PRIVATE KEY-----')
    && (!credentials.token_uri || credentials.token_uri === 'https://oauth2.googleapis.com/token'));
  // Do not pass arbitrary external-account credential fields into Google's SDK.
  return { provider, environment, productId, basePlanId, audience, serviceAccountEmail, packageName: bundleId,
    credentials: { type: 'service_account', client_email: credentials.client_email, private_key: credentials.private_key } };
}

/** The context comes only from the service-role account resolver. */
export function readContextConfiguration(provider, context, env=process.env) {
  const trusted=checkedBillingContext(context), config=readProviderConfiguration(provider,env);
  check(!trusted.appleSandboxTester || provider==='apple');
  check(trusted.environment===config.environment || (provider==='apple' && trusted.appleSandboxTester
    && trusted.environment==='Sandbox' && config.environment==='Production' && env.VERCEL_ENV==='production'));
  return {...config,environment:trusted.environment};
}

/** Verification-only candidate. Signature/owner/DB checks still gate writes;
 * the environment argument is a server constant, never an HTTP/JWS claim. */
export function readAppleEventConfiguration(environment,env=process.env) {
  const config=readProviderConfiguration('apple',env);
  check(['Production','Sandbox'].includes(environment));
  check(environment===config.environment || (environment==='Sandbox' && config.environment==='Production' && env.VERCEL_ENV==='production'));
  return {...config,environment};
}

export function providerRuntimeCache(createRuntime=createProviderRuntime) {
  const values=new Map();
  return config => {
    const key=`${config.provider}:${config.environment}`;
    if(!values.has(key))values.set(key,Promise.resolve().then(()=>createRuntime(config)).catch(error=>{values.delete(key);throw error;}));
    return values.get(key);
  };
}

export async function createProviderRuntime(config, {
  loadApple = () => import('@apple/app-store-server-library'),
  loadGoogle = () => import('google-auth-library'),
  appleExistingStatusFetch,
  appleExistingStatusTimeoutMs = 10_000,
} = {}) {
  if (config.provider === 'apple') {
    const { AppStoreServerAPIClient, SignedDataVerifier, Environment, VerificationException, VerificationStatus } = await loadApple();
    const environment = config.environment === 'Production' ? Environment.PRODUCTION : Environment.SANDBOX;
    const verifier = new SignedDataVerifier(appleRootCertificates(), true, environment, config.bundleId, config.appAppleId);
    const client = new AppStoreServerAPIClient(config.privateKey, config.keyId, config.issuerId, config.bundleId, environment);
    const readExistingStatus = async (originalId, { signal } = {}) => {
      check(Number.isInteger(appleExistingStatusTimeoutMs) && appleExistingStatusTimeoutMs >= 1 && appleExistingStatusTimeoutMs <= 10_000);
      // The pinned SDK 3.1.0 declares makeFetchRequest as a protected extension
      // seam. Use its own node-fetch dependency, with no unsupported constructor
      // options or private SDK field access. The legacy client stays untouched.
      const fromHere = createRequire(import.meta.url);
      const fetchExisting = appleExistingStatusFetch || createRequire(fromHere.resolve('@apple/app-store-server-library'))('node-fetch');
      check(typeof fetchExisting === 'function');
      const origin = config.environment === 'Production' ? 'https://api.storekit.apple.com' : 'https://api.storekit-sandbox.apple.com';
      const controller = new AbortController();
      const abort = () => controller.abort();
      if (signal?.aborted) throw new PurchaseVerificationError('REQUEST_ABORTED');
      signal?.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(() => controller.abort(), appleExistingStatusTimeoutMs);
      class ExistingStatusClient extends AppStoreServerAPIClient {
        async makeFetchRequest(path, query, method, body, headers) {
          check(method === 'GET' && path === `/inApps/v1/subscriptions/${originalId}` && query.toString() === '' && body === undefined);
          return fetchExisting(`${origin}/inApps/v1/subscriptions/${encodeURIComponent(originalId)}`, {
            method, body, headers, signal: controller.signal, redirect: 'error',
          });
        }
      }
      try {
        const bounded = new ExistingStatusClient(config.privateKey, config.keyId, config.issuerId, config.bundleId, environment);
        // Keep the abort timer through the SDK's response.json(), not merely
        // until response headers arrive. This does not time out OCSP verification.
        return await bounded.getAllSubscriptionStatuses(originalId);
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
      }
    };
    return { environment: config.environment, provider: appleProvider({ ...config, client, verifier, readExistingStatus }),
      isEnvironmentMismatch: error => Boolean(VerificationException && error instanceof VerificationException
        && error.status===VerificationStatus.INVALID_ENVIRONMENT),
      // The SDK checks Production appAppleId before environment; that optional
      // Sandbox field may be absent. The second verifier still checks everything.
      mayVerifySandbox: error => Boolean(VerificationException && error instanceof VerificationException
        && [VerificationStatus.INVALID_ENVIRONMENT,VerificationStatus.INVALID_APP_IDENTIFIER].includes(error.status)) };
  }
  check(config.provider === 'google');
  const { GoogleAuth, OAuth2Client } = await loadGoogle();
  const auth = new GoogleAuth({ credentials: config.credentials, scopes: ['https://www.googleapis.com/auth/androidpublisher'] });
  const authClient = await auth.getClient();
  const oauthClient = new OAuth2Client();
  return { environment: config.environment, provider: googleProvider({ ...config, authClient }),
    notification: (authorization, body) => verifiedGoogleNotification({ authorization, body, oauthClient,
      audience: config.audience, serviceAccountEmail: config.serviceAccountEmail, packageName: config.packageName }) };
}
