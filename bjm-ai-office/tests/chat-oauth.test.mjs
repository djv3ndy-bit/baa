// Offline protocol tests. The store and upstream Auth transport are fixtures;
// no credentials, listener, browser, hosted state or service calls are used.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,createDecipheriv} from 'node:crypto';
import {CHAT_SCOPE,ChatOAuthError,chatAuthorizationMetadata,chatOAuthConfiguration,createChatOAuthHandlers} from '../server/chat-oauth.mjs';

const OWNER='11111111-1111-4111-8111-111111111111',UPSTREAM_CLIENT='22222222-2222-4222-8222-222222222222',SESSION='33333333-3333-4333-8333-333333333333',OTHER='44444444-4444-4444-8444-444444444444';
const ORIGIN='https://office.fixture.example',RESOURCE=ORIGIN+'/mcp',UPSTREAM='https://database.fixture.example/auth/v1',CALLBACK='https://chatgpt.com/connector/oauth/fixture';
const env={BJM_OFFICE_BASE_URL:ORIGIN,SUPABASE_URL:'https://database.fixture.example',SUPABASE_PUBLISHABLE_KEY:'sb_publishable_fixture',BJM_AI_OFFICE_OWNER_USER_ID:OWNER,BJM_CHAT_UPSTREAM_CLIENT_ID:UPSTREAM_CLIENT,
  BJM_CHAT_OAUTH_CLIENT_ID:'bjm-chat-fixture',BJM_CHAT_OAUTH_REDIRECT_URI:CALLBACK,BJM_CHAT_OAUTH_FLOW_KEY:Buffer.alloc(32,7).toString('base64url'),BJM_CHAT_OAUTH_ENABLED:'true'};
const NOW=2_000_000_000,VERIFIER='fixture_chat_verifier_abcdefghijklmnopqrstuvwxyz0123456789',STATE='private_chat_state_fixture';
const hash=value=>createHash('sha256').update(value).digest('hex');
const challenge=value=>createHash('sha256').update(value).digest('base64url');
const json=(value,status=200,headers={})=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json',...headers}});
const jwt=(change={},header={alg:'ES256',kid:'fixture'})=>[header,{iss:UPSTREAM,sub:OWNER,client_id:UPSTREAM_CLIENT,role:'authenticated',aud:'authenticated',scope:'openid',is_anonymous:false,session_id:SESSION,iat:NOW,exp:NOW+3500,...change},'fixture_signature'].map(value=>Buffer.from(typeof value==='string'?value:JSON.stringify(value)).toString('base64url')).join('.');
const req=(method,url,body,headers={})=>({method,url,body,headers:{...(body!==undefined?{'content-type':'application/x-www-form-urlencoded'}:{}),...headers}});
function res(){return{code:undefined,headers:{},body:undefined,setHeader(key,value){this.headers[key.toLowerCase()]=value;},status(value){this.code=value;return this;},json(value){this.body=value;return this;},redirect(status,location){this.code=status;this.headers.location=location;return this;}};}
function fixture(options={}){
  let clock=NOW,upstreamToken=jwt(options.claims,options.header),activeGrant;
  const operations=[],fetches=[],flows=new Map(),codes=new Map(),accesses=new Map(),refreshes=new Map();
  const store=async(op,args)=>{
    operations.push({op,args:structuredClone(args)});
    if(options.storeThrow===op)throw new Error('PRIVATE_STORE_ERROR_CANARY');
    if(options.storeReject===op)return null;
    if(op==='create_flow'){flows.set(args.flowHash,args.encryptedPayload);return{ok:true};}
    if(op==='consume_flow'){const payload=flows.get(args.flowHash);flows.delete(args.flowHash);return payload?{encryptedPayload:payload}:null;}
    if(op==='create_code'){codes.set(args.codeHash,{...args,expires:clock+60});return{ok:true};}
    if(op==='exchange_code'){
      const value=codes.get(args.codeHash);
      if(!value||value.expires<=clock||value.clientId!==args.clientId||value.redirectUri!==args.redirectUri||value.challenge!==args.challenge)return null;
      codes.delete(args.codeHash);activeGrant={ownerId:OWNER,clientId:args.clientId,resource:value.resource,refreshExpiresAt:clock+30*86400,revoked:false};
      accesses.set(args.accessHash,{grant:activeGrant,accessExpiresAt:clock+900});refreshes.set(args.refreshHash,{grant:activeGrant,used:false});
      return options.badExpiry||{ownerId:OWNER,accessExpiresAt:clock+900,refreshExpiresAt:activeGrant.refreshExpiresAt};
    }
    if(op==='refresh'){
      const value=refreshes.get(args.refreshHash);
      if(!value||value.grant.revoked||value.grant.clientId!==args.clientId||value.grant.resource!==args.resource||value.grant.refreshExpiresAt<=clock)return null;
      if(value.used){value.grant.revoked=true;return null;}value.used=true;
      for(const access of accesses.values())if(access.grant===value.grant)access.revoked=true;
      accesses.set(args.newAccessHash,{grant:value.grant,accessExpiresAt:clock+900});refreshes.set(args.newRefreshHash,{grant:value.grant,used:false});
      return{ownerId:OWNER,accessExpiresAt:clock+900,refreshExpiresAt:value.grant.refreshExpiresAt};
    }
    if(op==='verify'){
      if(options.verifyOverride)return options.verifyOverride;
      const value=accesses.get(args.accessHash);
      if(!value||value.revoked||value.grant.revoked||value.accessExpiresAt<=clock||value.grant.clientId!==args.clientId||value.grant.resource!==args.resource)return null;
      return{ownerId:OWNER,clientId:args.clientId,resource:args.resource,accessExpiresAt:value.accessExpiresAt};
    }
    if(op==='revoke'){
      const value=accesses.get(args.tokenHash)||refreshes.get(args.tokenHash);if(value&&value.grant.clientId===args.clientId)value.grant.revoked=true;return{revoked:true};
    }
    throw new Error('Unexpected fixture operation');
  };
  const fetchImpl=async(url,init)=>{
    fetches.push({url,init});assert.equal(init.redirect,'error');assert.equal(init.cache,'no-store');assert.equal(init.headers.apikey,env.SUPABASE_PUBLISHABLE_KEY);
    if(options.fetchThrow&&url.endsWith(options.fetchThrow))throw new Error('PRIVATE_UPSTREAM_ERROR_CANARY');
    if(url===UPSTREAM+'/oauth/token'){
      assert.equal(init.method,'POST');assert.equal(init.headers.Authorization,undefined);assert.equal(init.body.get('client_id'),UPSTREAM_CLIENT);assert.equal(init.body.get('redirect_uri'),ORIGIN+'/oauth/owner/callback');assert.equal(init.body.get('resource'),RESOURCE);
      const upstreamAuthorize=new URL(f.authorizeResponse.headers.location);
      assert.equal(challenge(init.body.get('code_verifier')),upstreamAuthorize.searchParams.get('code_challenge'));
      if(options.malformedTokenResponse)return new Response('PRIVATE_BAD_BODY',{status:200,headers:{'Content-Type':'text/html'}});
      if(options.oversizedTokenResponse)return json({access_token:'x'.repeat(65537),token_type:'bearer'});
      return json({access_token:upstreamToken,refresh_token:'PRIVATE_UPSTREAM_REFRESH_CANARY',id_token:'PRIVATE_UPSTREAM_ID_CANARY',token_type:'bearer'},options.tokenStatus||200);
    }
    assert.equal(init.headers.Authorization,`Bearer ${upstreamToken}`);
    if(url===UPSTREAM+'/user')return json({id:OWNER,email_confirmed_at:'2025-01-01T00:00:00Z',is_anonymous:false,...options.user},options.userStatus||200);
    if(url===UPSTREAM+'/logout?scope=local'){assert.equal(init.method,'POST');return new Response(null,{status:options.logoutStatus||204});}
    throw new Error('Unexpected fixture upstream route');
  };
  const handlers=createChatOAuthHandlers({env:{...env,...options.env},store,fetchImpl,now:()=>clock*1000});
  const f={handlers,operations,fetches,flows,codes,accesses,refreshes,store,advance:seconds=>{clock+=seconds;},setToken:value=>{upstreamToken=value;}};return f;
}
function authorizationParams(change={}){return{response_type:'code',client_id:env.BJM_CHAT_OAUTH_CLIENT_ID,redirect_uri:CALLBACK,scope:CHAT_SCOPE,state:STATE,code_challenge:challenge(VERIFIER),code_challenge_method:'S256',resource:RESOURCE,...change};}
async function begin(f,change={}){const response=res();f.authorizeResponse=response;await f.handlers.authorize(req('GET',ORIGIN+'/oauth/authorize?'+new URLSearchParams(authorizationParams(change))),response);return response;}
async function callback(f,change={}){
  const location=new URL(f.authorizeResponse.headers.location),params={code:'fixture_upstream_code_abcdefghijklmnop',state:location.searchParams.get('state'),...change};
  const response=res();await f.handlers.ownerCallback(req('GET',ORIGIN+'/oauth/owner/callback?'+new URLSearchParams(params)),response);f.callbackResponse=response;return response;
}
async function completeCode(f){await begin(f);const response=await callback(f);assert.equal(response.code,302);assert.equal(new URL(response.headers.location).searchParams.has('error'),false);return new URL(response.headers.location).searchParams.get('code');}
const tokenParams=(code,change={})=>({grant_type:'authorization_code',client_id:env.BJM_CHAT_OAUTH_CLIENT_ID,redirect_uri:CALLBACK,resource:RESOURCE,code,code_verifier:VERIFIER,...change});
async function exchange(f,code,change={}){const response=res();await f.handlers.token(req('POST','/oauth/token',tokenParams(code,change)),response);return response;}
async function refresh(f,value,change={}){const response=res();await f.handlers.token(req('POST','/oauth/token',{grant_type:'refresh_token',client_id:env.BJM_CHAT_OAUTH_CLIENT_ID,resource:RESOURCE,refresh_token:value,...change}),response);return response;}
function oauthError(response,expected){const value=response.headers.location?new URL(response.headers.location).searchParams.get('error'):response.body?.error;assert.equal(value,expected);assert.equal(JSON.stringify(response).includes('PRIVATE_'),false);}

test('public metadata needs only the HTTPS Office origin and advertises only Office scope/public PKCE OAuth',()=>{
  const metadata=chatAuthorizationMetadata({BJM_OFFICE_BASE_URL:ORIGIN});assert.equal(metadata.issuer,ORIGIN);assert.deepEqual(metadata.scopes_supported,['office.read']);assert.deepEqual(metadata.token_endpoint_auth_methods_supported,['none']);assert.deepEqual(metadata.code_challenge_methods_supported,['S256']);assert.equal(metadata.authorization_response_iss_parameter_supported,true);
  assert.equal('registration_endpoint'in metadata,false);for(const value of [OWNER,UPSTREAM_CLIENT,env.BJM_CHAT_OAUTH_FLOW_KEY])assert.equal(JSON.stringify(metadata).includes(value),false);
  for(const BJM_OFFICE_BASE_URL of ['http://office.fixture.example',ORIGIN+'/mcp',ORIGIN+'?private=1','https://name:password@office.fixture.example'])assert.throws(()=>chatAuthorizationMetadata({BJM_OFFICE_BASE_URL}),ChatOAuthError);
});
test('private configuration fails closed without activation, owner/client, exact HTTPS callback or canonical32byte key',()=>{
  assert.equal(chatOAuthConfiguration(env).resource,RESOURCE);
  for(const change of [{BJM_CHAT_OAUTH_ENABLED:'false'},{BJM_AI_OFFICE_OWNER_USER_ID:'00000000-0000-0000-0000-000000000000'},{BJM_CHAT_UPSTREAM_CLIENT_ID:'bad'},{BJM_CHAT_UPSTREAM_CLIENT_ID:undefined,BJM_AI_OFFICE_OAUTH_CLIENT_ID:UPSTREAM_CLIENT},{SUPABASE_PUBLISHABLE_KEY:'service_role_fixture'},
    {SUPABASE_URL:'http://database.fixture.example'},{SUPABASE_URL:'https://database.fixture.example/path'},{BJM_CHAT_OAUTH_REDIRECT_URI:'http://chatgpt.com/callback'},{BJM_CHAT_OAUTH_REDIRECT_URI:'https://name:password@chatgpt.com/callback'},
    {BJM_CHAT_OAUTH_CLIENT_ID:'bad client'},{BJM_CHAT_OAUTH_CLIENT_ID:'a'.repeat(201)},{BJM_CHAT_OAUTH_REDIRECT_URI:'https://other.fixture.example/callback'},{BJM_CHAT_OAUTH_REDIRECT_URI:CALLBACK+'?extra=1'},{BJM_CHAT_OAUTH_FLOW_KEY:'a'.repeat(42)},{BJM_CHAT_OAUTH_FLOW_KEY:'z'.repeat(43)},{SUPABASE_SECRET_KEY:'private_fixture'},{SUPABASE_SERVICE_ROLE_KEY:'private_fixture'}])assert.throws(()=>chatOAuthConfiguration({...env,...change}),ChatOAuthError);
});
test('stable and legacy ChatGPT callback shapes are supported only as one exact configured callback',async()=>{
  const stable='https://chatgpt.com/connector_platform_oauth_redirect';
  assert.equal(chatOAuthConfiguration({...env,BJM_CHAT_OAUTH_REDIRECT_URI:stable}).redirectUri,stable);
  const current=fixture();const denied=await begin(current,{redirect_uri:stable});assert.equal(denied.code,400);assert.equal(current.flows.size,0);
  const f=fixture({env:{BJM_CHAT_OAUTH_REDIRECT_URI:stable}});const beginResponse=await begin(f,{redirect_uri:stable});assert.equal(beginResponse.code,302);
  const completed=await callback(f);assert.equal(completed.code,302);const result=new URL(completed.headers.location);assert.equal(result.origin+result.pathname,stable);assert.match(result.searchParams.get('code'),/^bjm_code_/);
  const wrong=fixture({env:{BJM_CHAT_OAUTH_REDIRECT_URI:stable}});assert.equal((await begin(wrong)).code,400);assert.equal(wrong.flows.size,0);
});
test('authorize stores only AES-GCM ciphertext and hash, with distinct upstream PKCE/state bound to exact client/resource',async()=>{
  const f=fixture(),response=await begin(f);assert.equal(response.code,302);assert.equal(f.fetches.length,0);assert.equal(f.operations.length,1);
  const url=new URL(response.headers.location);assert.equal(url.origin,new URL(UPSTREAM).origin);assert.equal(url.pathname,'/auth/v1/oauth/authorize');assert.equal(url.searchParams.get('scope'),'openid');assert.equal(url.searchParams.get('client_id'),UPSTREAM_CLIENT);assert.equal(url.searchParams.get('resource'),RESOURCE);
  const {flowHash,encryptedPayload}=f.operations[0].args;assert.match(flowHash,/^[a-f0-9]{64}$/);assert.equal(flowHash,hash(url.searchParams.get('state')));assert.equal(encryptedPayload.includes(STATE),false);assert.equal(encryptedPayload.includes(VERIFIER),false);
  const[iv,tag,ciphertext]=encryptedPayload.split('.').map(value=>Buffer.from(value,'base64url'));const decipher=createDecipheriv('aes-256-gcm',Buffer.from(env.BJM_CHAT_OAUTH_FLOW_KEY,'base64url'),iv);decipher.setAAD(Buffer.from(`bjm-office-flow-v1|${ORIGIN}|${flowHash}`));decipher.setAuthTag(tag);
  const payload=JSON.parse(Buffer.concat([decipher.update(ciphertext),decipher.final()]).toString());assert.equal(payload.state,STATE);assert.equal(payload.challenge,challenge(VERIFIER));assert.equal(challenge(payload.upstreamVerifier),url.searchParams.get('code_challenge'));assert.notEqual(payload.upstreamVerifier,VERIFIER);
  assert.equal(response.headers['cache-control'],'no-store');assert.equal(response.headers['referrer-policy'],'no-referrer');
});
test('unknown client/redirect, duplicate fields and empty state never create a flow or redirect to untrusted input',async()=>{
  for(const change of [{client_id:'unknown'},{redirect_uri:'https://evil.fixture.example/callback'},{state:''}]){const f=fixture(),response=await begin(f,change);assert.equal(response.code,400);assert.equal(response.headers.location,undefined);assert.equal(f.operations.length,0);}
  const f=fixture(),response=res();await f.handlers.authorize(req('GET','/oauth/authorize?'+new URLSearchParams(authorizationParams())+'&client_id=unknown'),response);assert.equal(response.code,400);assert.equal(f.operations.length,0);
});
test('resource/scope/response/PKCE mismatches return only registered-client OAuth errors and never create flow',async()=>{
  for(const change of [{resource:'https://other.fixture.example/mcp'},{scope:'openid'},{scope:'office.read office.write'},{response_type:'token'},{code_challenge_method:'plain'},{code_challenge:'bad'}]){
    const f=fixture(),response=await begin(f,change);assert.equal(response.code,302);const location=new URL(response.headers.location);assert.equal(location.origin,'https://chatgpt.com');assert.equal(location.searchParams.get('state'),STATE);assert.equal(location.searchParams.has('error'),true);assert.equal(f.operations.length,0);
  }
});
test('fresh owner callback requires exact Auth/user and local204 before creating Office code; no owner credential leaves broker',async()=>{
  const f=fixture(),code=await completeCode(f);assert.match(code,/^bjm_code_[A-Za-z0-9_-]{43}$/);assert.deepEqual(f.fetches.map(call=>new URL(call.url).pathname+new URL(call.url).search),['/auth/v1/oauth/token','/auth/v1/user','/auth/v1/logout?scope=local']);
  assert.deepEqual(f.operations.map(value=>value.op),['create_flow','consume_flow','create_code']);const location=new URL(f.callbackResponse.headers.location);assert.equal(location.origin,'https://chatgpt.com');assert.equal(location.pathname,new URL(CALLBACK).pathname);assert.equal(location.searchParams.get('state'),STATE);assert.equal(location.searchParams.get('iss'),ORIGIN);assert.equal(location.searchParams.get('code'),code);
  const stored=JSON.stringify(f.operations);for(const value of [jwt(),'PRIVATE_UPSTREAM_REFRESH_CANARY','PRIVATE_UPSTREAM_ID_CANARY',code,VERIFIER])assert.equal(stored.includes(value),false);
});
test('consumed flow cannot replay, including simultaneous callbacks',async()=>{
  const f=fixture();await begin(f);const first=await callback(f);assert.equal(first.code,302);const second=await callback(f);oauthError(second,'invalid_grant');assert.equal(f.fetches.length,3);assert.equal(f.codes.size,1);
  const parallel=fixture();await begin(parallel);const results=await Promise.all([callback(parallel),callback(parallel)]);assert.equal(results.filter(value=>value.headers.location&&!new URL(value.headers.location).searchParams.has('error')).length,1);assert.equal(parallel.fetches.length,3);assert.equal(parallel.codes.size,1);
});
test('ciphertext tampering, wrong state/issuer, and expired flow cannot exchange upstream credentials',async()=>{
  const tampered=fixture();await begin(tampered);const [key,value]=[...tampered.flows][0];const parts=value.split('.');parts[2]=(parts[2][0]==='A'?'B':'A')+parts[2].slice(1);tampered.flows.set(key,parts.join('.'));oauthError(await callback(tampered),'invalid_grant');assert.equal(tampered.fetches.length,0);
  const wrong=fixture();await begin(wrong);oauthError(await callback(wrong,{state:'a'.repeat(43)}),'invalid_grant');assert.equal(wrong.fetches.length,0);
  const issuer=fixture();await begin(issuer);oauthError(await callback(issuer,{iss:'https://other.fixture.example/auth/v1'}),'invalid_request');assert.equal(issuer.fetches.length,0);
  const expired=fixture();await begin(expired);expired.advance(601);oauthError(await callback(expired),'invalid_grant');assert.equal(expired.fetches.length,0);
});
test('provider-denied callback returns an OAuth error to only the preregistered client without token exchange',async()=>{
  const f=fixture();await begin(f);const response=await callback(f,{error:'access_denied',error_description:'PRIVATE_PROVIDER_TEXT'});oauthError(response,'access_denied');assert.equal(new URL(response.headers.location).searchParams.get('state'),STATE);assert.equal(f.fetches.length,0);assert.equal(f.codes.size,0);
});
test('encrypted flow cannot be swapped into a different state row; the independent original flow still works',async()=>{
  const f=fixture(),first=await begin(f),firstState=new URL(first.headers.location).searchParams.get('state');
  await begin(f,{state:'second_private_state'});const secondState=new URL(f.authorizeResponse.headers.location).searchParams.get('state');
  f.flows.set(hash(firstState),f.flows.get(hash(secondState)));
  const rejected=res();await f.handlers.ownerCallback(req('GET','/oauth/owner/callback?'+new URLSearchParams({code:'fixture_upstream_code_abcdefghijklmnop',state:firstState})),rejected);
  oauthError(rejected,'invalid_grant');assert.equal(f.fetches.length,0);
  const valid=await callback(f);assert.equal(new URL(valid.headers.location).searchParams.get('state'),'second_private_state');assert.equal(f.codes.size,1);
});
test('duplicate callback fields and unknown parameters are rejected before flow consumption',async()=>{
  const f=fixture();await begin(f);const state=new URL(f.authorizeResponse.headers.location).searchParams.get('state');
  for(const extra of ['&state=duplicate','&code=duplicate','&unknown=PRIVATE_CALLBACK_INPUT']){
    const response=res();await f.handlers.ownerCallback(req('GET','/oauth/owner/callback?'+new URLSearchParams({state,code:'fixture_upstream_code_abcdefghijklmnop'})+extra),response);oauthError(response,'invalid_request');
  }
  assert.equal(f.fetches.length,0);assert.equal(f.flows.size,1);assert.equal(new URL((await callback(f)).headers.location).searchParams.has('code'),true);
});
test('unverifiable issuer/client/session/header/lifetime or Auth identity never triggers upstream logout or Office code',async()=>{
  const changes=[{sub:'invalid'},{client_id:OTHER},{iss:'https://other.fixture.example/auth/v1'},
    {session_id:'00000000-0000-0000-0000-000000000000'},{session_id:''},{exp:NOW},{iat:NOW-3},{iat:NOW+31},{exp:NOW+3601},{nbf:NOW+31}];
  for(const claims of changes){const f=fixture({claims});await begin(f);oauthError(await callback(f),'access_denied');assert.equal(f.codes.size,0);assert.equal(f.fetches.some(call=>call.url.includes('/logout')),false);}
  for(const header of [{alg:'none'},{alg:'HS256'},{alg:'ES256',crit:[]},{alg:'ES256',jku:'https://evil.fixture.example/keys'}]){const f=fixture({header});await begin(f);oauthError(await callback(f),'access_denied');assert.equal(f.codes.size,0);assert.equal(f.fetches.some(call=>call.url.includes('/logout')),false);}
  for(const options of [{userStatus:403},{user:{id:OTHER}},{claims:{sub:OTHER}},{fetchThrow:'/user'}]){
    const f=fixture(options);await begin(f);oauthError(await callback(f),options.fetchThrow?'temporarily_unavailable':'access_denied');assert.equal(f.codes.size,0);assert.equal(f.fetches.some(call=>call.url.includes('/logout')),false);
  }
});
test('authoritatively verified fresh nonowner or unexpected permission claims locally logout before denial without Office code',async()=>{
  for(const options of [{claims:{sub:OTHER},user:{id:OTHER}},{claims:{role:'bjm_office_reader'}},{claims:{aud:RESOURCE}},
    {claims:{aud:[RESOURCE,'authenticated']}},{claims:{scope:'openid email'}},{claims:{is_anonymous:true}}]){
    const f=fixture(options);await begin(f);oauthError(await callback(f),'access_denied');assert.equal(f.codes.size,0);assert.equal(f.operations.some(value=>value.op==='create_code'),false);
    assert.deepEqual(f.fetches.map(call=>new URL(call.url).pathname+new URL(call.url).search),['/auth/v1/oauth/token','/auth/v1/user','/auth/v1/logout?scope=local']);
  }
});
test('authoritatively verified but unconfirmed, anonymous, deleted or banned fresh user locally logout before denial',async()=>{
  for(const user of [{email_confirmed_at:null},{is_anonymous:true},{deleted_at:'2025-01-01'},{banned_until:'2099-01-01'},{banned_until:'invalid'}]){
    const f=fixture({user});await begin(f);oauthError(await callback(f),'access_denied');assert.equal(f.codes.size,0);assert.equal(f.fetches.filter(call=>call.url.endsWith('/logout?scope=local')).length,1);
  }
});
test('rejected verified session cleanup failure is unavailable, attempted once with no code or global fallback',async()=>{
  for(const options of [{logoutStatus:403},{fetchThrow:'/logout?scope=local'}]){
    const f=fixture({...options,claims:{sub:OTHER},user:{id:OTHER}});await begin(f);oauthError(await callback(f),'temporarily_unavailable');assert.equal(f.codes.size,0);
    assert.equal(f.fetches.filter(call=>call.url.endsWith('/logout?scope=local')).length,1);assert.equal(f.fetches.some(call=>call.url.includes('scope=global')||call.url.includes('scope=others')),false);
  }
});
test('logout denial or network failure fails closed before Office code creation with no upstream refresh/global logout',async()=>{
  for(const options of [{logoutStatus:403},{logoutStatus:500},{fetchThrow:'/logout?scope=local'}]){
    const f=fixture(options);await begin(f);oauthError(await callback(f),'temporarily_unavailable');assert.equal(f.codes.size,0);assert.equal(f.operations.some(value=>value.op==='create_code'),false);assert.equal(f.fetches.filter(call=>call.url.endsWith('/logout?scope=local')).length,1);
    assert.equal(f.fetches.some(call=>call.url.includes('scope=global')||call.url.includes('scope=others')||call.init.body?.get?.('grant_type')==='refresh_token'),false);
  }
});
test('store/infrastructure errors are fixed errors, with no tokens minted or exception detail reflected',async()=>{
  const create=fixture({storeThrow:'create_flow'});oauthError(await begin(create),'temporarily_unavailable');assert.equal(create.fetches.length,0);
  for(const op of ['consume_flow','create_code']){const f=fixture({storeThrow:op});await begin(f);const response=await callback(f);oauthError(response,'temporarily_unavailable');assert.equal(JSON.stringify(response).includes('PRIVATE_STORE_ERROR_CANARY'),false);assert.equal(f.codes.size,0);assert.equal(f.fetches.filter(call=>call.url.endsWith('/logout?scope=local')).length,op==='create_code'?1:0);}
  const upstream=fixture({fetchThrow:'/oauth/token'});await begin(upstream);oauthError(await callback(upstream),'temporarily_unavailable');assert.equal(upstream.codes.size,0);
});
test('nonJSON or oversized upstream token replies fail closed without reflecting bodies or creating codes',async()=>{
  for(const options of [{malformedTokenResponse:true},{oversizedTokenResponse:true}]){
    const f=fixture(options);await begin(f);const response=await callback(f);oauthError(response,'temporarily_unavailable');assert.equal(f.codes.size,0);assert.equal(f.fetches.length,1);
  }
});
test('Office code exchange binds client/redirect/resource/S256 and emits only opaque Office tokens, hashes in store',async()=>{
  const f=fixture(),code=await completeCode(f),response=await exchange(f,code);assert.equal(response.code,200);assert.match(response.body.access_token,/^bjm_at_[A-Za-z0-9_-]{43}$/);assert.match(response.body.refresh_token,/^bjm_rt_[A-Za-z0-9_-]{43}$/);assert.equal(response.body.scope,CHAT_SCOPE);assert.equal(response.body.expires_in,900);
  assert.deepEqual(Object.keys(response.body).sort(),['access_token','expires_in','refresh_token','scope','token_type']);
  const args=f.operations.find(value=>value.op==='exchange_code').args;assert.equal(args.challenge,challenge(VERIFIER));for(const key of ['codeHash','accessHash','refreshHash'])assert.match(args[key],/^[a-f0-9]{64}$/);
  const stored=JSON.stringify(f.operations);for(const value of [code,response.body.access_token,response.body.refresh_token,jwt(),VERIFIER])assert.equal(stored.includes(value),false);
  assert.deepEqual(await f.handlers.verifyAccessToken(response.body.access_token),{ownerId:OWNER,accessHash:hash(response.body.access_token)});
});
test('bad verifier, expired code and atomic concurrent exchanges cannot issue duplicate grants',async()=>{
  const f=fixture(),code=await completeCode(f);oauthError(await exchange(f,code,{code_verifier:'z'.repeat(43)}),'invalid_grant');assert.equal(f.accesses.size,0);
  f.advance(60);oauthError(await exchange(f,code),'invalid_grant');assert.equal(f.accesses.size,0);
  const parallel=fixture(),other=await completeCode(parallel),responses=await Promise.all([exchange(parallel,other),exchange(parallel,other)]);assert.equal(responses.filter(value=>value.code===200).length,1);assert.equal(responses.filter(value=>value.body?.error==='invalid_grant').length,1);assert.equal(parallel.accesses.size,1);
});
test('token requests reject wrong client/resource/callback, secret auth, extra/multiple fields and nonform input without exchange',async()=>{
  const f=fixture(),code=await completeCode(f),before=f.operations.length;
  for(const change of [{client_id:'unknown'},{resource:'https://other.fixture.example/mcp'},{redirect_uri:'https://evil.fixture.example'},{client_secret:'not_allowed'},{refresh_token:'unrelated'},{scope:CHAT_SCOPE},{code_verifier:'short'}]){const response=await exchange(f,code,change);assert.equal(response.code,400);}
  for(const request of [req('POST','/oauth/token',tokenParams(code),{authorization:'Basic Zml4dHVyZQ=='}),req('POST','/oauth/token',tokenParams(code),{'content-type':'application/json'}),
    req('POST','/oauth/token',new URLSearchParams(tokenParams(code)).toString()+'&code=duplicate'),req('POST','/oauth/token',{...tokenParams(code),unknown:'bad'}),req('POST','/oauth/token',{...tokenParams(code),code:[code]})]){const response=res();await f.handlers.token(request,response);assert.equal(response.code,400);}
  assert.equal(f.operations.length,before);
});
test('refresh rotates opaque credentials, preserves absolute30day lifetime, and committed replay revokes whole family',async()=>{
  const f=fixture(),code=await completeCode(f),issued=await exchange(f,code);f.advance(1);const renewed=await refresh(f,issued.body.refresh_token);assert.equal(renewed.code,200);assert.notEqual(renewed.body.access_token,issued.body.access_token);assert.notEqual(renewed.body.refresh_token,issued.body.refresh_token);
  assert.deepEqual(await f.handlers.verifyAccessToken(renewed.body.access_token),{ownerId:OWNER,accessHash:hash(renewed.body.access_token)});
  await assert.rejects(()=>f.handlers.verifyAccessToken(issued.body.access_token),failure=>failure.status===401&&failure.code==='invalid_token');
  oauthError(await refresh(f,issued.body.refresh_token),'invalid_grant');await assert.rejects(()=>f.handlers.verifyAccessToken(renewed.body.access_token),failure=>failure.status===401&&failure.code==='invalid_token');oauthError(await refresh(f,renewed.body.refresh_token),'invalid_grant');
});
test('refresh refuses scope escalation/wrong resource/wrong client before mutating family',async()=>{
  const f=fixture(),issued=await exchange(f,await completeCode(f)),before=f.operations.filter(value=>value.op==='refresh').length;
  for(const change of [{scope:'office.write'},{scope:'office.read office.write'},{resource:'https://other.fixture.example/mcp'},{client_id:'unknown'},{code:'unexpected'}]){const response=await refresh(f,issued.body.refresh_token,change);assert.equal(response.code,400);}
  assert.equal(f.operations.filter(value=>value.op==='refresh').length,before);assert.equal((await refresh(f,issued.body.refresh_token,{scope:CHAT_SCOPE})).code,200);
});
test('absolute refresh lifetime expires without renewal and does not call upstream Auth',async()=>{
  const f=fixture(),issued=await exchange(f,await completeCode(f)),before=f.fetches.length;
  f.advance(30*86400);oauthError(await refresh(f,issued.body.refresh_token),'invalid_grant');assert.equal(f.fetches.length,before);
});
test('untrusted store expiry/subject and store failures cannot cause a successful token response',async()=>{
  for(const badExpiry of [{ownerId:OTHER,accessExpiresAt:NOW+900,refreshExpiresAt:NOW+1000},{ownerId:OWNER,accessExpiresAt:NOW,refreshExpiresAt:NOW+1000},
    {ownerId:OWNER,accessExpiresAt:NOW+931,refreshExpiresAt:NOW+1000},{ownerId:OWNER,accessExpiresAt:NOW+900,refreshExpiresAt:NOW+30*86400+31}]){
    const f=fixture({badExpiry}),response=await exchange(f,await completeCode(f));oauthError(response,'temporarily_unavailable');assert.equal(response.body.access_token,undefined);
  }
  const rejected=fixture({storeReject:'exchange_code'});oauthError(await exchange(rejected,await completeCode(rejected)),'invalid_grant');
  const unavailable=fixture({storeThrow:'exchange_code'});oauthError(await exchange(unavailable,await completeCode(unavailable)),'temporarily_unavailable');
});
test('verification rejects Supabase JWTs/refreshes/expired tokens and wrong owner/client/resource without forwarding upstream',async()=>{
  const f=fixture(),issued=await exchange(f,await completeCode(f)),before=f.fetches.length;
  for(const value of [jwt(),issued.body.refresh_token,'not_a_token','bjm_at_'+'a'.repeat(43)])await assert.rejects(()=>f.handlers.verifyAccessToken(value),failure=>failure instanceof ChatOAuthError&&failure.status===401);
  f.advance(900);await assert.rejects(()=>f.handlers.verifyAccessToken(issued.body.access_token),failure=>failure.status===401);assert.equal(f.fetches.length,before);
  for(const verifyOverride of [{ownerId:OTHER,clientId:env.BJM_CHAT_OAUTH_CLIENT_ID,resource:RESOURCE,accessExpiresAt:NOW+900},
    {ownerId:OWNER,clientId:'other',resource:RESOURCE,accessExpiresAt:NOW+900},{ownerId:OWNER,clientId:env.BJM_CHAT_OAUTH_CLIENT_ID,resource:'other',accessExpiresAt:NOW+900}]){
    const other=fixture({verifyOverride});await assert.rejects(()=>other.handlers.verifyAccessToken('bjm_at_'+'a'.repeat(43)),failure=>failure.status===401);
  }
});
test('revocation is exact-client/Office-only, idempotent and removes active grant credentials without touching owner Auth',async()=>{
  const f=fixture(),issued=await exchange(f,await completeCode(f)),before=f.fetches.length;
  for(const token of [issued.body.refresh_token,issued.body.refresh_token,jwt(),'unknown']){const response=res();await f.handlers.revoke(req('POST','/oauth/revoke',{client_id:env.BJM_CHAT_OAUTH_CLIENT_ID,token}),response);assert.equal(response.code,200);assert.deepEqual(response.body,{});}
  await assert.rejects(()=>f.handlers.verifyAccessToken(issued.body.access_token),failure=>failure.status===401);assert.equal(f.fetches.length,before);
  const response=res();await f.handlers.revoke(req('POST','/oauth/revoke',{client_id:'unknown',token:issued.body.access_token}),response);oauthError(response,'invalid_client');
  assert.equal(f.operations.filter(value=>value.op==='revoke').length,2);
});
test('verification/revocation store errors remain unavailable instead of accepting tokens or returning false success',async()=>{
  const token='bjm_at_'+'a'.repeat(43),verify=fixture({storeThrow:'verify'});await assert.rejects(()=>verify.handlers.verifyAccessToken(token),failure=>failure.status===503&&failure.code==='temporarily_unavailable');
  const revoke=fixture({storeThrow:'revoke'}),response=res();await revoke.handlers.revoke(req('POST','/oauth/revoke',{client_id:env.BJM_CHAT_OAUTH_CLIENT_ID,token}),response);oauthError(response,'temporarily_unavailable');assert.equal(revoke.fetches.length,0);
});
test('form limits and unsupported grant types do not invoke any token-store operation',async()=>{
  const f=fixture();
  for(const request of [req('POST','/oauth/token','x='+ 'a'.repeat(8193)),req('POST','/oauth/token',{grant_type:'client_credentials',client_id:env.BJM_CHAT_OAUTH_CLIENT_ID,resource:RESOURCE}),
    req('POST','/oauth/token',{grant_type:'password',client_id:env.BJM_CHAT_OAUTH_CLIENT_ID,resource:RESOURCE})]){const response=res();await f.handlers.token(request,response);assert.equal(response.code,400);}
  assert.equal(f.operations.length,0);assert.equal(f.fetches.length,0);
});
test('disabled configuration and incorrect methods do not contact store/upstream; errors never echo private request material',async()=>{
  const disabled=fixture({env:{BJM_CHAT_OAUTH_ENABLED:'false'}});oauthError(await begin(disabled),'temporarily_unavailable');await assert.rejects(()=>disabled.handlers.verifyAccessToken('bjm_at_'+'a'.repeat(43)),failure=>failure.status===503);assert.equal(disabled.operations.length,0);assert.equal(disabled.fetches.length,0);
  const f=fixture();for(const name of ['authorize','ownerCallback','token','revoke']){const response=res();await f.handlers[name](req('DELETE','/'+name,{token:'PRIVATE_INPUT_CANARY'}),response);assert.equal(response.code,405);assert.equal(JSON.stringify(response).includes('PRIVATE_INPUT_CANARY'),false);assert.equal(response.headers.allow,name==='authorize'||name==='ownerCallback'?'GET':'POST');}assert.equal(f.operations.length,0);
});
