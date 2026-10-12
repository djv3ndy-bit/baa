import test,{after,before} from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {Readable} from 'node:stream';
import {AsyncLocalStorage} from 'node:async_hooks';
import {createRequire} from 'node:module';
import https from 'node:https';
import http from 'node:http';
import net from 'node:net';
import {createGoogleAuthClient,readGoogleWifConfiguration} from '../../server/native-billing/googleAuth.mjs';
import {readProviderConfiguration} from '../../server/native-billing/runtime.mjs';

const require=createRequire(import.meta.url),google=require('google-auth-library'),oidc=require('@vercel/oidc');
const {SignJWT}=require('jose');
const env={NATIVE_BILLING_ENVIRONMENT:'Production',VERCEL_ENV:'production',VERCEL_TARGET_ENV:'production',
  GOOGLE_PLAY_AUTH_MODE:'vercel_oidc',GOOGLE_PLAY_PRODUCT_ID:'baristamatch_cafe_pro',GOOGLE_PLAY_BASE_PLAN_ID:'monthly-us',
  GOOGLE_PLAY_PUSH_AUDIENCE:'https://android-public-fixture.invalid/api/native-purchases?action=google-events',
  GOOGLE_PLAY_PUSH_SERVICE_ACCOUNT_EMAIL:'fixture-events@fixture-project.iam.gserviceaccount.com',
  GOOGLE_PLAY_WIF_PROJECT_NUMBER:'397053773139',
  GOOGLE_PLAY_WIF_SERVICE_ACCOUNT_EMAIL:'baristamatch-play-public@baristamatch.iam.gserviceaccount.com',
  GOOGLE_PLAY_WIF_PROVIDER_RESOURCE:'projects/397053773139/locations/global/workloadIdentityPools/baristamatch-android-public/providers/vercel-android-production',
  GOOGLE_PLAY_WIF_VERCEL_ISSUER:'https://oidc.vercel.com/baristamatch',GOOGLE_PLAY_WIF_VERCEL_AUDIENCE:'https://vercel.com/baristamatch',
};
const config=()=>readProviderConfiguration('google',env);
const claims=()=>({iss:env.GOOGLE_PLAY_WIF_VERCEL_ISSUER,aud:env.GOOGLE_PLAY_WIF_VERCEL_AUDIENCE,
  sub:'owner:baristamatch:project:baristamatch-android:environment:production',owner_id:'team_W7sLByby0CKVDax9uhMshO5I',
  project_id:'prj_7YTEsQnXSfNQpM0jNBGQ1T4BA07Q',environment:'production',
  iat:Math.floor(Date.now()/1000)-5,nbf:Math.floor(Date.now()/1000)-5,exp:Math.floor(Date.now()/1000)+3600});
const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048});
const jwk={...publicKey.export({format:'jwk'}),kid:'offline-public-fixture',alg:'RS256',use:'sig'};
const token=async(payload=claims(),key=privateKey,alg='RS256')=>new SignJWT(payload).setProtectedHeader({alg,kid:jwk.kid,typ:'JWT'}).sign(key);
const context=new AsyncLocalStorage(),contextSymbol=Symbol.for('@vercel/request-context');
const inRequest=(jwt,fn)=>context.run({headers:{'x-vercel-oidc-token':jwt}},fn);
let escapedNetwork=0,jwksReads=0,originalContext,originalEnv;

before(t=>{
  originalContext=globalThis[contextSymbol];globalThis[contextSymbol]={get:()=>context.getStore() || {}};
  originalEnv=Object.fromEntries(['VERCEL_OIDC_TOKEN','VERCEL_OIDC_TOKEN_FILE','GOOGLE_APPLICATION_CREDENTIALS','VERCEL_PROJECT_ID','VERCEL_TARGET_ENV'].map(key=>[key,process.env[key]]));
  process.env.VERCEL_OIDC_TOKEN='fallback-must-not-be-used';
  process.env.VERCEL_OIDC_TOKEN_FILE='/nonexistent/public-wif-must-not-read';
  process.env.GOOGLE_APPLICATION_CREDENTIALS='/nonexistent/public-wif-must-not-read';
  process.env.VERCEL_PROJECT_ID='prj_mutable_default_must_not_be_used';
  process.env.VERCEL_TARGET_ENV='preview';
  const blocked=()=>{escapedNetwork++;throw Error('Unexpected network attempt');};
  t.mock.method(net,'connect',blocked);t.mock.method(net,'createConnection',blocked);
  t.mock.method(http,'request',blocked);t.mock.method(http,'get',blocked);
  t.mock.method(https,'request',blocked);t.mock.method(globalThis,'fetch',blocked);
  t.mock.method(https,'get',url=>{
    assert.equal(url,'https://oidc.vercel.com/.well-known/jwks');jwksReads++;
    const request=new EventEmitter();request.destroy=()=>{};
    queueMicrotask(()=>{const response=Readable.from([Buffer.from(JSON.stringify({keys:[jwk]}))]);response.statusCode=200;request.emit('response',response);});
    return request;
  });
});
after(()=>{
  if(originalContext===undefined)delete globalThis[contextSymbol];else globalThis[contextSymbol]=originalContext;
  for(const [key,value] of Object.entries(originalEnv)) {
    if(value===undefined)delete process.env[key];else process.env[key]=value;
  }
  assert.equal(escapedNetwork,0);assert.equal(jwksReads,1);
});

test('public WIF requires explicit production mode and the separate exact provider/service account',()=>{
  assert.equal(config().environment,'Production');assert.equal(config().credentials,undefined);
  assert.equal(config().wif.customEnvironmentId,undefined);
  const mutations=[
    {GOOGLE_PLAY_AUTH_MODE:undefined},{GOOGLE_PLAY_AUTH_MODE:'service_account_json'},
    {NATIVE_BILLING_ENVIRONMENT:'Sandbox'},{VERCEL_ENV:'preview'},{VERCEL_ENV:'development'},
    {VERCEL_TARGET_ENV:undefined},{VERCEL_TARGET_ENV:'preview'},{VERCEL_TARGET_ENV:'android-testing'},
    {GOOGLE_PLAY_SERVICE_ACCOUNT_JSON:'{}'},
    {GOOGLE_PLAY_WIF_PROJECT_NUMBER:'1234'},
    {GOOGLE_PLAY_WIF_SERVICE_ACCOUNT_EMAIL:'baristamatch-play-test@baristamatch.iam.gserviceaccount.com'},
    {GOOGLE_PLAY_WIF_SERVICE_ACCOUNT_EMAIL:'attacker@fixture-project.iam.gserviceaccount.com'},
    {GOOGLE_PLAY_WIF_PROVIDER_RESOURCE:env.GOOGLE_PLAY_WIF_PROVIDER_RESOURCE.replace('baristamatch-android-public','baristamatch-android-test')},
    {GOOGLE_PLAY_WIF_PROVIDER_RESOURCE:env.GOOGLE_PLAY_WIF_PROVIDER_RESOURCE.replace('vercel-android-production','vercel-android-testing')},
    {GOOGLE_PLAY_WIF_PROVIDER_RESOURCE:'https://attacker.invalid/federation'},
    {GOOGLE_PLAY_WIF_VERCEL_ISSUER:'https://oidc.vercel.com'},
    {GOOGLE_PLAY_WIF_VERCEL_ISSUER:'https://oidc.vercel.com/other'},
    {GOOGLE_PLAY_WIF_VERCEL_AUDIENCE:'https://vercel.com/other'},
    {GOOGLE_PLAY_WIF_VERCEL_CUSTOM_ENVIRONMENT_ID:'env_fixtureAndroidOnly'},
    {GOOGLE_PLAY_WIF_VERCEL_CUSTOM_ENVIRONMENT_ID:''},
  ];
  for(const mutation of mutations)assert.throws(()=>readGoogleWifConfiguration({...env,...mutation}),{code:'SERVER_CONFIGURATION'});
  for(const key of Object.keys(env).filter(key=>key.startsWith('GOOGLE_PLAY_WIF_'))) {
    assert.throws(()=>readGoogleWifConfiguration({...env,[key]:undefined}),{code:'SERVER_CONFIGURATION'});
  }
});

test('public factory cannot select Sandbox identity or credentials and JSON behavior remains unchanged',async()=>{
  for(const invalid of [
    {...config(),provider:'apple'},{...config(),environment:'Sandbox'},
    {...config(),environment:'production'},{...config(),authMode:'unknown'},
    {...config(),credentials:{type:'service_account'}},
    {...config(),wif:{...config().wif,customEnvironmentId:'env_fixtureAndroidOnly'}},
  ])await assert.rejects(createGoogleAuthClient(invalid,{loadGoogle:async()=>{throw Error('SDK must not load');}}),{code:'SERVER_CONFIGURATION'});
  const credentials={type:'service_account',client_email:'fixture@fixture-project.iam.gserviceaccount.com',private_key:'-----BEGIN PRIVATE KEY-----fixture'};
  for(const authMode of [undefined,'service_account_json']) {
    const sentinel={};
    assert.equal(await createGoogleAuthClient({provider:'google',environment:'Production',authMode,credentials},{
      loadGoogle:async()=>({GoogleAuth:class {
        constructor(options){assert.deepEqual(options,{credentials,scopes:['https://www.googleapis.com/auth/androidpublisher']});}
        async getClient(){return sentinel;}
      }}),loadOidc:async()=>{throw Error('JSON must not load OIDC');},
    }),sentinel);
  }
});

test('real signed production token must match stable owner/project, subject, issuer, audience and built-in environment',async()=>{
  const client=await createGoogleAuthClient(config());
  const valid=await token();assert.equal(await inRequest(valid,()=>client.retrieveSubjectToken()),valid);
  const mutations=[
    {owner_id:'team_other'},{owner_id:undefined},{project_id:'prj_other'},{project_id:undefined},
    {project_id:'prj_VuAxQpdhDJPeTPdanA5HjtOrylA5'},
    {sub:'owner:baristamatch:project:baa:environment:production'},
    {sub:'owner:baristamatch:project:baristamatch-android:environment:preview'},
    {sub:undefined},{environment:'preview'},{environment:'android-testing'},{environment:undefined},
    {custom_environment_id:'env_fixtureAndroidOnly'},{custom_environment_id:null},{custom_environment_id:''},
    {iss:'https://oidc.vercel.com'},{iss:'https://attacker.invalid'},
    {aud:'https://vercel.com/other'},{aud:[env.GOOGLE_PLAY_WIF_VERCEL_AUDIENCE,'https://attacker.invalid']},
  ];
  for(const mutation of mutations)await assert.rejects(inRequest(await token({...claims(),...mutation}),()=>client.retrieveSubjectToken()),{code:'SERVER_CONFIGURATION'});
});

test('public signature verification rejects forgery, malformed tokens and invalid temporal claims',async()=>{
  const client=await createGoogleAuthClient(config());
  for(const jwt of ['', 'invalid', 'x'.repeat(32769)])await assert.rejects(inRequest(jwt,()=>client.retrieveSubjectToken()),{code:'SERVER_CONFIGURATION'});
  const now=Math.floor(Date.now()/1000);
  for(const mutation of [
    {exp:now-10},{exp:undefined},{nbf:now+3600},{nbf:undefined},{iat:undefined},
    {iat:now+3600},{iat:1.5},{exp:now+86_400},{exp:'not-a-date'},
  ])await assert.rejects(inRequest(await token({...claims(),...mutation}),()=>client.retrieveSubjectToken()),{code:'SERVER_CONFIGURATION'});
  const otherKey=generateKeyPairSync('rsa',{modulusLength:2048}).privateKey;
  await assert.rejects(inRequest(await token(claims(),otherKey),()=>client.retrieveSubjectToken()),{code:'SERVER_CONFIGURATION'});
  await assert.rejects(inRequest(await token(claims(),Buffer.alloc(32),'HS256'),()=>client.retrieveSubjectToken()),{code:'SERVER_CONFIGURATION'});
});

test('public supplier accepts only the current platform request context, never file/env/application headers',async()=>{
  const client=await createGoogleAuthClient(config());
  await assert.rejects(client.retrieveSubjectToken(),{code:'SERVER_CONFIGURATION'});
  // A caller-controlled property is not a platform request context.
  await assert.rejects(createGoogleAuthClient({...config(),headers:{'x-vercel-oidc-token':await token()}},{
    loadOidc:async()=>({...oidc,getContext:()=>({})}),
  }).then(value=>value.retrieveSubjectToken()),{code:'SERVER_CONFIGURATION'});
  assert.equal(escapedNetwork,0);
});

function offlineGoogle(calls) {
  const adapter=async options=>{
    const url=String(options.url),headers=new Headers(options.headers);let data;
    if(url==='https://sts.googleapis.com/v1/token') {
      const body=new URLSearchParams(options.data);assert.equal(options.method,'POST');
      assert.equal(body.get('audience'),`//iam.googleapis.com/${env.GOOGLE_PLAY_WIF_PROVIDER_RESOURCE}`);
      assert.equal(body.get('subject_token_type'),'urn:ietf:params:oauth:token-type:jwt');
      calls.push({stage:'sts',subjectToken:body.get('subject_token')});
      data={access_token:'fixture-sts-access',expires_in:3600,token_type:'Bearer',issued_token_type:'urn:ietf:params:oauth:token-type:access_token'};
    } else {
      assert.equal(url,`https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${env.GOOGLE_PLAY_WIF_SERVICE_ACCOUNT_EMAIL}:generateAccessToken`);
      assert.equal(options.method,'POST');assert.equal(headers.get('authorization'),'Bearer fixture-sts-access');
      const body=typeof options.data==='string' ? JSON.parse(options.data) : options.data;
      assert.deepEqual(body.scope,['https://www.googleapis.com/auth/androidpublisher']);
      calls.push({stage:'impersonate'});data={accessToken:'fixture-publisher-access',expireTime:new Date(Date.now()+3600000).toISOString()};
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

test('actual Google SDK uses only the public provider and SA, caches access, and re-verifies fresh request tokens on refresh',async()=>{
  const calls=[],client=await createGoogleAuthClient(config(),{loadGoogle:async()=>offlineGoogle(calls)});
  const first=await token({...claims(),jti:'first'}),second=await token({...claims(),jti:'second'});
  assert.equal((await inRequest(first,()=>client.getAccessToken())).token,'fixture-publisher-access');
  await inRequest(second,()=>client.getAccessToken());
  assert.deepEqual(calls.map(call=>call.stage),['sts','impersonate']);
  client.setCredentials({access_token:'expired-fixture',expiry_date:Date.now()-1000});
  await inRequest(second,()=>client.getAccessToken());
  assert.deepEqual(calls.filter(call=>call.stage==='sts').map(call=>call.subjectToken),[first,second]);
  client.setCredentials({access_token:'expired-fixture',expiry_date:Date.now()-1000});
  const count=calls.length;await assert.rejects(client.getAccessToken(),{code:'SERVER_CONFIGURATION'});assert.equal(calls.length,count);
});

test('production settings are snapshotted before async SDK loading and cannot drift after validation',async()=>{
  const original=config(),calls=[];
  const client=await createGoogleAuthClient(original,{loadGoogle:async()=>{
    original.wif.audience='https://attacker.invalid';original.wif.issuer='https://attacker.invalid';
    original.wif.providerResource='projects/1234/locations/global/workloadIdentityPools/other/providers/other';
    original.wif.serviceAccountEmail='attacker@fixture-project.iam.gserviceaccount.com';
    return offlineGoogle(calls);
  }});
  const jwt=await token();await inRequest(jwt,()=>client.getAccessToken());
  assert.deepEqual(calls.map(call=>call.stage),['sts','impersonate']);
});

test('Sandbox configuration remains pin-equivalent and cannot use the new public provider',()=>{
  const sandbox={...env,NATIVE_BILLING_ENVIRONMENT:'Sandbox',VERCEL_ENV:'preview',VERCEL_TARGET_ENV:'android-testing',
    GOOGLE_PLAY_WIF_SERVICE_ACCOUNT_EMAIL:'baristamatch-play-test@baristamatch.iam.gserviceaccount.com',
    GOOGLE_PLAY_WIF_PROVIDER_RESOURCE:'projects/397053773139/locations/global/workloadIdentityPools/baristamatch-android-test/providers/vercel-android-testing',
    GOOGLE_PLAY_WIF_VERCEL_CUSTOM_ENVIRONMENT_ID:'env_fixtureAndroidOnly',
  };
  assert.deepEqual(readGoogleWifConfiguration(sandbox),{authMode:'vercel_oidc',wif:{
    projectNumber:'397053773139',serviceAccountEmail:sandbox.GOOGLE_PLAY_WIF_SERVICE_ACCOUNT_EMAIL,
    providerResource:sandbox.GOOGLE_PLAY_WIF_PROVIDER_RESOURCE,
    issuer:'https://oidc.vercel.com/baristamatch',audience:'https://vercel.com/baristamatch',customEnvironmentId:'env_fixtureAndroidOnly',
  }});
  assert.throws(()=>readGoogleWifConfiguration({...sandbox,GOOGLE_PLAY_WIF_PROVIDER_RESOURCE:env.GOOGLE_PLAY_WIF_PROVIDER_RESOURCE}),{code:'SERVER_CONFIGURATION'});
  assert.throws(()=>readGoogleWifConfiguration({...sandbox,GOOGLE_PLAY_WIF_SERVICE_ACCOUNT_EMAIL:env.GOOGLE_PLAY_WIF_SERVICE_ACCOUNT_EMAIL}),{code:'SERVER_CONFIGURATION'});
});
