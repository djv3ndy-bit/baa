import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {Readable} from 'node:stream';
import {AsyncLocalStorage} from 'node:async_hooks';
import {createRequire} from 'node:module';
import https from 'node:https';
import http from 'node:http';
import net from 'node:net';
import {createAndroidReviewAccess} from '../../server/native-billing/reviewAccess.mjs';
const require=createRequire(import.meta.url),{SignJWT}=require('jose');
const user='10000000-0000-4000-8000-000000000001',cid='env_fixture_android_review';
const account={id:user,role:'cafe_owner_manager'};
const env={ANDROID_REVIEW_ACCESS_ENABLED:'true',SUPABASE_URL:'https://ojvjlvojvozvhktbclcg.supabase.co',
  ANDROID_REVIEW_API_BASE_URL:'https://android-testing.baristajobmatch.com/api',ANDROID_REVIEW_PACKAGE_NAME:'com.baristajobmatch.app',
  NATIVE_BILLING_ENVIRONMENT:'Sandbox',VERCEL_ENV:'preview',VERCEL_TARGET_ENV:'android-testing',
  ANDROID_REVIEW_CUSTOM_ENVIRONMENT_ID:cid,GOOGLE_PLAY_WIF_VERCEL_CUSTOM_ENVIRONMENT_ID:cid,ANDROID_REVIEW_USER_IDS:user};
const claims=()=>({iss:'https://oidc.vercel.com/baristamatch',aud:'https://vercel.com/baristamatch',
  sub:'owner:baristamatch:project:baa:environment:android-testing',owner_id:'team_W7sLByby0CKVDax9uhMshO5I',
  project_id:'prj_VuAxQpdhDJPeTPdanA5HjtOrylA5',environment:'android-testing',custom_environment_id:cid,
  iat:Math.floor(Date.now()/1000)-5,nbf:Math.floor(Date.now()/1000)-5,exp:Math.floor(Date.now()/1000)+600});
const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048});
const jwk={...publicKey.export({format:'jwk'}),kid:'reviewer-offline-fixture',alg:'RS256',use:'sig'};
const sign=(payload=claims(),key=privateKey)=>new SignJWT(payload).setProtectedHeader({alg:'RS256',kid:jwk.kid,typ:'JWT'}).sign(key);
const context=new AsyncLocalStorage(),symbol=Symbol.for('@vercel/request-context');
const inRequest=(token,fn)=>context.run({headers:{'x-vercel-oidc-token':token}},fn);
let originalContext,originalFallback,jwksReads=0,networkAttempts=0,reads=0;
const read=createAndroidReviewAccess({env,repository:{reviewAccess:async()=>{reads++;return {accountId:user,environment:'Sandbox',reviewAccess:{active:true,expiresAt:'2099-01-01T00:00:00Z'}};}}});
before(t=>{
  originalContext=globalThis[symbol];globalThis[symbol]={get:()=>context.getStore() || {}};
  originalFallback=process.env.VERCEL_OIDC_TOKEN;process.env.VERCEL_OIDC_TOKEN='untrusted-fallback';
  const blocked=()=>{networkAttempts++;throw Error('Unexpected network attempt');};
  t.mock.method(net,'connect',blocked);t.mock.method(net,'createConnection',blocked);t.mock.method(http,'request',blocked);
  t.mock.method(http,'get',blocked);t.mock.method(https,'request',blocked);t.mock.method(globalThis,'fetch',blocked);
  // Only the SDK's fixed JWKS lookup is fulfilled locally; no socket opens.
  t.mock.method(https,'get',url=>{
    assert.equal(url,'https://oidc.vercel.com/.well-known/jwks');jwksReads++;
    const req=new EventEmitter();req.destroy=()=>{};
    queueMicrotask(()=>{const response=Readable.from([Buffer.from(JSON.stringify({keys:[jwk]}))]);response.statusCode=200;req.emit('response',response);});
    return req;
  });
});
after(()=>{
  if(originalContext===undefined)delete globalThis[symbol];else globalThis[symbol]=originalContext;
  if(originalFallback===undefined)delete process.env.VERCEL_OIDC_TOKEN;else process.env.VERCEL_OIDC_TOKEN=originalFallback;
  assert.equal(networkAttempts,0);assert.equal(jwksReads,1);
});
test('installed Vercel/Jose SDK verifies exact signed Android reviewer request before private lookup',async()=>{
  const result=await inRequest(await sign(),()=>read(account));assert.equal(result.active,true);assert.equal(reads,1);
});
test('real signature verifier rejects foreign signed identity, missing claims, expiry, forgery and fallback tokens',async()=>{
  const beforeReads=reads;
  await assert.rejects(read(account),/temporarily unavailable/);
  for(const change of [{iss:'https://oidc.vercel.com'},{aud:'https://vercel.com/other'},{owner_id:'team_other'},
    {project_id:'prj_other'},{environment:'preview'},{environment:'production'},{custom_environment_id:'env_other'},
    {custom_environment_id:undefined},{sub:'owner:baristamatch:project:baa:environment:preview'},
    {exp:Math.floor(Date.now()/1000)-60},{nbf:Math.floor(Date.now()/1000)+600},{iat:undefined},{exp:undefined}])
    await assert.rejects(inRequest(await sign({...claims(),...change}),()=>read(account)),/temporarily unavailable/);
  const foreignKey=generateKeyPairSync('rsa',{modulusLength:2048}).privateKey;
  await assert.rejects(inRequest(await sign(claims(),foreignKey),()=>read(account)),/temporarily unavailable/);
  for(const token of ['','invalid','x'.repeat(32769)])await assert.rejects(inRequest(token,()=>read(account)),/temporarily unavailable/);
  assert.equal(reads,beforeReads);
});
