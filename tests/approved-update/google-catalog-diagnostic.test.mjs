import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {googleCatalogDiagnosticHandler} from '../../server/native-billing/googleCatalogDiagnostic.mjs';

// Explicit synthetic fixture, never a real deployment secret.
const secret=Buffer.alloc(32,1).toString('base64url');
const env={GOOGLE_PLAY_CATALOG_DIAGNOSTIC_SECRET:secret,GOOGLE_PLAY_AUTH_MODE:'vercel_oidc',
  NATIVE_BILLING_ENVIRONMENT:'Sandbox',NATIVE_PURCHASES_ENABLED:'false',BILLING_ENABLED:'false',
  VERCEL_ENV:'preview',VERCEL_TARGET_ENV:'android-testing',VERCEL_URL:'baa-fixture-baristamatch.vercel.app',
  GOOGLE_PLAY_PRODUCT_ID:'baristamatch_cafe_pro',GOOGLE_PLAY_BASE_PLAN_ID:'monthly-us',
  GOOGLE_PLAY_WIF_PROJECT_NUMBER:'397053773139',
  GOOGLE_PLAY_WIF_SERVICE_ACCOUNT_EMAIL:'baristamatch-play-test@baristamatch.iam.gserviceaccount.com',
  GOOGLE_PLAY_WIF_PROVIDER_RESOURCE:'projects/397053773139/locations/global/workloadIdentityPools/baristamatch-android-test/providers/vercel-android-testing',
  GOOGLE_PLAY_WIF_VERCEL_ISSUER:'https://oidc.vercel.com/baristamatch',GOOGLE_PLAY_WIF_VERCEL_AUDIENCE:'https://vercel.com/baristamatch',
  GOOGLE_PLAY_WIF_VERCEL_CUSTOM_ENVIRONMENT_ID:'env_fixtureAndroidOnly',
};
async function run({environment={},request={},verifyCatalog=async()=>{}}={}) {
  const calls=[],handler=googleCatalogDiagnosticHandler({env:{...env,...environment},verifyCatalog:async config=>{calls.push(config);await verifyCatalog(config);}});
  const req={method:'GET',query:{},headers:{host:env.VERCEL_URL,authorization:`Bearer ${secret}`},...request};
  const res={headers:{},setHeader(key,value){this.headers[key]=value;},status(code){this.code=code;return this;},json(body){this.body=body;return this;}};
  await handler(req,res);return {res,calls};
}

test('authorized isolated GET validates only the fixed Google catalog and returns safe metadata',async()=>{
  const {res,calls}=await run();
  assert.equal(res.code,200);assert.equal(calls.length,1);
  assert.deepEqual(calls[0],{provider:'google',environment:'Sandbox',packageName:'com.baristajobmatch.app',
    productId:'baristamatch_cafe_pro',basePlanId:'monthly-us',authMode:'vercel_oidc',wif:{
      projectNumber:env.GOOGLE_PLAY_WIF_PROJECT_NUMBER,serviceAccountEmail:env.GOOGLE_PLAY_WIF_SERVICE_ACCOUNT_EMAIL,
      providerResource:env.GOOGLE_PLAY_WIF_PROVIDER_RESOURCE,issuer:env.GOOGLE_PLAY_WIF_VERCEL_ISSUER,
      audience:env.GOOGLE_PLAY_WIF_VERCEL_AUDIENCE,customEnvironmentId:env.GOOGLE_PLAY_WIF_VERCEL_CUSTOM_ENVIRONMENT_ID,
    }});
  assert.equal(res.headers['Cache-Control'],'no-store');
  assert.deepEqual(res.body,{catalogValidated:true,provider:'google',environment:'Sandbox',packageName:'com.baristajobmatch.app',
    productId:'baristamatch_cafe_pro',basePlanId:'monthly-us',billingPeriod:'P1M',region:'US',price:'USD 9.99',
    customEnvironmentVerified:true,purchasePermissionsVerified:false});
  assert.equal(JSON.stringify(res.body).includes(secret),false);
  assert.equal(JSON.stringify(res.body).includes(env.GOOGLE_PLAY_WIF_VERCEL_CUSTOM_ENVIRONMENT_ID),false);
});

test('wrong/missing scope, catalog, host, flags or secret configuration hides the endpoint before any Google call',async()=>{
  const mutations=[{GOOGLE_PLAY_AUTH_MODE:undefined},{GOOGLE_PLAY_AUTH_MODE:'service_account_json'},
    {NATIVE_BILLING_ENVIRONMENT:'Production',VERCEL_ENV:'production'},{VERCEL_ENV:'development'},
    {VERCEL_TARGET_ENV:'preview'},{NATIVE_PURCHASES_ENABLED:'true'},{NATIVE_PURCHASES_ENABLED:undefined},
    {BILLING_ENABLED:'true'},{BILLING_ENABLED:undefined},{GOOGLE_PLAY_PRODUCT_ID:'other'},{GOOGLE_PLAY_BASE_PLAN_ID:'other'},
    {VERCEL_URL:undefined},{VERCEL_URL:'www.baristajobmatch.com'},{GOOGLE_PLAY_CATALOG_DIAGNOSTIC_SECRET:undefined},
    {GOOGLE_PLAY_CATALOG_DIAGNOSTIC_SECRET:''},{GOOGLE_PLAY_CATALOG_DIAGNOSTIC_SECRET:'short'},
    {GOOGLE_PLAY_CATALOG_DIAGNOSTIC_SECRET:'!'.repeat(43)},{GOOGLE_PLAY_CATALOG_DIAGNOSTIC_SECRET:'a'.repeat(43)},
  ];
  for(const environment of mutations){const {res,calls}=await run({environment});assert.equal(res.code,404);assert.deepEqual(calls,[]);}
  for(const request of [{method:'POST'},{method:'HEAD'},{method:'OPTIONS'},{query:{productId:'other'}},{query:{customEnvironmentId:'env_otherEnvironment'}},
    {headers:{host:'android-testing.baristajobmatch.com',authorization:`Bearer ${secret}`}}]) {
    const {res,calls}=await run({request});assert.equal(res.code,404);assert.deepEqual(calls,[]);
  }
});

test('missing or incorrect bearer authentication cannot make a Google request',async()=>{
  for(const authorization of [undefined,'',[`Bearer ${secret}`],`Bearer ${Buffer.alloc(32,2).toString('base64url')}`,`Basic ${secret}`,`Bearer ${secret} `]) {
    const {res,calls}=await run({request:{headers:{host:env.VERCEL_URL,authorization}}});
    assert.equal(res.code,401);assert.deepEqual(res.body,{error:'Unauthorized.'});assert.deepEqual(calls,[]);
  }
});

test('invalid WIF config or any upstream failure returns no credential, token, error message or successful check',async t=>{
  t.mock.method(console,'error',()=>assert.fail('diagnostic must not log upstream errors'));
  const malformed=await run({environment:{GOOGLE_PLAY_SERVICE_ACCOUNT_JSON:'{}'}});
  assert.equal(malformed.res.code,503);assert.deepEqual(malformed.calls,[]);
  for(const customEnvironmentId of [undefined,'','REPLACE_ME']) {
    const invalid=await run({environment:{GOOGLE_PLAY_WIF_VERCEL_CUSTOM_ENVIRONMENT_ID:customEnvironmentId}});
    assert.equal(invalid.res.code,503);assert.deepEqual(invalid.calls,[]);
  }
  const failed=await run({verifyCatalog:async()=>{throw Object.assign(Error(`sensitive fixture ${secret}`),{response:{data:{access_token:'fixture-private-token'}}});}});
  assert.equal(failed.res.code,503);assert.deepEqual(failed.res.body,{error:'Catalog validation unavailable.'});
  assert.equal(JSON.stringify(failed.res).includes(secret),false);assert.equal(JSON.stringify(failed.res).includes('fixture-private-token'),false);
});

test('the route imports only the diagnostic and has no database, receipt or mutation wiring',()=>{
  const route=readFileSync(new URL('../../api/google-play-catalog-check.js',import.meta.url),'utf8');
  assert.match(route,/export default googleCatalogDiagnosticHandler\(\)/);
  assert.deepEqual([...route.matchAll(/from '([^']+)'/g)].map(value=>value[1]),['../server/native-billing/googleCatalogDiagnostic.mjs']);
  const handler=readFileSync(new URL('../../server/native-billing/googleCatalogDiagnostic.mjs',import.meta.url),'utf8');
  assert.deepEqual([...handler.matchAll(/from '([^']+)'/g)].map(value=>value[1]),['node:crypto','./googleAuth.mjs','./googleCheckoutReadiness.mjs']);
});
