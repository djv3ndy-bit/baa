import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { appleRootCertificates, readProviderConfiguration, createProviderRuntime } from '../../server/native-billing/runtime.mjs';

const { privateKey }=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
const appleEnv={NATIVE_BILLING_ENVIRONMENT:'Sandbox',VERCEL_ENV:'preview',APPLE_IAP_PRODUCT_ID:'test.monthly',APPLE_IAP_KEY_ID:'TESTKEY123',
  APPLE_IAP_ISSUER_ID:'00000000-0000-4000-8000-000000000001',APPLE_IAP_PRIVATE_KEY:privateKey.export({format:'pem',type:'pkcs8'})};

test('the three pinned Apple trust roots are valid; expired trust roots fail closed',()=>{
  assert.equal(appleRootCertificates().length,3);assert.throws(()=>appleRootCertificates(Date.parse('2100-01-01')),{code:'SERVER_CONFIGURATION'});
});
test('missing configuration, mixed environments, unknown providers and invalid signing keys fail closed',()=>{
  assert.throws(()=>readProviderConfiguration('apple',{}),{code:'SERVER_CONFIGURATION'});
  for(const env of [{...appleEnv,VERCEL_ENV:'production'},{...appleEnv,NATIVE_BILLING_ENVIRONMENT:'Production'},{...appleEnv,APPLE_IAP_PRIVATE_KEY:'not-a-key'}])assert.throws(()=>readProviderConfiguration('apple',env),{code:'SERVER_CONFIGURATION'});
  assert.throws(()=>readProviderConfiguration('stripe',appleEnv),{code:'SERVER_CONFIGURATION'});
  const config=readProviderConfiguration('apple',appleEnv);assert.equal(config.bundleId,'com.baristajobmatch.app');assert.equal(config.appAppleId,6807117736);
});
test('Google configuration rejects arbitrary credential types and token endpoints',()=>{
  const env={NATIVE_BILLING_ENVIRONMENT:'Sandbox',VERCEL_ENV:'preview',GOOGLE_PLAY_PRODUCT_ID:'test.monthly',GOOGLE_PLAY_BASE_PLAN_ID:'monthly',
    GOOGLE_PLAY_PUSH_AUDIENCE:'https://test.invalid/api/native-purchases?action=google-events',GOOGLE_PLAY_PUSH_SERVICE_ACCOUNT_EMAIL:'events@test.iam.gserviceaccount.com'};
  for(const credentials of [{type:'external_account'},{type:'service_account',client_email:'billing@test.iam.gserviceaccount.com',private_key:'-----BEGIN PRIVATE KEY-----',token_uri:'https://attacker.invalid/token'}])assert.throws(()=>readProviderConfiguration('google',{...env,GOOGLE_PLAY_SERVICE_ACCOUNT_JSON:JSON.stringify(credentials)}),{code:'SERVER_CONFIGURATION'});
});

// Before the manifest patch is approved, run with the isolated reviewed SDK
// directory. After approval, normal module resolution uses root dependencies.
const sdkRequire=createRequire(process.env.NATIVE_BILLING_SDK_ROOT ? resolve(process.env.NATIVE_BILLING_SDK_ROOT,'package.json') : new URL('../../package.json',import.meta.url));
test('the actual Apple server library rejects a forged receipt with the pinned roots and online checks enabled',async()=>{
  const apple=sdkRequire('@apple/app-store-server-library');
  const runtime=await createProviderRuntime(readProviderConfiguration('apple',appleEnv),{loadApple:async()=>apple});
  await assert.rejects(runtime.provider.identify('forged.payload.signature'));
  await assert.rejects(runtime.provider.verify('forged.payload.signature','00000000-0000-4000-8000-000000000099'));
});
test('the actual Google JWT verifier rejects malformed Pub/Sub identity with certificate retrieval isolated',async()=>{
  const google=sdkRequire('google-auth-library');
  const rsa=generateKeyPairSync('rsa',{modulusLength:2048}).privateKey.export({format:'pem',type:'pkcs8'});
  const config={provider:'google',environment:'Sandbox',productId:'test.monthly',basePlanId:'monthly',packageName:'com.baristajobmatch.app',
    audience:'https://test.invalid/api/native-purchases?action=google-events',serviceAccountEmail:'events@test.iam.gserviceaccount.com',
    credentials:{type:'service_account',client_email:'billing@test.iam.gserviceaccount.com',private_key:rsa}};
  class OfflineOAuth2Client extends google.OAuth2Client {
    async getFederatedSignonCertsAsync() { return { certs:{} }; }
  }
  const runtime=await createProviderRuntime(config,{loadGoogle:async()=>({...google,OAuth2Client:OfflineOAuth2Client})});
  await assert.rejects(runtime.notification('Bearer invalid-token',{message:{messageId:'event',data:'e30='}}),/Wrong number of segments/);
});
