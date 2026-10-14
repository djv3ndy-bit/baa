import test from 'node:test';
import assert from 'node:assert/strict';
import { requireChatOfficeOwner, protectedResourceMetadata } from '../server/chat-owner-auth.mjs';
import { ChatOAuthError } from '../server/chat-oauth.mjs';
import { createChatOfficeProviders } from '../server/chat-data.mjs';
import { createChatRuntime } from '../server/chat-runtime.mjs';

const OWNER = '11111111-1111-4111-8111-111111111111';
const env = { BJM_OFFICE_BASE_URL: 'https://office.fixture.example', SUPABASE_URL: 'https://abcdefghijklmnopqrst.supabase.co',
  SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_fixture', BJM_AI_OFFICE_OWNER_USER_ID: OWNER,
  BJM_CHAT_UPSTREAM_CLIENT_ID: '22222222-2222-4222-8222-222222222222', BJM_CHAT_OAUTH_CLIENT_ID: 'bjm-chat-fixture',
  BJM_CHAT_OAUTH_REDIRECT_URI: 'https://chatgpt.com/connector/oauth/fixture',
  BJM_CHAT_OAUTH_FLOW_KEY: Buffer.alloc(32, 7).toString('base64url'), BJM_CHAT_OAUTH_ENABLED: 'true' };
const accessHash = 'a'.repeat(64), token = 'bjm_at_' + 'a'.repeat(43);
const response = () => ({ headers: {}, statusCode: 0, body: null,
  setHeader(key,value) { this.headers[key.toLowerCase()] = value; }, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });
async function authorize(req, { failure, identity = { ownerId: OWNER, accessHash }, change = {} } = {}) {
  const res = response(); let calls = 0;
  const result = await requireChatOfficeOwner(req, res, {env: {...env,...change}, oauth: {async verifyAccessToken(value) {calls++; assert.equal(value,token); if(failure)throw failure;return identity;}}});
  return { res, result, calls };
}
test('discovery and unauthenticated challenge need no storage, upstream credentials or activation', async () => {
  const publicEnv = { BJM_OFFICE_BASE_URL: env.BJM_OFFICE_BASE_URL };
  assert.deepEqual(protectedResourceMetadata(publicEnv).authorization_servers,[env.BJM_OFFICE_BASE_URL]);
  assert.deepEqual(protectedResourceMetadata(publicEnv).scopes_supported,['office.read']);
  const res=response();
  assert.equal(await requireChatOfficeOwner({headers:{}},res,{env:publicEnv}),false);
  assert.equal(res.statusCode,401); assert.match(res.headers['www-authenticate'],/office\.read/);
  assert.match(res.headers['www-authenticate'],/oauth-protected-resource/);
});
test('legacy JWTs, duplicate headers, refresh tokens and foreign origins never reach verification',async()=>{
  for(const req of [{headers:{authorization:'Bearer eyJ.fixture.signature'}},{headers:{authorization:'Bearer bjm_rt_'+'a'.repeat(43)}},
    {headers:{authorization:'Bearer '+token},rawHeaders:['Authorization','Bearer '+token,'authorization','Bearer '+token]},
    {headers:{authorization:'Bearer '+token,origin:'https://foreign.fixture.example'}}]){
    const {result,res,calls}=await authorize(req);assert.equal(result,false);assert.ok([401,403].includes(res.statusCode));assert.equal(calls,0);
  }
});
test('only verified owner and token hash cross the boundary; revoked tokens and outages fail closed',async()=>{
  const req={headers:{authorization:'Bearer '+token}};
  const valid=await authorize(req);assert.deepEqual(valid.result,{ownerId:OWNER,accessHash});assert.equal(JSON.stringify(valid.result).includes(token),false);
  for(const [failure,status] of [[new ChatOAuthError(401,'invalid_token'),401],[new Error('PRIVATE_DATABASE_PASSWORD_CANARY'),503]]){
    const value=await authorize(req,{failure});assert.equal(value.result,false);assert.equal(value.res.statusCode,status);assert.equal(JSON.stringify(value.res).includes('PRIVATE_'),false);
  }
  for(const change of [{BJM_CHAT_OAUTH_ENABLED:'false'},{SUPABASE_SERVICE_ROLE_KEY:'PRIVATE_CANARY'}]){
    const value=await authorize(req,{change});assert.equal(value.res.statusCode,503);assert.equal(value.calls,0);
  }
  const other=await authorize(req,{identity:{ownerId:'33333333-3333-4333-8333-333333333333',accessHash}});assert.equal(other.res.statusCode,401);
});
function snapshot(){return{schema_version:1,generated_at:new Date(2_000_000_000_000).toISOString(),metrics:{profiles:9,cafes:3,baristas:6,jobs:2,applications:2,subscriptions:3,payments:0,private_customer:'PRIVATE_CUSTOMER_CANARY'},support:{total_recent:0,open:0},billing:{subscriptions:{total:3,active:2,past_due:0,canceling:0},payments:{recent:0,failed:0,refunded:0}},private_raw_data:'PRIVATE_CANARY'};}
test('all five report providers use one per-request guarded snapshot and expose only aggregate whitelist',async()=>{
  let calls=0,fetches=0;
  const store=Object.assign(async()=>null,{snapshot:async(...args)=>{calls++;assert.deepEqual(args,[accessHash,env.BJM_CHAT_OAUTH_CLIENT_ID,env.BJM_OFFICE_BASE_URL+'/mcp']);return snapshot();}});
  const options={store,env,now:()=>2_000_000_000_000,fetchImpl:async(url,init)=>{fetches++;assert.equal(init.method,'HEAD');assert.equal(init.headers,undefined);return new Response(null,{status:200});}};
  const providers=createChatOfficeProviders({ownerId:OWNER,accessHash},options);
  const values=await Promise.all([providers.getLiveOverview(),providers.getSupportSummary(),providers.getBillingSummary(),providers.getSystemHealth(),providers.getDecisionSignals()]);
  assert.equal(calls,1);assert.equal(fetches,1);assert.equal(values[0].metrics.profiles,9);assert.equal(values[0].source,'postgres:office_chat_gateway');assert.equal(values[3].overall,'healthy');assert.deepEqual(values[4],[]);
  const output=JSON.stringify(values);for(const secret of ['PRIVATE_',accessHash,OWNER,token,env.BJM_CHAT_OAUTH_FLOW_KEY])assert.equal(output.includes(secret),false);
  await createChatOfficeProviders({ownerId:OWNER,accessHash},options).getLiveOverview();assert.equal(calls,2);
});
test('revoked snapshots and stale/malformed reports remain unavailable rather than invented zero counts',async()=>{
  for(const load of [async()=>{throw new Error('PRIVATE_CANARY');},async()=>null,async()=>({...snapshot(),generated_at:'2000-01-01T00:00:00Z'}),async()=>({...snapshot(),schema_version:2})]){
    const providers=createChatOfficeProviders({ownerId:OWNER,accessHash},{env,store:Object.assign(async()=>null,{snapshot:load}),now:()=>2_000_000_000_000});
    const value=await providers.getLiveOverview();assert.equal(value.availability,'unavailable');assert.equal(value.metrics.profiles,null);assert.equal(JSON.stringify(value).includes('PRIVATE_'),false);
  }
  assert.throws(()=>createChatOfficeProviders({ownerId:OWNER,accessHash:'invalid'},{env,store:{snapshot:async()=>snapshot()}}),/unavailable/);
});
test('runtime configuration is validated before any pool or private transport is created',()=>{
  let pools=0;assert.throws(()=>createChatRuntime({...env,BJM_CHAT_OAUTH_ENABLED:'false'},{sqlFactory:()=>{pools++;}}));assert.equal(pools,0);
  const store=Object.assign(async()=>null,{snapshot:async()=>snapshot(),close:async()=>{}});
  assert.equal(createChatRuntime(env,{store}).store,store);
});
