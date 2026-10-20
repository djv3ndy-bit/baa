import test from 'node:test';
import assert from 'node:assert/strict';
import {androidPublicBillingApplication} from '../../server/android-public-billing/application.mjs';
import {androidPublicBillingIdentity as pin,readAndroidPublicBillingConfiguration} from '../../server/android-public-billing/configuration.mjs';
import {androidSupabaseTransport} from '../../server/android-public-billing/supabaseTransport.mjs';
import {androidGooglePublicEvent} from '../../server/android-public-billing/googleEvents.mjs';
import {androidGoogleRuntime} from '../../server/android-public-billing/googleRuntime.mjs';

const user='10000000-0000-4000-8000-000000000001',binding='30000000-0000-4000-8000-000000000001',attempt='20000000-0000-4000-8000-000000000001';
const now=Date.parse('2026-10-12T12:00:00Z');
const selection={provider:'google',productId:pin.productId,basePlanId:pin.basePlanId,storefront:'US'};
const env=()=>({ANDROID_GOOGLE_BILLING_ACTIVE:'true',ANDROID_GOOGLE_RECEIPTS_ACTIVE:'true',ANDROID_GOOGLE_EVENTS_ACTIVE:'true',
  NATIVE_PURCHASES_ENABLED:'true',BILLING_ENABLED:'true',ANDROID_DIRECT_FCM_ENABLED:'true',ANDROID_REVIEW_ACCESS_ENABLED:'false',
  VERCEL_PROJECT_ID:pin.projectId,VERCEL_ENV:'production',VERCEL_TARGET_ENV:'production',VERCEL_URL:'baristamatch-android-fixture-baristamatch.vercel.app',
  SUPABASE_URL:pin.supabaseUrl,SUPABASE_PUBLISHABLE_KEY:'sb_publishable_fixture',SUPABASE_SECRET_KEY:'sb_secret_fixture',
  NATIVE_BILLING_ENVIRONMENT:'Production',GOOGLE_PLAY_AUTH_MODE:'vercel_oidc',GOOGLE_PLAY_PRODUCT_ID:pin.productId,GOOGLE_PLAY_BASE_PLAN_ID:pin.basePlanId,
  GOOGLE_PLAY_WIF_PROJECT_NUMBER:'397053773139',GOOGLE_PLAY_WIF_SERVICE_ACCOUNT_EMAIL:'baristamatch-play-public@baristamatch.iam.gserviceaccount.com',
  GOOGLE_PLAY_WIF_PROVIDER_RESOURCE:'projects/397053773139/locations/global/workloadIdentityPools/baristamatch-android-public/providers/vercel-android-production',
  GOOGLE_PLAY_WIF_VERCEL_ISSUER:pin.issuer,GOOGLE_PLAY_WIF_VERCEL_AUDIENCE:pin.audience,
  GOOGLE_PLAY_PUSH_AUDIENCE:`https://${pin.apiHost}/api/native-purchases?action=google-events`,GOOGLE_PLAY_PUSH_SERVICE_ACCOUNT_EMAIL:'baristamatch-rtdn-public@baristamatch.iam.gserviceaccount.com',
  ANDROID_STRIPE_READ_RESTRICTED_KEY:'rk_live_fixture',ANDROID_STRIPE_ACCOUNT_ID:'acct_fixture',ANDROID_STRIPE_MONTHLY_PRICE_ID:'price_fixture'});
const claims=()=>({iss:pin.issuer,aud:pin.audience,sub:pin.subject,owner_id:pin.ownerId,project_id:pin.projectId,environment:'production',
  iat:now/1000-30,nbf:now/1000-30,exp:now/1000+300});
const cafe=()=>({id:user,email:'verified@example.invalid',emailConfirmed:true,profile:{id:user,role:'cafe_owner_manager',suspended_at:null}});
const local=()=>({user_id:user,status:'free',current_period_end:null,cancel_at_period_end:false,complimentary_access:false,
  stripe_customer_id:null,stripe_subscription_id:null,stripe_checkout_attempt_id:null});
const verified=()=>({provider:'google',environment:'Production',binding,providerSubscriptionId:'purchase-fixture',productId:pin.productId,
  transactionId:'order-fixture',access:'pro',status:'active',currentPeriodEnd:'2026-11-01T00:00:00Z',gracePeriodEnd:null,autoRenews:true,canManage:true,needsAcknowledgement:true});
const request=(action,body={})=>({method:action==='status'?'GET':'POST',headers:{host:pin.apiHost,authorization:'Bearer a.b.c'},query:{action},body});
const output=()=>({setHeader(){},status(code){this.code=code;return this;},json(body){this.body=body;return this;}});
const page=(data=[])=>({object:'list',data,has_more:false});
function fixture({environment={},auth=cafe(),apply='applied',settleError=false,owner={userId:user},inspectionEnvironment='Production',localRow=local()}={}) {
  const calls=[],state={conflict:false,settleError,apply,owner,inspectionEnvironment};
  const transport={authenticateCafe:async()=>{calls.push('auth');return auth;},subscriptionFor:async id=>{assert.equal(id,user);calls.push('local');return localRow;},
    adminRows:async(path,options)=>{
      calls.push(path);const body=JSON.parse(options.body);
      if(path==='rpc/native_checkout_claim')return {attemptId:body.p_attempt_id,accountBinding:binding};
      if(path==='rpc/native_checkout_provider')return 'google';
      if(path==='rpc/native_checkout_start' || path==='rpc/android_google_checkout_cancel')return true;
      if(path==='rpc/android_google_checkout_settle_verified'){if(state.settleError)throw Error('settlement outage');return true;}
      assert.fail('Unexpected private RPC');
    }};
  const repository={owner:async()=>{calls.push('owner');return state.owner;},activeCafe:async()=>true,read:async()=>null,
    apply:async()=>{calls.push('apply');return state.apply;},summary:async()=>({accountId:user,environment:'Production',subscriptions:[]}),checkoutPending:async()=>false,
    claimEvent:async()=>{calls.push('claimEvent');return 'claimed';},finishEvent:async args=>{calls.push(args.success?'eventSuccess':'eventFailure');return true;}};
  const runtime={ready:async()=>calls.push('catalog'),provider:{identify:async()=>({binding,providerSubscriptionId:'purchase-fixture'}),
    verify:async()=>verified(),acknowledge:async()=>calls.push('purchaseAck')},
    notification:async()=>{calls.push('pubsubAuth');return {provider:'google',eventId:'event-fixture',providerSubscriptionId:'purchase-fixture'};},
    inspectNotification:async()=>{calls.push('authoritativeGoogle');return {binding,providerSubscriptionId:'purchase-fixture',environment:state.inspectionEnvironment};}};
  const dependencies={env:{...env(),...environment},now:()=>now,verifyDeploymentIdentity:async()=>{calls.push('identity');return claims();},
    createTransport:()=>transport,createRepository:()=>repository,createRuntime:async()=>runtime,
    createStripeReadClient:async config=>{assert.equal(config.accountId,'acct_fixture');return {
      customers:async()=>{calls.push('stripeCustomers');return page(state.conflict?[{id:'cus_orphan',livemode:true,email:auth.email,metadata:{cafe_user_id:user}}]:[]);},
      subscriptions:async()=>{calls.push('stripeSubscriptions');return page(state.conflict?[{id:'sub_orphan',livemode:true,customer:'cus_orphan',status:'active',metadata:{cafe_user_id:user}}]:[]);},
      sessions:async()=>{calls.push('stripeSessions');return page();}};}};
  const run=async(action,body)=>{const res=output();await androidPublicBillingApplication(['verify','google-events'].includes(action)?'purchases':'billing',dependencies)(request(action,body),res);return res;};
  return {calls,state,dependencies,run};
}

test('configured real composition prepares and starts only after catalog, durable claim and fresh full Stripe scans',async()=>{
  const f=fixture(),prepared=await f.run('prepare',selection);
  assert.equal(prepared.code,200);assert.match(prepared.body.attemptId,/^[0-9a-f-]{36}$/);assert.equal(prepared.body.accountBinding,binding);
  assert.deepEqual(f.calls.slice(2),['catalog','rpc/native_checkout_claim','local','stripeCustomers','stripeSubscriptions','stripeSessions']);
  f.calls.length=0;const started=await f.run('start',{...selection,attemptId:prepared.body.attemptId});
  assert.equal(started.code,200);assert.deepEqual(f.calls.slice(2),['rpc/native_checkout_provider','catalog','local','stripeCustomers','stripeSubscriptions','stripeSessions','rpc/native_checkout_start']);
});
test('normal complimentary trialing café displays Free and can prepare/start only after fresh Stripe scans',async()=>{
  const f=fixture({localRow:{...local(),status:'trialing',complimentary_access:true}});
  const status=await f.run('status');assert.equal(status.code,200);assert.equal(status.body.access,'free');assert.equal(status.body.provider,null);assert.equal(status.body.canPurchase,true);
  f.calls.length=0;const prepared=await f.run('prepare',selection);assert.equal(prepared.code,200);
  assert.deepEqual(f.calls.slice(2),['catalog','rpc/native_checkout_claim','local','stripeCustomers','stripeSubscriptions','stripeSessions']);
  f.calls.length=0;const started=await f.run('start',{...selection,attemptId:prepared.body.attemptId});assert.equal(started.code,200);
  assert.deepEqual(f.calls.slice(2),['rpc/native_checkout_provider','catalog','local','stripeCustomers','stripeSubscriptions','stripeSessions','rpc/native_checkout_start']);
});
test('a new Stripe orphan after complimentary trialing prepare still blocks start and releases only the unlaunched claim',async()=>{
  const f=fixture({localRow:{...local(),status:'trialing',complimentary_access:true}});
  const prepared=await f.run('prepare',selection);assert.equal(prepared.code,200);
  f.state.conflict=true;f.calls.length=0;const started=await f.run('start',{...selection,attemptId:prepared.body.attemptId});
  assert.equal(started.code,409);assert.equal(f.calls.includes('rpc/native_checkout_start'),false);assert.equal(f.calls.at(-1),'rpc/android_google_checkout_cancel');
});
test('complimentary trialing café cannot prepare when public new sales remain disabled',async()=>{
  const f=fixture({environment:{BILLING_ENABLED:'false',NATIVE_PURCHASES_ENABLED:'false'},localRow:{...local(),status:'trialing',complimentary_access:true}});
  const response=await f.run('prepare',selection);assert.equal(response.code,409);
  for(const call of ['local','stripeCustomers','rpc/native_checkout_claim','rpc/native_checkout_start'])assert.equal(f.calls.includes(call),false);
});
test('new Stripe orphan conflict after prepare blocks start and only releases an unlaunched Google claim',async()=>{
  const f=fixture(),prepared=await f.run('prepare',selection);f.state.conflict=true;f.calls.length=0;
  const res=await f.run('start',{...selection,attemptId:prepared.body.attemptId});assert.equal(res.code,409);
  assert.equal(f.calls.includes('rpc/native_checkout_start'),false);assert.equal(f.calls.at(-1),'rpc/android_google_checkout_cancel');
});
test('confirmed Auth email is mandatory for remote Stripe eligibility and cannot come from metadata',async()=>{
  for(const auth of [{...cafe(),email:null,emailConfirmed:false},{...cafe(),emailConfirmed:false}]) {
    const f=fixture({auth}),res=await f.run('prepare',selection);assert.equal(res.code,409);
    assert.equal(f.calls.includes('stripeCustomers'),false);assert.equal(f.calls.at(-1),'rpc/android_google_checkout_cancel');
  }
});
test('owned Google cancellation uses no provider or Stripe reads and works with new sales disabled',async()=>{
  const f=fixture({environment:{BILLING_ENABLED:'false',NATIVE_PURCHASES_ENABLED:'false'}});
  const res=await f.run('cancel',{attemptId:attempt,reason:'user-cancelled'});assert.equal(res.code,200);
  assert.deepEqual(f.calls,['identity','auth','rpc/android_google_checkout_cancel']);
});
test('active status remains DB-read-only and offers checkout only with all gates plus confirmed email',async()=>{
  for(const [environment,auth,expected] of [[{},cafe(),true],[{BILLING_ENABLED:'false'},cafe(),false],
    [{ANDROID_GOOGLE_RECEIPTS_ACTIVE:'false'},cafe(),false],[{},{...cafe(),emailConfirmed:false},false]]) {
    const f=fixture({environment,auth}),res=await f.run('status');assert.equal(res.code,200);assert.equal(res.body.canPurchase,expected);
    assert.deepEqual(f.calls,['identity','auth','local']);
  }
});
test('restricted Stripe pins are captured only for active new sales and missing/full/test keys cannot activate',()=>{
  for(const mutation of [{ANDROID_STRIPE_READ_RESTRICTED_KEY:undefined},{ANDROID_STRIPE_READ_RESTRICTED_KEY:'sk_live_fixture'},
    {ANDROID_STRIPE_READ_RESTRICTED_KEY:'rk_test_fixture'},{ANDROID_STRIPE_ACCOUNT_ID:'other'},{ANDROID_STRIPE_MONTHLY_PRICE_ID:'other'}]) {
    assert.equal(readAndroidPublicBillingConfiguration({...env(),...mutation},pin.apiHost).newSalesEnabled,false);
    assert.equal(readAndroidPublicBillingConfiguration({...env(),...mutation,BILLING_ENABLED:'false'},pin.apiHost).stripe,null);
  }
  const config=readAndroidPublicBillingConfiguration(env(),pin.apiHost);assert.equal(config.newSalesEnabled,true);assert.ok(Object.isFrozen(config.stripe));
});
test('missing Stripe setup disables only new checkout while existing Google receipt and cancellation routes remain available',async()=>{
  const f=fixture({environment:{ANDROID_STRIPE_READ_RESTRICTED_KEY:undefined}});
  assert.equal((await f.run('prepare',selection)).code,409);assert.deepEqual(f.calls,[]);
  assert.equal((await f.run('verify',{provider:'google',proof:'purchase-fixture'})).code,200);
  assert.equal((await f.run('cancel',{attemptId:attempt,reason:'user-cancelled'})).code,200);
});
test('actual receipt reconciliation settles durable Google apply before acknowledgement and retries failed settlement',async()=>{
  for(const apply of ['applied','duplicate']) {
    const f=fixture({apply}),res=await f.run('verify',{provider:'google',proof:'purchase-fixture'});assert.equal(res.code,200);
    assert.deepEqual(f.calls.slice(-3),['apply','rpc/android_google_checkout_settle_verified','purchaseAck']);
  }
  const f=fixture({settleError:true}),failed=await f.run('verify',{provider:'google',proof:'purchase-fixture'});assert.equal(failed.code,503);assert.equal(f.calls.includes('purchaseAck'),false);
  f.state.settleError=false;f.state.apply='duplicate';f.calls.length=0;
  assert.equal((await f.run('verify',{provider:'google',proof:'purchase-fixture'})).code,200);
  assert.deepEqual(f.calls.slice(-3),['apply','rpc/android_google_checkout_settle_verified','purchaseAck']);
});
test('superseded Google purchase never settles checkout or gets acknowledged',async()=>{
  const f=fixture({apply:'superseded'}),res=await f.run('verify',{provider:'google',proof:'purchase-fixture'});assert.equal(res.code,200);
  assert.equal(res.body.purchase.access,'free');assert.equal(f.calls.includes('purchaseAck'),false);assert.equal(f.calls.includes('rpc/android_google_checkout_settle_verified'),false);
});
test('authenticated Sandbox and absent-binding events finish dedup only with no ledger apply or purchase ACK',async()=>{
  for(const options of [{inspectionEnvironment:'Sandbox'},{owner:null}]) {
    const f=fixture(options),res=await f.run('google-events',{message:{messageId:'event-fixture',data:'fixture'}});assert.equal(res.code,200);
    assert.ok(f.calls.indexOf('pubsubAuth')<f.calls.indexOf('claimEvent'));assert.ok(f.calls.includes('authoritativeGoogle'));assert.equal(f.calls.at(-1),'eventSuccess');
    for(const call of ['apply','purchaseAck','rpc/android_google_checkout_settle_verified'])assert.equal(f.calls.includes(call),false);
  }
});
test('known Production event settlement failure remains retryable and cannot finish success or ACK',async()=>{
  const f=fixture({settleError:true}),res=await f.run('google-events',{message:{messageId:'event-fixture',data:'fixture'}});assert.equal(res.code,503);
  assert.equal(f.calls.at(-1),'eventFailure');assert.equal(f.calls.includes('purchaseAck'),false);assert.equal(f.calls.includes('eventSuccess'),false);
});

function eventFixture(changes={}) {
  const calls=[],event={provider:'google',eventId:'fixture',providerSubscriptionId:'proof'};
  const repository={claimEvent:async()=>{calls.push('claim');return 'claimed';},owner:async()=>({userId:user}),finishEvent:async args=>{calls.push(args.success?'success':'failure');return true;},...changes.repository};
  const runtime={inspectNotification:async()=>({environment:'Production',binding,providerSubscriptionId:'proof'}),...changes.runtime};
  return {calls,run:()=>androidGooglePublicEvent({event:{...event,...changes.event},payload:'fixture',repository,runtime,reconcile:async()=>{calls.push('reconcile');return verified();}})};
}
test('malformed owner/binding and provider/DB failures never become an ignored unknown account',async()=>{
  for(const changes of [{repository:{owner:async()=>undefined}},{repository:{owner:async()=>({userId:'wrong'})}},
    {repository:{owner:async()=>{throw Error('DB outage');}}},{runtime:{inspectNotification:async()=>{throw Error('provider 404');}}},
    {runtime:{inspectNotification:async()=>({environment:'Production',binding:'malformed',providerSubscriptionId:'proof'})}}]) {
    const f=eventFixture(changes);await assert.rejects(f.run());assert.equal(f.calls.includes('reconcile'),false);assert.equal(f.calls.at(-1),'failure');
  }
});
test('duplicate and authenticated official test/one-time events never fetch a subscription or apply state',async()=>{
  const unavailable=()=>assert.fail('ignored event performed provider/owner work');
  const duplicate=eventFixture({repository:{claimEvent:async()=> 'duplicate',owner:unavailable},runtime:{inspectNotification:unavailable}});
  assert.deepEqual(await duplicate.run(),{kind:'duplicate'});
  for(const extra of [{test:true},{ignored:'google-one-time-voided-purchase'}]) {
    const f=eventFixture({event:{...extra,providerSubscriptionId:undefined},repository:{owner:unavailable},runtime:{inspectNotification:unavailable}});
    await f.run();assert.deepEqual(f.calls,['claim','success']);
  }
});
test('transport derives verified email only from fresh Auth and exact checkout RPCs reject extra/provider/environment arguments',async()=>{
  const config={supabase:{url:pin.supabaseUrl,publishableKey:'sb_publishable_fixture',secretKey:'sb_secret_fixture'}};
  for(const auth of [{id:user,email:'verified@example.invalid',email_confirmed_at:'2026-10-01T00:00:00Z',user_metadata:{email:'other@example.invalid',emailConfirmed:false}},
    {id:user,user_metadata:{email:'forged@example.invalid',email_confirmed_at:'2026-10-01T00:00:00Z'}}]) {
    let calls=0;const transport=androidSupabaseTransport(config,{fetchImpl:async()=>({ok:true,text:async()=>JSON.stringify(++calls===1?auth:[cafe().profile])})});
    const result=await transport.authenticateCafe(request('status'));assert.equal(result.email,auth.email ?? null);assert.equal(result.emailConfirmed,!!auth.email_confirmed_at);
  }
  const denied=androidSupabaseTransport(config,{fetchImpl:()=>assert.fail('invalid RPC reached database')});
  for(const [name,body] of [['native_checkout_claim',{p_user_id:user,p_environment:'Production',p_attempt_id:attempt,p_provider:'apple'}],
    ['native_checkout_provider',{p_user_id:user,p_environment:'Sandbox',p_attempt_id:attempt}],
    ['native_checkout_start',{p_user_id:user,p_environment:'Production',p_attempt_id:attempt,p_provider:'google'}],
    ['android_google_checkout_cancel',{p_user_id:user,p_attempt_id:attempt,p_before_launch:'false'}],
    ['android_google_checkout_settle_verified',{p_user_id:user,p_environment:'Production'}]]) {
    await assert.rejects(denied.adminRows(`rpc/${name}`,{method:'POST',body:JSON.stringify(body)}));
  }
});
test('only an actual null owner RPC result may be interpreted as a deleted/unbound account',async()=>{
  const config={supabase:{url:pin.supabaseUrl,publishableKey:'sb_publishable_fixture',secretKey:'sb_secret_fixture'}};
  for(const value of [false,0,'',[],{},'not-a-uuid']) {
    const transport=androidSupabaseTransport(config,{fetchImpl:async()=>({ok:true,text:async()=>JSON.stringify(value)})});
    await assert.rejects(transport.adminRows('rpc/native_billing_owner',{method:'POST',body:JSON.stringify({p_binding:binding})}));
  }
  for(const value of [null,user]) {
    const transport=androidSupabaseTransport(config,{fetchImpl:async()=>({ok:true,text:async()=>JSON.stringify(value)})});
    assert.equal(await transport.adminRows('rpc/native_billing_owner',{method:'POST',body:JSON.stringify({p_binding:binding})}),value);
  }
});

const googlePurchase=(changes={})=>({kind:'androidpublisher#subscriptionPurchaseV2',externalAccountIdentifiers:{obfuscatedExternalAccountId:binding},
  subscriptionState:'SUBSCRIPTION_STATE_ACTIVE',acknowledgementState:'ACKNOWLEDGEMENT_STATE_PENDING',
  lineItems:[{productId:pin.productId,offerDetails:{basePlanId:pin.basePlanId},expiryTime:'2026-11-01T00:00:00Z',autoRenewingPlan:{autoRenewEnabled:true}}],...changes});
test('runtime Sandbox classification requires authenticated Google response with exact product/base-plan/UUID and object test marker',async()=>{
  const config=readAndroidPublicBillingConfiguration(env(),pin.apiHost),calls=[];let data=googlePurchase({testPurchase:{}});
  const runtime=await androidGoogleRuntime(config,{now:()=>now,loadGoogle:async()=>({OAuth2Client:class{}}),createAuthClient:async()=>({request:async options=>{calls.push(options);return {data};}})});
  assert.equal((await runtime.inspectNotification('proof')).environment,'Sandbox');assert.equal(calls[0].method,'GET');assert.equal(calls[0].timeout,15000);
  assert.equal(calls[0].url,`https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${pin.packageName}/purchases/subscriptionsv2/tokens/proof`);
  data=googlePurchase();assert.equal((await runtime.inspectNotification('proof')).environment,'Production');
  for(const changes of [{testPurchase:false},{testPurchase:null},{testPurchase:'yes'},{testPurchase:[]},
    {externalAccountIdentifiers:{obfuscatedExternalAccountId:'bad'}},{lineItems:[{...googlePurchase().lineItems[0],productId:'other'}]},
    {lineItems:[{...googlePurchase().lineItems[0],offerDetails:{basePlanId:'other'}}]},{subscriptionState:'unknown'}]) {
    data=googlePurchase(changes);await assert.rejects(runtime.inspectNotification('proof'));
  }
  const count=calls.length;await assert.rejects(runtime.inspectNotification('bad proof'));assert.equal(calls.length,count);
});
