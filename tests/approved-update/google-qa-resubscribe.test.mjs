import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,generateKeyPairSync} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {Readable} from 'node:stream';
import https from 'node:https';
import net from 'node:net';
import {readQaGoogleResubscribeConfiguration,qaGoogleResubscribeProvider} from '../../server/native-billing/googleQaResubscribe.mjs';
import {createReconciler} from '../../server/native-billing/reconcile.mjs';
import {nativeBillingRepository} from '../../server/native-billing/repository.mjs';
import {readProviderConfiguration,createProviderRuntime} from '../../server/native-billing/runtime.mjs';
import {googleProvider} from '../../server/native-billing/providers.mjs';

// Entire file is synthetic/offline. Any accidental real HTTP immediately fails.
globalThis.fetch=async()=>{throw Error('External HTTP forbidden in offline tests');};
const now=Date.parse('2026-10-19T19:00:00Z'),past=new Date(now-600000).toISOString(),future=new Date(now+600000).toISOString();
const user='00000000-0000-4000-8000-000000000001',other='00000000-0000-4000-8000-000000000002';
const binding='00000000-0000-4000-8000-000000000101',foreign='00000000-0000-4000-8000-000000000102';
const newToken='synthetic-new-purchase-token',oldToken='synthetic-expired-purchase-token';
const hash=value=>createHash('sha256').update(value).digest('hex');
const env={ANDROID_QA_GOOGLE_OUT_OF_APP_RESTORE_ENABLED:'true',SUPABASE_URL:'https://ojvjlvojvozvhktbclcg.supabase.co',
  NATIVE_BILLING_ENVIRONMENT:'Sandbox',VERCEL_ENV:'preview',VERCEL_TARGET_ENV:'android-testing',
  VERCEL_PROJECT_ID:'prj_VuAxQpdhDJPeTPdanA5HjtOrylA5',GOOGLE_PLAY_AUTH_MODE:'vercel_oidc',
  GOOGLE_PLAY_PRODUCT_ID:'baristamatch_cafe_pro',GOOGLE_PLAY_BASE_PLAN_ID:'monthly-us',
  GOOGLE_PLAY_PUSH_AUDIENCE:'https://android-testing.baristajobmatch.com/api/native-purchases?action=google-events',
  GOOGLE_PLAY_PUSH_SERVICE_ACCOUNT_EMAIL:'synthetic@baristamatch.iam.gserviceaccount.com',
  GOOGLE_PLAY_WIF_PROJECT_NUMBER:'397053773139',
  GOOGLE_PLAY_WIF_PROVIDER_RESOURCE:'projects/397053773139/locations/global/workloadIdentityPools/baristamatch-android-test/providers/vercel-android-testing',
  GOOGLE_PLAY_WIF_SERVICE_ACCOUNT_EMAIL:'baristamatch-play-test@baristamatch.iam.gserviceaccount.com',
  GOOGLE_PLAY_WIF_VERCEL_ISSUER:'https://oidc.vercel.com/baristamatch',GOOGLE_PLAY_WIF_VERCEL_AUDIENCE:'https://vercel.com/baristamatch',
  GOOGLE_PLAY_WIF_VERCEL_CUSTOM_ENVIRONMENT_ID:'env_E4F5E2NjsH4RaKOs0Jxp4Zo3AxDQ'};
const clone=structuredClone;
const purchase=(expiry,state='ACTIVE',bound=true)=>({kind:'androidpublisher#subscriptionPurchaseV2',testPurchase:{},
  ...(bound?{externalAccountIdentifiers:{obfuscatedExternalAccountId:binding}}:{}),
  subscriptionState:`SUBSCRIPTION_STATE_${state}`,acknowledgementState:'ACKNOWLEDGEMENT_STATE_PENDING',
  lineItems:[{productId:'baristamatch_cafe_pro',offerDetails:{basePlanId:'monthly-us'},expiryTime:expiry,
    latestSuccessfulOrderId:'synthetic-order',autoRenewingPlan:{autoRenewEnabled:state!=='EXPIRED'}}]});
function fixture() {
  const calls=[],logs=[],scopeCalls=[];
  const state={active:true,current:purchase(future,'ACTIVE',false),past:purchase(past,'EXPIRED'),
    old:{userId:user,revision:3,productId:'baristamatch_cafe_pro',status:'expired',periodEnd:past,verifiedAt:past,supersededBy:null},
    fresh:null,applyCount:0,ackCount:0,ackLost:false,ackFail:false};
  state.current.outOfAppPurchaseContext={expiredPurchaseToken:oldToken,expiredExternalAccountIdentifiers:{obfuscatedExternalAccountId:binding}};
  state.past.acknowledgementState='ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED';
  const loadOidc=async()=>({getContext:()=>({headers:{'x-vercel-oidc-token':'synthetic-platform-token'}}),
    verifyVercelOidcToken:async(raw,options)=>{assert.equal(raw,'synthetic-platform-token');assert.equal(options.projectId,env.VERCEL_PROJECT_ID);
      assert.equal(options.environment,'android-testing');assert.equal(options.ownerId,'team_W7sLByby0CKVDax9uhMshO5I');
      assert.deepEqual(options.algorithms,['RS256']);scopeCalls.push(options);
      return {payload:{custom_environment_id:state.wrongCid?'wrong':env.GOOGLE_PLAY_WIF_VERCEL_CUSTOM_ENVIRONMENT_ID}};}});
  const authClient={async request(input){
    calls.push(clone(input));if(state.providerFailure)throw Error('PRIVATE '+newToken+' '+binding);
    if(input.method==='GET') {
      const id=decodeURIComponent(input.url.split('/').at(-1));
      if(id===newToken)return {data:clone(state.current)};
      assert.equal(id,oldToken);if(state.onOldRead)await state.onOldRead();return {data:clone(state.past)};
    }
    assert.equal(input.method,'POST');assert.ok(state.fresh,'ACK must follow durable apply');state.ackCount++;
    if(state.ackFail)throw Error('Synthetic ACK outage');
    if(state.current.outOfAppPurchaseContext)assert.deepEqual(input.data,{externalAccountIds:{obfuscatedAccountId:binding}});
    else assert.deepEqual(input.data,{});
    state.current.externalAccountIdentifiers={obfuscatedExternalAccountId:binding};delete state.current.outOfAppPurchaseContext;
    state.current.acknowledgementState='ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED';if(state.ackLost)throw Error('Synthetic lost ACK response');return {data:{}};
  }};
  const repository={async googleQaPredecessor(id){assert.ok([oldToken,newToken].includes(id));return clone(id===oldToken?state.old:state.fresh);},
    async owner(value){return value===binding?{userId:state.owner??user}:null;},async activeCafe(id){assert.equal(id,user);return state.active;},
    async read(provider,environment,id){assert.equal(provider,'google');assert.equal(environment,'Sandbox');assert.equal(id,newToken);
      return state.fresh?{userId:state.fresh.userId,revision:state.fresh.revision}:null;},
    async apply(value){state.applyCount++;if(state.onApply)return state.onApply(value);return apply(value);}};
  function apply(value){
    assert.equal(value.userId,user);if(value.googleQaPredecessor){assert.equal(value.googleQaPredecessor.id,oldToken);
      assert.equal(value.googleQaPredecessor.providerState,'SUBSCRIPTION_STATE_EXPIRED');assert.equal(value.googleQaPredecessor.revision,state.old.revision);
      state.old={...state.old,status:'revoked',revision:state.old.revision+(state.old.supersededBy?0:1),supersededBy:hash(newToken)};}
    const duplicate=state.fresh && state.fresh.status===value.status && state.fresh.periodEnd===value.currentPeriodEnd;
    state.fresh={userId:user,revision:state.fresh?(duplicate?state.fresh.revision:state.fresh.revision+1):1,
      productId:value.productId,status:value.status,periodEnd:value.currentPeriodEnd,verifiedAt:new Date(now).toISOString(),supersededBy:null};
    return duplicate?'duplicate':'applied';
  }
  const provider=qaGoogleResubscribeProvider({configuration:readQaGoogleResubscribeConfiguration(env),authClient,repository,
    now:()=>now,loadOidc,logDiagnostic:value=>logs.push(value)});
  const service=createReconciler({repository,providers:{google:provider},environment:'Sandbox'});
  return {state,calls,logs,scopeCalls,repository,provider,authClient,loadOidc,apply,
    run:accountId=>service.reconcile({provider:'google',proof:newToken,...(accountId===null?{}:{accountId:accountId??user})})};
}
test('default off does not read any other environment field',()=>{
  for(const value of [undefined,'','false'])assert.equal(readQaGoogleResubscribeConfiguration(new Proxy({},{get(_target,name){assert.equal(name,'ANDROID_QA_GOOGLE_OUT_OF_APP_RESTORE_ENABLED');return value;}})),null);
});
for(const [name,value] of Object.entries({ANDROID_QA_GOOGLE_OUT_OF_APP_RESTORE_ENABLED:'TRUE',SUPABASE_URL:'https://lmwqrxoitraofaftpwhe.supabase.co',
  NATIVE_BILLING_ENVIRONMENT:'Production',VERCEL_ENV:'production',VERCEL_TARGET_ENV:'preview',VERCEL_PROJECT_ID:'other',
  GOOGLE_PLAY_AUTH_MODE:'service_account_json',GOOGLE_PLAY_PRODUCT_ID:'other',GOOGLE_PLAY_BASE_PLAN_ID:'other',
  GOOGLE_PLAY_WIF_VERCEL_CUSTOM_ENVIRONMENT_ID:'env_other',GOOGLE_PLAY_WIF_PROVIDER_RESOURCE:'other'}))
  test(`opt-in scope rejects wrong ${name}`,()=>assert.throws(()=>readQaGoogleResubscribeConfiguration({...env,[name]:value}),{code:'SERVER_CONFIGURATION'}));
test('a forged configuration object or transplanted Production factory is rejected before SDK loads',async()=>{
  assert.throws(()=>qaGoogleResubscribeProvider({configuration:{environment:'Sandbox'},repository:{googleQaPredecessor(){}}}),{code:'SERVER_CONFIGURATION'});
  const config=readProviderConfiguration('google',env);let loaded=false;
  await assert.rejects(createProviderRuntime({...config,environment:'Production'},{qaResubscribeConfiguration:readQaGoogleResubscribeConfiguration(env),loadGoogle:async()=>{loaded=true;throw Error();}}),{code:'SERVER_CONFIGURATION'});assert.equal(loaded,false);
});
test('signed context CID mismatch stops before provider/ledger reads',async()=>{const f=fixture();f.state.wrongCid=true;await assert.rejects(f.run(),{code:'SERVER_CONFIGURATION'});assert.equal(f.calls.length,0);assert.equal(f.state.applyCount,0);});
test('real installed OIDC verifier rejects malformed token before provider calls, offline',async()=>{
  const actual=await import('@vercel/oidc');const f=fixture();const p=qaGoogleResubscribeProvider({configuration:readQaGoogleResubscribeConfiguration(env),authClient:f.authClient,repository:f.repository,
    loadOidc:async()=>({...actual,getContext:()=>({headers:{'x-vercel-oidc-token':'invalid'}})}),logDiagnostic:()=>{}});
  await assert.rejects(p.identify(newToken),{code:'SERVER_CONFIGURATION'});assert.equal(f.calls.length,0);
});
test('actual OIDC/Jose verifier accepts exact signed QA context and rejects foreign claims with local JWKS only',async t=>{
  const actual=await import('@vercel/oidc'),{SignJWT}=await import('jose');
  const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048});
  const jwk={...publicKey.export({format:'jwk'}),kid:'local-resubscribe-fixture',alg:'RS256',use:'sig'};
  let reads=0;const blocked=()=>{throw Error('External socket forbidden');};
  t.mock.method(net,'connect',blocked);t.mock.method(net,'createConnection',blocked);t.mock.method(https,'request',blocked);
  t.mock.method(https,'get',url=>{assert.equal(url,'https://oidc.vercel.com/.well-known/jwks');reads++;
    const req=new EventEmitter();req.destroy=()=>{};queueMicrotask(()=>{const res=Readable.from([Buffer.from(JSON.stringify({keys:[jwk]}))]);res.statusCode=200;req.emit('response',res);});return req;});
  const clock=Math.floor(Date.now()/1000),claims={iss:env.GOOGLE_PLAY_WIF_VERCEL_ISSUER,aud:env.GOOGLE_PLAY_WIF_VERCEL_AUDIENCE,
    sub:'owner:baristamatch:project:baa:environment:android-testing',owner_id:'team_W7sLByby0CKVDax9uhMshO5I',
    project_id:env.VERCEL_PROJECT_ID,environment:'android-testing',custom_environment_id:env.GOOGLE_PLAY_WIF_VERCEL_CUSTOM_ENVIRONMENT_ID,
    iat:clock-2,nbf:clock-2,exp:clock+600};
  const signed=payload=>new SignJWT(payload).setProtectedHeader({alg:'RS256',kid:jwk.kid}).sign(privateKey);
  let jwt=await signed(claims);const f=fixture();
  const p=qaGoogleResubscribeProvider({configuration:readQaGoogleResubscribeConfiguration(env),authClient:f.authClient,repository:f.repository,
    now:()=>now,loadOidc:async()=>({...actual,getContext:()=>({headers:{'x-vercel-oidc-token':jwt}})}),logDiagnostic:()=>{}});
  assert.equal((await p.identify(newToken)).binding,binding);const before=f.calls.length;
  for(const mutation of [{owner_id:'foreign'},{project_id:'foreign'},{environment:'production'},
    {sub:'owner:baristamatch:project:baa:environment:preview'},{custom_environment_id:'foreign'},
    {custom_environment_id:undefined},{exp:clock-10}]) {
    jwt=await signed({...claims,...mutation});await assert.rejects(p.identify(newToken),{code:'SERVER_CONFIGURATION'});
  }
  assert.equal(f.calls.length,before);assert.equal(reads,1);
});
test('shared configuration and checkout runtime remain ordinary unless explicit receipt factory capability is supplied',async()=>{
  const config=readProviderConfiguration('google',env);assert.equal(config.qaResubscribe,undefined);
  const f=fixture();let loaded=0;
  const runtime=await createProviderRuntime(config,{loadOidc:f.loadOidc,loadGoogle:async()=>({
    OAuth2Client:class {},IdentityPoolClient:class {constructor(){loaded++;}request(args){return f.authClient.request(args);}}})});
  assert.equal(loaded,1);await assert.rejects(runtime.provider.identify(newToken),{code:'ACCOUNT_MISMATCH'});
  assert.equal(f.state.applyCount,0);
});
test('valid one-hop same-owner Sandbox proof applies before binding-aware ACK',async()=>{const f=fixture();const s=await f.run();assert.equal(s.access,'pro');assert.equal(s.binding,binding);assert.equal(f.state.fresh.revision,1);assert.equal(f.state.ackCount,1);assert.equal(f.calls.filter(x=>x.method==='GET').length,4);assert.equal(f.scopeCalls.length,3);});
test('expired context identifier is optional only when known ledger and old provider prove ownership',async()=>{const f=fixture();delete f.state.current.outOfAppPurchaseContext.expiredExternalAccountIdentifiers;assert.equal((await f.run()).access,'pro');});
test('ordinary current-bound purchase remains strict and ACK body remains unchanged',async()=>{const f=fixture();f.state.current=purchase(future);assert.equal((await f.run()).access,'pro');assert.equal(f.calls.length,3);assert.deepEqual(f.calls.at(-1).data,{});});
for(const value of [null,'',4,foreign])test(`present invalid/foreign current binding cannot fall back: ${JSON.stringify(value)}`,async()=>{const f=fixture();f.state.current.externalAccountIdentifiers={obfuscatedExternalAccountId:value};await assert.rejects(f.run());assert.equal(f.state.applyCount,0);assert.equal(f.state.ackCount,0);});
for(const value of [null,[],{}, {expiredPurchaseToken:newToken},{expiredPurchaseToken:'bad whitespace'}])test(`malformed/missing/cyclic context denied: ${JSON.stringify(value)}`,async()=>{const f=fixture();f.state.current.outOfAppPurchaseContext=value;await assert.rejects(f.run());assert.equal(f.state.applyCount,0);});
test('missing current and context remain rejected',async()=>{const f=fixture();delete f.state.current.outOfAppPurchaseContext;await assert.rejects(f.run(),{code:'ACCOUNT_MISMATCH'});assert.equal(f.state.applyCount,0);});
for(const mutation of [{revision:0},{revision:Number.MAX_SAFE_INTEGER+1},{productId:'foreign'},{periodEnd:null},{periodEnd:future},{verifiedAt:'bad'},
  {userId:other},{supersededBy:hash('different')},{status:'revoked'},{status:'pending'}])test(`unverified/foreign/changed predecessor denied: ${JSON.stringify(mutation)}`,async()=>{const f=fixture();Object.assign(f.state.old,mutation);await assert.rejects(f.run());assert.equal(f.state.applyCount,0);});
test('unknown predecessor is never allocated or turned into a tombstone by resolver',async()=>{const f=fixture();f.state.old=null;await assert.rejects(f.run());assert.equal(f.state.applyCount,0);assert.equal(f.state.ackCount,0);});
for(const change of ['product','plan','environment','state','expiry','binding','nested','cycle'])test(`old authoritative proof rejects ${change}`,async()=>{const f=fixture();
  if(change==='product')f.state.past.lineItems[0].productId='other';if(change==='plan')f.state.past.lineItems[0].offerDetails.basePlanId='other';
  if(change==='environment')delete f.state.past.testPurchase;if(change==='state')f.state.past.subscriptionState='SUBSCRIPTION_STATE_CANCELED';
  if(change==='expiry')f.state.past.lineItems[0].expiryTime=future;if(change==='binding')delete f.state.past.externalAccountIdentifiers;
  if(change==='nested')f.state.past.outOfAppPurchaseContext={expiredPurchaseToken:'another'};if(change==='cycle')f.state.past.linkedPurchaseToken=newToken;
  await assert.rejects(f.run());assert.equal(f.state.applyCount,0);});
test('conflicting expired-context binding or linked new-token carrier is rejected',async()=>{for(const change of ['expired','linked']){const f=fixture();if(change==='expired')f.state.current.outOfAppPurchaseContext.expiredExternalAccountIdentifiers.obfuscatedExternalAccountId=foreign;else f.state.current.linkedPurchaseToken='foreign-token';await assert.rejects(f.run());assert.equal(f.state.applyCount,0);}});
test('foreign signed-in account and missing owner cannot adopt an existing purchase',async()=>{const f=fixture();await assert.rejects(f.run(other),{code:'ACCOUNT_MISMATCH'});f.state.owner=other;await assert.rejects(f.run(),{code:'ACCOUNT_MISMATCH'});assert.equal(f.state.applyCount,0);});
test('deleted/suspended owner is rejected even on event path without accountId',async()=>{const f=fixture();f.state.active=false;await assert.rejects(f.run(null),{code:'ACCOUNT_UNAVAILABLE'});assert.equal(f.state.applyCount,0);});
test('active owner is rechecked after old-provider read during fresh verify',async()=>{const f=fixture();let reads=0;f.state.onOldRead=async()=>{if(++reads===2)f.state.active=false;};await assert.rejects(f.run(),{code:'ACCOUNT_UNAVAILABLE'});assert.equal(f.state.applyCount,0);});
test('stale predecessor CAS causes a fresh provider verification before retry',async()=>{const f=fixture();let first=true;f.state.onApply=value=>{if(first){first=false;f.state.old.revision++;return 'retry';}return f.apply(value);};assert.equal((await f.run()).access,'pro');assert.equal(f.calls.filter(x=>x.method==='GET').length,6);assert.equal(f.state.ackCount,1);});
test('atomic apply failure performs no acknowledgement',async()=>{const f=fixture();f.state.onApply=()=>{throw Error('Synthetic atomic eligibility failure');};await assert.rejects(f.run());assert.equal(f.state.ackCount,0);assert.equal(f.state.fresh,null);});
test('ACK failure preserves durable association; a fresh retry remains idempotent',async()=>{const f=fixture();f.state.ackFail=true;await assert.rejects(f.run());assert.equal(f.state.fresh.revision,1);f.state.ackFail=false;assert.equal((await f.run()).access,'pro');assert.equal(f.state.fresh.revision,1);assert.equal(f.state.ackCount,2);});
test('accepted ACK with lost response resolves later through matching current binding, never context synthesis',async()=>{const f=fixture();f.state.ackLost=true;await assert.rejects(f.run());assert.equal(f.state.fresh.revision,1);assert.equal(f.state.current.outOfAppPurchaseContext,undefined);assert.equal((await f.run()).access,'pro');assert.equal(f.state.ackCount,1);assert.equal(f.state.fresh.revision,1);});
test('expired current response is associated as Free and is never ACKed as active',async()=>{const f=fixture();f.state.current.subscriptionState='SUBSCRIPTION_STATE_EXPIRED';f.state.current.lineItems[0].expiryTime=past;assert.equal((await f.run()).access,'free');assert.equal(f.state.ackCount,0);});
test('forged ACK context is not trusted and never reaches Google POST',async()=>{const f=fixture();await assert.rejects(f.provider.acknowledge(newToken,{providerSubscriptionId:newToken,needsAcknowledgement:true,environment:'Sandbox',googleQaPredecessor:{},binding}),{code:'PURCHASE_MISMATCH'});assert.equal(f.calls.length,0);});
test('fixed diagnostic projection never includes provider data, token, ID, URL or raw error',async()=>{const f=fixture();f.state.providerFailure=true;await assert.rejects(f.run());const serialized=JSON.stringify(f.logs);for(const forbidden of [newToken,oldToken,binding,user,'PRIVATE','https://'])assert.ok(!serialized.includes(forbidden));const expected=['event','stage','outcome','reason','subscriptionState','acknowledgementState','currentBindingPresent','outOfAppContextPresent','expiredBindingPresent','expiredTokenPresent','linkedTokenPresent','predecessorKnown','predecessorEligible','ownerMatches','activeCafe','conflict'];assert.deepEqual(Object.keys(f.logs[0]),expected);assert.equal(f.logs[0].reason,'UNCLASSIFIED');});
test('Production strict provider never consults QA fallback or accepts Sandbox proof',async()=>{const f=fixture();const p=googleProvider({authClient:f.authClient,packageName:'com.baristajobmatch.app',productId:'baristamatch_cafe_pro',basePlanId:'monthly-us',environment:'Production',now:()=>now});await assert.rejects(p.identify(newToken),{code:'ACCOUNT_MISMATCH'});assert.equal(f.state.applyCount,0);});
test('existing service read projection and new apply route have fixed Google/Sandbox contracts',async()=>{
  const calls=[];const repo=nativeBillingRepository(async(path,options)=>{const body=JSON.parse(options.body);calls.push({path,body});return path.includes('native_billing_read')?{provider:'google',environment:'Sandbox',provider_subscription_id:oldToken,user_id:user,revision:'3',product_id:'baristamatch_cafe_pro',status:'expired',current_period_end:past,verified_at:past,superseded_by:null}:'applied';});
  assert.equal((await repo.googleQaPredecessor(oldToken)).revision,3);assert.deepEqual(calls[0].body,{p_provider:'google',p_environment:'Sandbox',p_subscription_id:oldToken});
  await repo.apply({provider:'google',environment:'Sandbox',userId:user,binding,providerSubscriptionId:newToken,productId:'baristamatch_cafe_pro',basePlanId:'monthly-us',transactionId:'synthetic-order',status:'active',currentPeriodEnd:future,gracePeriodEnd:null,autoRenews:true,expectedRevision:0,googleQaPredecessor:{id:oldToken,revision:3,periodEnd:past,providerExpiry:past,providerState:'SUBSCRIPTION_STATE_EXPIRED'}});
  assert.equal(calls[1].path,'rpc/native_billing_apply_google_qa_resubscribe');assert.equal(calls[1].body.p_predecessor_revision,3);assert.equal(calls[1].body.p_predecessor_provider_state,'SUBSCRIPTION_STATE_EXPIRED');assert.equal(Object.hasOwn(calls[1].body,'p_environment'),false);
});
