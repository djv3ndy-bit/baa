import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import {createRequire} from 'node:module';
import {AsyncLocalStorage} from 'node:async_hooks';
import {Readable} from 'node:stream';
import {EventEmitter} from 'node:events';
import http from 'node:http';import https from 'node:https';import net from 'node:net';
import {createPublicFcmAuth} from '../../server/android-public-notifications/googleFcmAuth.mjs';
import {publicPushIdentity as id} from '../../server/android-public-notifications/configuration.mjs';
const require=createRequire(import.meta.url),google=require('google-auth-library'),oidc=require('@vercel/oidc'),{SignJWT}=require('jose');
const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048});
const jwk={...publicKey.export({format:'jwk'}),kid:'offline-fcm-public',alg:'RS256',use:'sig'};
const claims=()=>({iss:id.issuer,aud:id.audience,sub:id.subject,owner_id:id.ownerId,project_id:id.projectId,environment:id.environment,
  iat:Math.floor(Date.now()/1000)-5,nbf:Math.floor(Date.now()/1000)-5,exp:Math.floor(Date.now()/1000)+300});
const token=(body=claims(),key=privateKey,alg='RS256')=>new SignJWT(body).setProtectedHeader({alg,kid:jwk.kid}).sign(key);
const context=new AsyncLocalStorage(),symbol=Symbol.for('@vercel/request-context'),run=(jwt,fn)=>context.run({headers:{'x-vercel-oidc-token':jwt}},fn);
let previous,escaped=0;
before(t=>{
  previous=globalThis[symbol];globalThis[symbol]={get:()=>context.getStore()||{}};
  const block=()=>{escaped++;throw Error('NETWORK_FORBIDDEN');};
  for(const [object,names] of [[http,['request','get']],[https,['request']],[net,['connect','createConnection']],[globalThis,['fetch']]])for(const name of names)t.mock.method(object,name,block);
  t.mock.method(https,'get',url=>{assert.equal(url,'https://oidc.vercel.com/.well-known/jwks');const request=new EventEmitter();request.destroy=()=>{};
    queueMicrotask(()=>{const response=Readable.from([Buffer.from(JSON.stringify({keys:[jwk]}))]);response.statusCode=200;request.emit('response',response);});return request;});
});
after(()=>{if(previous===undefined)delete globalThis[symbol];else globalThis[symbol]=previous;assert.equal(escaped,0);});
const factory=(loadGoogle=async()=>google)=>createPublicFcmAuth({loadGoogle,loadOidc:async()=>oidc});
test('real OIDC RS256 verifier accepts only dedicated Android Production signed identity',async()=>{
  const client=await factory(),valid=await token();assert.equal(await run(valid,()=>client.retrieveSubjectToken()),valid);
  for(const change of [{project_id:'prj_other'},{owner_id:'team_other'},{environment:'preview'},
    {sub:'owner:baristamatch:project:baa:environment:production'},{custom_environment_id:'env_fixture'},
    {iss:'https://oidc.vercel.com'},{aud:[id.audience]},{nbf:Math.floor(Date.now()/1000)+1000},{exp:0},
    {iat:Math.floor(Date.now()/1000)+1000},{exp:Math.floor(Date.now()/1000)+90000}])await assert.rejects(run(await token({...claims(),...change}),()=>client.retrieveSubjectToken()));
});
test('real verifier rejects forgery/missing context/claims and no fallback environment token is consumed',async()=>{
  const client=await factory();await assert.rejects(client.retrieveSubjectToken());
  await assert.rejects(run(await token(claims(),generateKeyPairSync('rsa',{modulusLength:2048}).privateKey),()=>client.retrieveSubjectToken()));
  for(const key of ['exp','iat','nbf','sub','project_id','owner_id','environment']){const body=claims();delete body[key];await assert.rejects(run(await token(body),()=>client.retrieveSubjectToken()));}
  await assert.rejects(run('invalid',()=>client.retrieveSubjectToken()));
});
test('actual Google SDK exchanges only messaging scope/public FCM account and refresh uses fresh signed request context',async()=>{
  const calls=[];
  const adapter=async options=>{
    let data;const url=String(options.url);
    if(url==='https://sts.googleapis.com/v1/token'){
      const body=new URLSearchParams(options.data);assert.equal(body.get('audience'),`//iam.googleapis.com/${id.providerResource}`);calls.push(body.get('subject_token'));
      data={access_token:'fixture-sts',expires_in:3600,token_type:'Bearer',issued_token_type:'urn:ietf:params:oauth:token-type:access_token'};
    }else{
      assert.equal(url,`https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${id.serviceAccountEmail}:generateAccessToken`);
      const body=typeof options.data==='string'?JSON.parse(options.data):options.data;assert.deepEqual(body.scope,['https://www.googleapis.com/auth/firebase.messaging']);
      data={accessToken:'fixture-fcm-access',expireTime:new Date(Date.now()+3600000).toISOString()};
    }
    return {status:200,data,statusText:'OK',headers:new Headers(),config:options};
  };
  const client=await factory(async()=>({...google,IdentityPoolClient:class extends google.IdentityPoolClient{constructor(options){super(options);this.transporter.defaults.adapter=adapter;this.stsCredential.transporter.defaults.adapter=adapter;}}}));
  const first=await token({...claims(),jti:'first'}),second=await token({...claims(),jti:'second'});
  assert.equal((await run(first,()=>client.getAccessToken())).token,'fixture-fcm-access');
  await run(second,()=>client.getAccessToken());assert.equal(calls.length,1);
  client.setCredentials({access_token:'expired-fixture',expiry_date:Date.now()-1000});await run(second,()=>client.getAccessToken());assert.deepEqual(calls,[first,second]);
  client.setCredentials({access_token:'expired-fixture',expiry_date:Date.now()-1000});await assert.rejects(client.getAccessToken());assert.equal(calls.length,2);
});
