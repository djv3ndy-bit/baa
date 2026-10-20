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
import {createAndroidFcmAuthClient} from '../../server/android-push/googleFcmAuth.mjs';
import {androidPushIdentity} from '../../server/android-push/configuration.mjs';

const require=createRequire(import.meta.url),google=require('google-auth-library'),oidc=require('@vercel/oidc');
const {SignJWT}=require('jose'),id=androidPushIdentity;
const config={projectNumber:id.projectNumber,providerResource:id.providerResource,serviceAccountEmail:id.serviceAccountEmail,
  issuer:id.issuer,audience:id.audience,customEnvironmentId:'env_fixtureAndroidOnly'};
const claims=()=>({iss:id.issuer,aud:id.audience,sub:id.subject,owner_id:id.ownerId,project_id:id.projectId,
  environment:id.environment,custom_environment_id:config.customEnvironmentId,
  iat:Math.floor(Date.now()/1000)-5,nbf:Math.floor(Date.now()/1000)-5,exp:Math.floor(Date.now()/1000)+3600});
const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048});
const jwk={...publicKey.export({format:'jwk'}),kid:'offline-fcm-fixture',alg:'RS256',use:'sig'};
const token=async(payload=claims(),key=privateKey)=>new SignJWT(payload).setProtectedHeader({alg:'RS256',kid:jwk.kid,typ:'JWT'}).sign(key);
const context=new AsyncLocalStorage(),contextSymbol=Symbol.for('@vercel/request-context');
const inRequest=(jwt,fn)=>context.run({headers:{'x-vercel-oidc-token':jwt}},fn);
let escapedNetwork=0,jwksReads=0,originalContext,savedEnv;
before(t=>{
  originalContext=globalThis[contextSymbol];globalThis[contextSymbol]={get:()=>context.getStore() || {}};
  const keys=['VERCEL_OIDC_TOKEN','VERCEL_OIDC_TOKEN_FILE','GOOGLE_APPLICATION_CREDENTIALS'];
  savedEnv=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
  for(const key of keys)process.env[key]='/fallback-must-never-be-read';
  const blocked=()=>{escapedNetwork++;throw Error('Unexpected network');};
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
  for(const [key,value] of Object.entries(savedEnv)){if(value===undefined)delete process.env[key];else process.env[key]=value;}
  assert.equal(escapedNetwork,0);assert.equal(jwksReads,1);
});

test('dedicated FCM factory refuses Publisher/RTDN service identities and wrong trust before loading SDKs',async()=>{
  for(const mutation of [
    {serviceAccountEmail:'publisher-fixture@fixture-project.iam.gserviceaccount.com'},
    {serviceAccountEmail:'rtdn-fixture@fixture-project.iam.gserviceaccount.com'},
    {projectNumber:'1234'},{providerResource:config.providerResource+'-other'},
    {issuer:'https://oidc.vercel.com'},{audience:'https://vercel.com/other'},{customEnvironmentId:'REPLACE_ME'},
  ])await assert.rejects(createAndroidFcmAuthClient({...config,...mutation},{loadGoogle:()=>assert.fail('Must fail before loading SDK')}),{code:'CONFIGURATION'});
});

test('real Vercel RS256 verifier requires current request context, exact identity, signed CID, time claims and signature',async()=>{
  const client=await createAndroidFcmAuthClient(config);
  await assert.rejects(client.retrieveSubjectToken(),{code:'CONFIGURATION'});
  for(const jwt of ['','invalid','x'.repeat(32769)])await assert.rejects(inRequest(jwt,()=>client.retrieveSubjectToken()),{code:'CONFIGURATION'});
  const valid=await token();assert.equal(await inRequest(valid,()=>client.retrieveSubjectToken()),valid);
  for(const mutation of [
    {iss:'https://oidc.vercel.com'},{aud:'https://vercel.com/other'},{owner_id:'team_other'},{project_id:'prj_other'},
    {environment:'preview'},{environment:'production'},{custom_environment_id:'env_otherCustomEnvironment'},
    {custom_environment_id:undefined},{sub:id.subject.replace('android-testing','preview')},
    {exp:Math.floor(Date.now()/1000)-30},{exp:undefined},{nbf:Math.floor(Date.now()/1000)+3600},{iat:undefined},
  ])await assert.rejects(inRequest(await token({...claims(),...mutation}),()=>client.retrieveSubjectToken()),{code:'CONFIGURATION'});
  const foreign=generateKeyPairSync('rsa',{modulusLength:2048}).privateKey;
  await assert.rejects(inRequest(await token(claims(),foreign),()=>client.retrieveSubjectToken()),{code:'CONFIGURATION'});
});

function offlineGoogle(calls) {
  const adapter=async options=>{
    const url=String(options.url),headers=new Headers(options.headers);let data;
    if(url==='https://sts.googleapis.com/v1/token') {
      const body=new URLSearchParams(options.data);assert.equal(options.method,'POST');
      assert.equal(body.get('audience'),`//iam.googleapis.com/${id.providerResource}`);
      assert.equal(body.get('scope'),'https://www.googleapis.com/auth/cloud-platform');
      calls.push({stage:'sts',subjectToken:body.get('subject_token')});
      data={access_token:'fixture-sts-access',expires_in:3600,token_type:'Bearer',issued_token_type:'urn:ietf:params:oauth:token-type:access_token'};
    } else if(url===`https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${id.serviceAccountEmail}:generateAccessToken`) {
      assert.equal(headers.get('authorization'),'Bearer fixture-sts-access');
      const body=typeof options.data==='string'?JSON.parse(options.data):options.data;
      assert.deepEqual(body.scope,['https://www.googleapis.com/auth/firebase.messaging']);calls.push({stage:'fcm-impersonation'});
      data={accessToken:'fixture-fcm-access',expireTime:new Date(Date.now()+3600000).toISOString()};
    } else {
      assert.equal(url,'https://fcm.googleapis.com/v1/projects/baristamatch/messages:send');assert.equal(options.method,'POST');
      assert.equal(headers.get('authorization'),'Bearer fixture-fcm-access');
      assert.equal(options.data.validate_only,true);calls.push({stage:'fcm-validate'});data={name:'projects/baristamatch/messages/fixture'};
    }
    return {data,status:200,statusText:'OK',headers:new Headers(),config:options};
  };
  return {...google,IdentityPoolClient:class extends google.IdentityPoolClient {
    constructor(options) {
      assert.deepEqual(options.scopes,['https://www.googleapis.com/auth/firebase.messaging']);
      assert.deepEqual(options.transporterOptions,{timeout:10000,retry:false});
      assert.equal(options.credential_source,undefined);assert.equal(options.forceRefreshOnFailure,false);
      super(options);this.transporter.defaults.adapter=adapter;this.stsCredential.transporter.defaults.adapter=adapter;
    }
  }};
}

test('real Google SDK uses separate FCM impersonation/scope and current signed request on refresh, with no Publisher access',async()=>{
  const calls=[],client=await createAndroidFcmAuthClient(config,{loadGoogle:async()=>offlineGoogle(calls),loadOidc:async()=>oidc});
  const first=await token({...claims(),jti:'first'}),second=await token({...claims(),jti:'second'});
  const request={url:'https://fcm.googleapis.com/v1/projects/baristamatch/messages:send',method:'POST',data:{validate_only:true}};
  await inRequest(first,()=>client.request(request));await inRequest(second,()=>client.request(request));
  assert.deepEqual(calls.map(call=>call.stage),['sts','fcm-impersonation','fcm-validate','fcm-validate']);
  client.setCredentials({access_token:'expired-fixture',expiry_date:Date.now()-1000});
  await inRequest(second,()=>client.request(request));
  assert.deepEqual(calls.filter(call=>call.stage==='sts').map(call=>call.subjectToken),[first,second]);
  client.setCredentials({access_token:'expired-fixture',expiry_date:Date.now()-1000});const before=calls.length;
  await assert.rejects(client.request(request),{code:'CONFIGURATION'});assert.equal(calls.length,before);
});
