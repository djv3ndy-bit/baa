import test from 'node:test';
import assert from 'node:assert/strict';
import {createAndroidReviewAccess,readAndroidReviewConfiguration} from '../../server/native-billing/reviewAccess.mjs';
import {nativeCheckoutService} from '../../server/native-billing/checkoutService.mjs';
import {accountBillingView} from '../../server/native-billing/accountBillingHandler.mjs';
import {nativeBillingRepository} from '../../server/native-billing/repository.mjs';
import {checkoutHandler} from '../../server/native-billing/checkoutHandler.mjs';

const user='10000000-0000-4000-8000-000000000001',other='10000000-0000-4000-8000-000000000002';
const cid='env_fixture_android_review',expiry='2099-01-01T00:00:00.000Z';
const grant={active:true,expiresAt:expiry},account={id:user,role:'cafe_owner_manager'};
const config=()=>({ANDROID_REVIEW_ACCESS_ENABLED:'true',SUPABASE_URL:'https://ojvjlvojvozvhktbclcg.supabase.co',
  ANDROID_REVIEW_API_BASE_URL:'https://android-testing.baristajobmatch.com/api',ANDROID_REVIEW_PACKAGE_NAME:'com.baristajobmatch.app',
  NATIVE_BILLING_ENVIRONMENT:'Sandbox',VERCEL_ENV:'preview',VERCEL_TARGET_ENV:'android-testing',
  ANDROID_REVIEW_CUSTOM_ENVIRONMENT_ID:cid,GOOGLE_PLAY_WIF_VERCEL_CUSTOM_ENVIRONMENT_ID:cid,ANDROID_REVIEW_USER_IDS:user});
const website={plan:'free',status:'expired',connectedToBilling:false,canManageBilling:false,billingPaused:false};
function lookup({env=config(),result={accountId:user,environment:'Sandbox',reviewAccess:grant},contextToken='signed-fixture',
  signedCid=cid,failure=false,now=()=>Date.parse('2026-10-12'),readError=false}={}) {
  const calls=[];
  const read=createAndroidReviewAccess({env,now,repository:{reviewAccess:async(...args)=>{
    calls.push(['read',...args]);if(readError)throw Error('private database error');return result;}},
    loadOidc:async()=>({getContext:()=>({headers:{'x-vercel-oidc-token':contextToken}}),
      verifyVercelOidcToken:async(token,options)=>{calls.push(['verify',token,options]);if(failure)throw Error('private signature error');return {payload:{custom_environment_id:signedCid}};}})});
  return {read,calls};
}

test('disabled/default reviewer path performs no context or database lookup and preserves the existing response',async()=>{
  for(const enabled of [undefined,'','false']){
    const h=lookup({env:{ANDROID_REVIEW_ACCESS_ENABLED:enabled}});assert.equal(await h.read(account),null);assert.deepEqual(h.calls,[]);
  }
});
test('each deployment/configuration boundary fails closed before reviewer lookup',()=>{
  const bad={ANDROID_REVIEW_ACCESS_ENABLED:'TRUE',SUPABASE_URL:'https://other.supabase.co',ANDROID_REVIEW_API_BASE_URL:'https://testing.baristajobmatch.com/api',
    ANDROID_REVIEW_PACKAGE_NAME:'com.other.app',NATIVE_BILLING_ENVIRONMENT:'Production',VERCEL_ENV:'production',VERCEL_TARGET_ENV:'preview',
    ANDROID_REVIEW_CUSTOM_ENVIRONMENT_ID:'env_different',GOOGLE_PLAY_WIF_VERCEL_CUSTOM_ENVIRONMENT_ID:undefined,ANDROID_REVIEW_USER_IDS:''};
  for(const [key,value] of Object.entries(bad))assert.throws(()=>lookup({env:{...config(),[key]:value}}),/temporarily unavailable/);
  for(const ids of [user+',',user+','+user,'not-a-uuid',Array(9).fill(user).join(',')])
    assert.throws(()=>readAndroidReviewConfiguration({...config(),ANDROID_REVIEW_USER_IDS:ids}),/temporarily unavailable/);
});
test('nonallowlisted accounts do not invoke OIDC or private RPC; wrong role/suspension fail closed',async()=>{
  const h=lookup();assert.equal(await h.read({...account,id:other}),null);assert.deepEqual(h.calls,[]);
  for(const changed of [{role:'barista'},{suspendedAt:'today'},{id:'invalid'}])await assert.rejects(h.read({...account,...changed}),/temporarily unavailable/);
});
test('active reviewer grant requires a fresh signed exact custom-environment context on every lookup',async()=>{
  const h=lookup();assert.deepEqual(await h.read(account),grant);assert.deepEqual(await h.read(account),grant);
  assert.equal(h.calls.filter(c=>c[0]==='verify').length,2);assert.equal(h.calls.filter(c=>c[0]==='read').length,2);
  const options=h.calls[0][2];assert.equal(options.issuer,'https://oidc.vercel.com/baristamatch');
  assert.equal(options.audience,'https://vercel.com/baristamatch');assert.equal(options.environment,'android-testing');
  assert.equal(options.ownerId,'team_W7sLByby0CKVDax9uhMshO5I');assert.equal(options.projectId,'prj_VuAxQpdhDJPeTPdanA5HjtOrylA5');
  assert.equal(options.subject,'owner:baristamatch:project:baa:environment:android-testing');assert.deepEqual(options.algorithms,['RS256']);
  assert.deepEqual(h.calls[1],['read',user,'Sandbox',cid]);
});
test('missing/foreign/invalid platform proof never reaches database or falls back to purchase access',async()=>{
  for(const opts of [{contextToken:undefined},{contextToken:''},{signedCid:'env_other'},{failure:true}]){
    const h=lookup(opts.contextToken===undefined && Object.hasOwn(opts,'contextToken')?{...opts,contextToken:null}:opts);
    await assert.rejects(h.read(account),/temporarily unavailable/);assert.equal(h.calls.some(c=>c[0]==='read'),false);
  }
});
test('expiry and revoked/absent grants are inactive, while malformed or failed enabled lookups fail closed',async()=>{
  assert.equal(await lookup({result:null}).read(account),null);
  assert.equal(await lookup({now:()=>Date.parse(expiry)}).read(account),null);
  for(const result of [{accountId:other,environment:'Sandbox',reviewAccess:grant},{accountId:user,environment:'Production',reviewAccess:grant},
    {accountId:user,environment:'Sandbox',reviewAccess:{active:false,expiresAt:expiry}},
    {accountId:user,environment:'Sandbox',reviewAccess:{active:true,expiresAt:'infinity'}},{}])
    await assert.rejects(lookup({result}).read(account),/temporarily unavailable/);
  await assert.rejects(lookup({readError:true}).read(account),/temporarily unavailable/);
});
function service({reviewAccess=async()=>grant,subscriptions=[],enabled=true}={}){
  const calls=[];
  const repository={settleVerifiedCheckout:async()=>calls.push('settle'),summary:async()=>({accountId:user,environment:'Sandbox',subscriptions}),
    checkoutPending:async()=>false,claimCheckout:async()=>{calls.push('claim');return {};},checkoutProvider:async()=>{calls.push('provider');return 'google';},
    startCheckout:async()=>{calls.push('start');return true;}};
  return {calls,api:nativeCheckoutService({repository,reviewAccess,environment:'Sandbox',enabled,productId:'apple.monthly',
    googlePlan:{productId:'google.monthly',basePlanId:'monthly'},ready:async()=>calls.push('ready'),inspectWebsiteBilling:async()=>true})};
}
const request={provider:'google',productId:'google.monthly',basePlanId:'monthly',storefront:'US'};
test('review-only Pro preserves empty provider history and truthful management capabilities',async()=>{
  const h=service();const result=await h.api.status(account,website);
  assert.equal(result.access,'pro');assert.equal(result.provider,null);assert.equal(result.status,'free');assert.deepEqual(result.subscriptions,[]);
  assert.equal(result.canPurchase,false);assert.equal(result.canManage,false);assert.deepEqual(result.reviewAccess,grant);
  const view=accountBillingView(website,result);assert.equal(view.plan,'pro');assert.equal(view.connectedToBilling,false);
  assert.equal(view.canManageBilling,false);assert.deepEqual(view.nativeStatus.reviewAccess,grant);
});
test('review access remains readable with purchases disabled and never enables a store checkout',async()=>{
  const h=service({enabled:false});const result=await h.api.status(account,website);
  assert.equal(result.access,'pro');assert.equal(result.canPurchase,false);assert.deepEqual(result.reviewAccess,grant);
  await assert.rejects(h.api.prepare(account,request),error=>error.code==='NOT_ENABLED');
  assert.deepEqual(h.calls,['settle']);
});
test('review grant overlays expiry without inventing a Google renewal, status, period or subscription row',async()=>{
  const row={provider:'google',status:'expired',autoRenews:false,currentPeriodEnd:'2000-01-01T00:00:00Z',gracePeriodEnd:null};
  const baseline=await service({reviewAccess:async()=>null,subscriptions:[row]}).api.status(account,website);
  const active=await service({subscriptions:[row]}).api.status(account,website);
  for(const key of ['provider','status','autoRenews','currentPeriodEnd','gracePeriodEnd','canManage','subscriptions'])assert.deepEqual(active[key],baseline[key]);
  assert.equal(active.access,'pro');assert.equal(active.canPurchase,false);
  const before=accountBillingView(website,baseline),after=accountBillingView(website,active);
  for(const key of ['status','connectedToBilling','canManageBilling','currentPeriodEnd','cancelAtPeriodEnd'])assert.deepEqual(after[key],before[key]);
  assert.equal(after.plan,'pro');assert.deepEqual(after.nativeStatus.reviewAccess,grant);
});
test('review grant blocks prepare/start/resume before provider readiness, reservation or charge authorization',async()=>{
  const h=service();for(const action of [()=>h.api.prepare(account,request),()=>h.api.start(account,user,request),
    ()=>h.api.resume(account,{provider:'apple',productId:'apple.monthly',storefront:'USA'},website)])
    await assert.rejects(action(),error=>error.code==='REVIEW_ACCESS_ACTIVE');
  assert.deepEqual(h.calls,[]);
});
test('stale checkout request receives deliberate reviewer-access conflict instead of an outage',async()=>{
  const h=service(),result={};
  const handler=checkoutHandler({authenticateCafe:async()=>({id:user,profile:{role:'cafe_owner_manager'}}),serviceFor:()=>h.api});
  await handler({method:'POST',query:{action:'prepare'},body:request},{setHeader(){},status(code){result.code=code;return this;},json(body){result.body=body;}});
  assert.equal(result.code,409);assert.match(result.body.error,/reviewer Pro access.*No purchase is needed/);assert.deepEqual(h.calls,[]);
});
test('enabled reviewer lookup outage blocks status and checkout instead of falling back to Free',async()=>{
  const h=service({reviewAccess:async()=>{throw Error('Reviewer access is temporarily unavailable.');}});
  await assert.rejects(h.api.status(account,website));await assert.rejects(h.api.prepare(account,request));await assert.rejects(h.api.start(account,user,request));
  assert.deepEqual(h.calls,[]);
});
test('inactive path matches original combined status with no reviewAccess field',async()=>{
  const a=service({reviewAccess:async()=>null});
  // Explicitly compare a null lookup to the original constructor default.
  const original=nativeCheckoutService({repository:{settleVerifiedCheckout:async()=>true,summary:async()=>({accountId:user,environment:'Sandbox',subscriptions:[]}),checkoutPending:async()=>false},
    environment:'Sandbox',enabled:true,ready:async()=>{},inspectWebsiteBilling:async()=>true});
  assert.deepEqual(await a.api.status(account,website),await original.status(account,website));
  assert.equal(Object.hasOwn(await a.api.status(account,website),'reviewAccess'),false);
});
test('repository reviewer lookup is an account/environment/CID-bound read-only RPC',async()=>{
  const calls=[];const repo=nativeBillingRepository(async(...args)=>{calls.push(args);return null;});
  assert.equal(await repo.reviewAccess(user,'Sandbox',cid),null);assert.equal(calls.length,1);
  assert.equal(calls[0][0],'rpc/android_reviewer_access');assert.deepEqual(JSON.parse(calls[0][1].body),{p_user_id:user,p_environment:'Sandbox',p_custom_environment_id:cid});
});
