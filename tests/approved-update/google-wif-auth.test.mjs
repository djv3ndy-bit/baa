import test,{after,before} from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {Readable} from 'node:stream';
import https from 'node:https';
import http from 'node:http';
import net from 'node:net';
import {createRequire} from 'node:module';
import {AsyncLocalStorage} from 'node:async_hooks';
import {createGoogleAuthClient} from '../../server/native-billing/googleAuth.mjs';
import {readProviderConfiguration,createProviderRuntime} from '../../server/native-billing/runtime.mjs';
import {verifyGoogleCheckoutCatalog} from '../../server/native-billing/googleCheckoutReadiness.mjs';

const require=createRequire(import.meta.url),google=require('google-auth-library'),oidc=require('@vercel/oidc');
const {SignJWT}=require('jose');
const env={NATIVE_BILLING_ENVIRONMENT:'Sandbox',VERCEL_ENV:'preview',VERCEL_TARGET_ENV:'android-testing',
  GOOGLE_PLAY_AUTH_MODE:'vercel_oidc',GOOGLE_PLAY_PRODUCT_ID:'baristamatch_cafe_pro',GOOGLE_PLAY_BASE_PLAN_ID:'monthly-us',
  GOOGLE_PLAY_PUSH_AUDIENCE:'https://android-testing.baristajobmatch.com/api/native-purchases?action=google-events',
  GOOGLE_PLAY_PUSH_SERVICE_ACCOUNT_EMAIL:'fixture-events@baristamatch.iam.gserviceaccount.com',
  GOOGLE_PLAY_WIF_PROJECT_NUMBER:'397053773139',
  GOOGLE_PLAY_WIF_SERVICE_ACCOUNT_EMAIL:'baristamatch-play-test@baristamatch.iam.gserviceaccount.com',
  GOOGLE_PLAY_WIF_PROVIDER_RESOURCE:'projects/397053773139/locations/global/workloadIdentityPools/baristamatch-android-test/providers/vercel-android-testing',
  GOOGLE_PLAY_WIF_VERCEL_ISSUER:'https://oidc.vercel.com/baristamatch',GOOGLE_PLAY_WIF_VERCEL_AUDIENCE:'https://vercel.com/baristamatch',
  GOOGLE_PLAY_WIF_VERCEL_CUSTOM_ENVIRONMENT_ID:'env_fixtureAndroidOnly',
};
const config=()=>readProviderConfiguration('google',env);
const claims=()=>({iss:env.GOOGLE_PLAY_WIF_VERCEL_ISSUER,aud:env.GOOGLE_PLAY_WIF_VERCEL_AUDIENCE,
  sub:'owner:baristamatch:project:baa:environment:android-testing',owner_id:'team_W7sLByby0CKVDax9uhMshO5I',
  project_id:'prj_VuAxQpdhDJPeTPdanA5HjtOrylA5',environment:'android-testing',
  custom_environment_id:env.GOOGLE_PLAY_WIF_VERCEL_CUSTOM_ENVIRONMENT_ID,
  iat:Math.floor(Date.now()/1000)-5,nbf:Math.floor(Date.now()/1000)-5,exp:Math.floor(Date.now()/1000)+3600});
const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048});
const jwk={...publicKey.export({format:'jwk'}),kid:'offline-fixture',alg:'RS256',use:'sig'};
const token=async(payload=claims(),key=privateKey)=>new SignJWT(payload).setProtectedHeader({alg:'RS256',kid:jwk.kid,typ:'JWT'}).sign(key);
const context=new AsyncLocalStorage(),contextSymbol=Symbol.for('@vercel/request-context');
const inRequest=(jwt,fn)=>context.run({headers:{'x-vercel-oidc-token':jwt}},fn);
let escapedNetwork=0,jwksReads=0,originalContext,originalEnv;

before(t=>{
  originalContext=globalThis[contextSymbol];globalThis[contextSymbol]={get:()=>context.getStore() || {}};
  originalEnv={token:process.env.VERCEL_OIDC_TOKEN,file:process.env.VERCEL_OIDC_TOKEN_FILE,adc:process.env.GOOGLE_APPLICATION_CREDENTIALS};
  process.env.VERCEL_OIDC_TOKEN='fallback-must-not-be-used';
  process.env.VERCEL_OIDC_TOKEN_FILE='/nonexistent/wif-test-must-not-read';
  process.env.GOOGLE_APPLICATION_CREDENTIALS='/nonexistent/wif-test-must-not-read';
  const blocked=()=>{escapedNetwork++;throw Error('Unexpected network attempt');};
  t.mock.method(net,'connect',blocked);t.mock.method(net,'createConnection',blocked);
  t.mock.method(http,'request',blocked);t.mock.method(http,'get',blocked);
  t.mock.method(https,'request',blocked);t.mock.method(globalThis,'fetch',blocked);
  // Exercise the real Vercel/Jose signature verifier with a local RSA fixture.
  // No socket is opened; every URL except the SDK's fixed JWKS endpoint fails.
  t.mock.method(https,'get',url=>{
    assert.equal(url,'https://oidc.vercel.com/.well-known/jwks');jwksReads++;
    const request=new EventEmitter();request.destroy=()=>{};
    queueMicrotask(()=>{const response=Readable.from([Buffer.from(JSON.stringify({keys:[jwk]}))]);response.statusCode=200;request.emit('response',response);});
    return request;
  });
});
after(()=>{
  if(originalContext===undefined)delete globalThis[contextSymbol];else globalThis[contextSymbol]=originalContext;
  for(const [key,value] of [['VERCEL_OIDC_TOKEN',originalEnv.token],['VERCEL_OIDC_TOKEN_FILE',originalEnv.file],['GOOGLE_APPLICATION_CREDENTIALS',originalEnv.adc]]) {
    if(value===undefined)delete process.env[key];else process.env[key]=value;
  }
  assert.equal(escapedNetwork,0);assert.equal(jwksReads,1);
});

test('WIF requires explicit mode, Sandbox custom target and exact public identity configuration',()=>{
  assert.equal(config().authMode,'vercel_oidc');assert.equal(config().credentials,undefined);
  const mutations=[
    {GOOGLE_PLAY_AUTH_MODE:'external_account'},{GOOGLE_PLAY_AUTH_MODE:undefined},{GOOGLE_PLAY_AUTH_MODE:''},
    {NATIVE_BILLING_ENVIRONMENT:'Production',VERCEL_ENV:'production'},{VERCEL_ENV:'development'},
    {VERCEL_TARGET_ENV:'preview'},{VERCEL_TARGET_ENV:undefined},{GOOGLE_PLAY_SERVICE_ACCOUNT_JSON:'{}'},
    {GOOGLE_PLAY_WIF_PROJECT_NUMBER:'other'},{GOOGLE_PLAY_WIF_SERVICE_ACCOUNT_EMAIL:'other@baristamatch.iam.gserviceaccount.com'},
    {GOOGLE_PLAY_WIF_PROVIDER_RESOURCE:'projects/1234/locations/global/workloadIdentityPools/fixture-pool/providers/fixture-provider'},
    {GOOGLE_PLAY_WIF_PROVIDER_RESOURCE:env.GOOGLE_PLAY_WIF_PROVIDER_RESOURCE.replace('baristamatch-android-test','different-pool')},
    {GOOGLE_PLAY_WIF_PROVIDER_RESOURCE:env.GOOGLE_PLAY_WIF_PROVIDER_RESOURCE.replace('vercel-android-testing','different-provider')},
    {GOOGLE_PLAY_WIF_PROVIDER_RESOURCE:'https://attacker.invalid/config'},
    {GOOGLE_PLAY_WIF_VERCEL_ISSUER:'https://oidc.vercel.com'},
    {GOOGLE_PLAY_WIF_VERCEL_ISSUER:'https://attacker.invalid'},
    {GOOGLE_PLAY_WIF_VERCEL_AUDIENCE:'https://vercel.com/other'},
    {GOOGLE_PLAY_WIF_VERCEL_CUSTOM_ENVIRONMENT_ID:undefined},{GOOGLE_PLAY_WIF_VERCEL_CUSTOM_ENVIRONMENT_ID:'REPLACE_ME'},
  ];
  for(const mutation of mutations)assert.throws(()=>readProviderConfiguration('google',{...env,...mutation}),{code:'SERVER_CONFIGURATION'});
  for(const key of Object.keys(env).filter(key=>key.startsWith('GOOGLE_PLAY_WIF_'))) {
    assert.throws(()=>readProviderConfiguration('google',{...env,[key]:undefined}),{code:'SERVER_CONFIGURATION'});
  }
});

test('JSON mode preserves exact GoogleAuth options and never loads OIDC or ADC',async()=>{
  const credentials={type:'service_account',client_email:'fixture@baristamatch.iam.gserviceaccount.com',private_key:'-----BEGIN PRIVATE KEY-----fixture'};
  const jsonEnv={...env,GOOGLE_PLAY_AUTH_MODE:undefined,GOOGLE_PLAY_SERVICE_ACCOUNT_JSON:JSON.stringify(credentials)};
  const implicit=readProviderConfiguration('google',jsonEnv);
  assert.deepEqual(readProviderConfiguration('google',{...jsonEnv,GOOGLE_PLAY_AUTH_MODE:'service_account_json'}),implicit);
  for(const authMode of [undefined,'service_account_json']) {
    const sentinel={request:()=>{}};
    const client=await createGoogleAuthClient({...implicit,authMode},{
      loadGoogle:async()=>({GoogleAuth:class {
        constructor(options){assert.deepEqual(options,{credentials,scopes:['https://www.googleapis.com/auth/androidpublisher']});}
        async getClient(){return sentinel;}
      }}),loadOidc:async()=>{throw Error('OIDC must not load');},
    });
    assert.equal(client,sentinel);
  }
  for(const invalid of [{provider:'apple'},{provider:'google'},{provider:'google',credentials:{type:'external_account'}},{...config(),authMode:'unknown'}]) {
    await assert.rejects(createGoogleAuthClient(invalid,{loadGoogle:async()=>{throw Error('SDK must not load');}}),{code:'SERVER_CONFIGURATION'});
  }
});

test('real request-context signature verification rejects wrong identity, expiry, forgery and all fallback sources',async()=>{
  const client=await createGoogleAuthClient(config());
  await assert.rejects(client.retrieveSubjectToken(),{code:'SERVER_CONFIGURATION'});
  for(const jwt of ['', 'invalid', 'x'.repeat(32769)])await assert.rejects(inRequest(jwt,()=>client.retrieveSubjectToken()),{code:'SERVER_CONFIGURATION'});
  const valid=await token();assert.equal(await inRequest(valid,()=>client.retrieveSubjectToken()),valid);
  const mutations=[{iss:'https://oidc.vercel.com'},{aud:'https://vercel.com/other'},{owner_id:'team_other'},
    {project_id:'prj_other'},{environment:'preview'},{environment:'production'},
    {custom_environment_id:'env_otherEnvironment'},{custom_environment_id:undefined},
    {sub:'owner:baristamatch:project:baa:environment:preview'},
    {exp:Math.floor(Date.now()/1000)-10},{exp:undefined},{nbf:Math.floor(Date.now()/1000)+3600},{iat:undefined}];
  for(const mutation of mutations) {
    const jwt=await token({...claims(),...mutation});
    await assert.rejects(inRequest(jwt,()=>client.retrieveSubjectToken()),{code:'SERVER_CONFIGURATION'});
  }
  const otherKey=generateKeyPairSync('rsa',{modulusLength:2048}).privateKey;
  await assert.rejects(inRequest(await token(claims(),otherKey),()=>client.retrieveSubjectToken()),{code:'SERVER_CONFIGURATION'});
  await assert.rejects(inRequest(valid,()=>createGoogleAuthClient({...config(),environment:'Production'})),{code:'SERVER_CONFIGURATION'});
});

function offlineGoogle(calls) {
  const adapter=async options=>{
    const url=String(options.url),headers=new Headers(options.headers);let data;
    if(url==='https://sts.googleapis.com/v1/token') {
      assert.equal(options.method,'POST');const body=new URLSearchParams(options.data);
      assert.equal(body.get('audience'),`//iam.googleapis.com/${env.GOOGLE_PLAY_WIF_PROVIDER_RESOURCE}`);
      assert.equal(body.get('subject_token_type'),'urn:ietf:params:oauth:token-type:jwt');
      assert.equal(body.get('scope'),'https://www.googleapis.com/auth/cloud-platform');
      calls.push({stage:'sts',subjectToken:body.get('subject_token')});
      data={access_token:'fixture-sts-access',expires_in:3600,token_type:'Bearer',issued_token_type:'urn:ietf:params:oauth:token-type:access_token'};
    } else if(url===`https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${env.GOOGLE_PLAY_WIF_SERVICE_ACCOUNT_EMAIL}:generateAccessToken`) {
      assert.equal(options.method,'POST');assert.equal(headers.get('authorization'),'Bearer fixture-sts-access');
      const body=typeof options.data==='string' ? JSON.parse(options.data) : options.data;
      assert.deepEqual(body.scope,['https://www.googleapis.com/auth/androidpublisher']);
      calls.push({stage:'impersonate'});data={accessToken:'fixture-publisher-access',expireTime:new Date(Date.now()+3600000).toISOString()};
    } else {
      assert.equal(url,'https://androidpublisher.googleapis.com/androidpublisher/v3/applications/com.baristajobmatch.app/subscriptions/baristamatch_cafe_pro');
      assert.equal(options.method,'GET');assert.equal(headers.get('authorization'),'Bearer fixture-publisher-access');
      calls.push({stage:'catalog'});data={packageName:'com.baristajobmatch.app',productId:'baristamatch_cafe_pro',basePlans:[{
        basePlanId:'monthly-us',state:'ACTIVE',autoRenewingBasePlanType:{billingPeriodDuration:'P1M'},
        regionalConfigs:[{regionCode:'US',newSubscriberAvailability:true,price:{currencyCode:'USD',units:'9',nanos:990000000}}],
      }]};
    }
    return {data,status:200,statusText:'OK',headers:new Headers(),config:options};
  };
  return {...google,IdentityPoolClient:class extends google.IdentityPoolClient {
    constructor(options){
      assert.deepEqual(Object.keys(options).sort(),['audience','scopes','service_account_impersonation_url','subject_token_supplier','subject_token_type','token_url','type']);
      super(options);this.transporter.defaults.adapter=adapter;this.stsCredential.transporter.defaults.adapter=adapter;
    }
  }};
}

test('actual Google SDK routes federation, impersonation and catalog GET; refresh reads a fresh request token',async()=>{
  const calls=[],sdk=offlineGoogle(calls),client=await createGoogleAuthClient(config(),{loadGoogle:async()=>sdk});
  const first=await token({...claims(),jti:'first'}),second=await token({...claims(),jti:'second'});
  const url='https://androidpublisher.googleapis.com/androidpublisher/v3/applications/com.baristajobmatch.app/subscriptions/baristamatch_cafe_pro';
  await inRequest(first,()=>client.request({url,method:'GET'}));
  await inRequest(second,()=>client.request({url,method:'GET'}));
  assert.deepEqual(calls.map(call=>call.stage),['sts','impersonate','catalog','catalog']);
  client.setCredentials({access_token:'expired-fixture',expiry_date:Date.now()-1000});
  await inRequest(second,()=>client.request({url,method:'GET'}));
  assert.deepEqual(calls.filter(call=>call.stage==='sts').map(call=>call.subjectToken),[first,second]);
  client.setCredentials({access_token:'expired-fixture',expiry_date:Date.now()-1000});
  const count=calls.length;await assert.rejects(client.request({url,method:'GET'}),{code:'SERVER_CONFIGURATION'});assert.equal(calls.length,count);
  await inRequest(second,()=>verifyGoogleCheckoutCatalog(config(),{loadGoogle:async()=>sdk}));
  const runtime=await createProviderRuntime(config(),{loadGoogle:async()=>sdk});
  assert.equal(runtime.environment,'Sandbox');assert.equal(typeof runtime.provider.verify,'function');
  assert.equal(escapedNetwork,0);
});

test('Apple configuration and runtime never load or inspect Google WIF even with invalid WIF environment variables',async()=>{
  const key=generateKeyPairSync('ec',{namedCurve:'prime256v1'}).privateKey.export({format:'pem',type:'pkcs8'});
  const appleEnv={...env,GOOGLE_PLAY_AUTH_MODE:'invalid',APPLE_IAP_PRODUCT_ID:'fixture.apple',APPLE_IAP_KEY_ID:'TESTKEY123',
    APPLE_IAP_ISSUER_ID:'00000000-0000-4000-8000-000000000001',APPLE_IAP_PRIVATE_KEY:key};
  const appleConfig=readProviderConfiguration('apple',appleEnv);
  assert.equal(appleConfig.authMode,undefined);
  const apple=require('@apple/app-store-server-library');
  const runtime=await createProviderRuntime(appleConfig,{
    loadApple:async()=>apple,loadGoogle:async()=>{throw Error('Google must not load');},loadOidc:async()=>{throw Error('OIDC must not load');},
  });
  assert.equal(runtime.environment,'Sandbox');await assert.rejects(runtime.provider.identify('forged.payload.signature'));
});
