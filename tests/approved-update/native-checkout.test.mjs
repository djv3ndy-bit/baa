import test from 'node:test';
import assert from 'node:assert/strict';
import {nativeCheckoutService,websiteBillingAllowsNative} from '../../server/native-billing/checkoutService.mjs';
import {checkoutHandler} from '../../server/native-billing/checkoutHandler.mjs';
const id='10000000-0000-4000-8000-000000000001',binding='20000000-0000-4000-8000-000000000001';
const account={id:'cafe-a',role:'cafe_owner_manager'},request={provider:'apple',productId:'actual.monthly',storefront:'USA'};
function setup(overrides={}){
 const calls=[];
 const repository={
 claimCheckout:async(...args)=>{calls.push(['claim',...args]);return {attemptId:id,accountBinding:binding};},
 startCheckout:async(...args)=>{calls.push(['start',...args]);return true;},
 cancelCheckout:async(...args)=>{calls.push(['cancel',...args]);return true;},
 settleVerifiedCheckout:async()=>true,summary:async()=>({accountId:account.id,environment:'Production',subscriptions:[]}),checkoutPending:async()=>false,...overrides.repository};
 const service=nativeCheckoutService({repository,environment:'Production',enabled:true,productId:'actual.monthly',createId:()=>id,
 ready:async()=>calls.push(['ready']),inspectWebsiteBilling:async()=>{calls.push(['inspect']);return true;},...overrides,repository});
 return {service,calls};
}
test('native preflight verifies server readiness, reserves atomically, then checks the existing provider',async()=>{
 const h=setup();assert.deepEqual(await h.service.prepare(account,request),{attemptId:id,accountBinding:binding});
 assert.deepEqual(h.calls.map(row=>row[0]),['ready','claim','inspect']);
});
test('verification misconfiguration prevents both reservation and store launch',async()=>{
 const h=setup({ready:async()=>{throw Error('missing key');}});await assert.rejects(h.service.prepare(account,request));assert.deepEqual(h.calls,[]);
});
test('existing web billing and failed provider requests release only the unused native reservation',async()=>{
 for(const inspect of [async()=>false,async()=>{throw Error('offline');}]){
 const h=setup({inspectWebsiteBilling:inspect});await assert.rejects(h.service.prepare(account,request));
 assert.deepEqual(h.calls.at(-1),['cancel',account.id,'Production',id,true]);
 }
});
test('lost cleanup response leaves a safely expiring unused reservation and no success response',async()=>{
 const h=setup({inspectWebsiteBilling:async()=>false,repository:{cancelCheckout:async()=>{throw Error('offline');}}});
 await assert.rejects(h.service.prepare(account,request),error=>error.code==='WEBSITE_BILLING_EXISTS');
});
test('purchase startup and cancellation are scoped to the authenticated account and attempt',async()=>{
 const h=setup();await h.service.start(account,id);await h.service.cancel(account,id,'user-cancelled');
 assert.deepEqual(h.calls.at(-1),['cancel',account.id,'Production',id,false]);
 for(const reason of ['network-error','pending','no-purchases',''])await assert.rejects(h.service.cancel(account,id,reason));
});
test('disabled purchases, baristas, suspended accounts, wrong products and other storefronts cannot reserve',async()=>{
 for(const [a,r] of [[{...account,role:'barista'},request],[{...account,suspendedAt:'now'},request],[account,{...request,productId:'other'}],[account,{...request,storefront:'BHS'}],[account,{...request,provider:'google'}]]){
 const h=setup();await assert.rejects(h.service.prepare(a,r));assert.deepEqual(h.calls,[]);
 }
 const h=setup({enabled:false});await assert.rejects(h.service.prepare(account,request));assert.deepEqual(h.calls,[]);
});
test('combined status remains readable while new purchases are disabled',async()=>{
 const h=setup({enabled:false});const result=await h.service.status(account,{plan:'free',connectedToBilling:false,canManageBilling:false,billingPaused:false});
 assert.equal(result.verified,true);assert.equal(result.canPurchase,false);assert.equal(result.access,'free');
});
function provider({subscriptions=[],sessions=[],customer={},more=false}={}){
 return {customers:{retrieve:async()=>({id:'cus_a',livemode:true,metadata:{cafe_user_id:account.id},...customer})},
 subscriptions:{list:async()=>({data:subscriptions,has_more:more})},checkout:{sessions:{list:async()=>({data:sessions,has_more:false})}}};
}
const inspect=(stripe,subscription={stripe_customer_id:'cus_a'})=>websiteBillingAllowsNative({userId:account.id,subscription,stripe,liveMode:true});
test('existing legacy plans, unpaid subscriptions and web sessions prevent a native duplicate',async()=>{
 for(const status of ['active','trialing','past_due','unpaid','incomplete','paused','unknown']){
 assert.equal(await inspect(provider({subscriptions:[{id:'sub_a',customer:'cus_a',livemode:true,status}]})),false);
 }
 assert.equal(await inspect(provider({sessions:[{id:'cs_old'}]})),false);
 assert.equal(await inspect(provider({subscriptions:[{id:'sub_a',customer:'cus_a',livemode:true,status:'canceled'}]})),true);
});
test('a missing billing record or broken customer ownership never permits a new subscription',async()=>{
 assert.equal(await inspect(provider(),null),false);assert.equal(await inspect(provider(),{stripe_subscription_id:'sub_orphan'}),false);
 for(const customer of [{deleted:true},{id:'cus_b'},{livemode:false},{metadata:{cafe_user_id:'other'}}])assert.equal(await inspect(provider({customer})),false);
});
test('a free account without a Stripe customer needs no provider customer lookup',async()=>{
 assert.equal(await inspect({},{}),true);
});
test('truncated or non-progressing Stripe pagination fails closed',async()=>{
 await assert.rejects(inspect(provider({more:true})));await assert.rejects(inspect(provider({more:true,subscriptions:[{id:'sub_a',customer:'cus_a',livemode:true,status:'canceled'}]})));
});
async function http({method='POST',action='prepare',body=request,user={id:account.id,profile:{role:account.role}},overrides={}}={}){
 const h=setup(overrides),res={headers:{},code:0,setHeader(k,v){this.headers[k]=v;},status(v){this.code=v;return this;},json(v){this.body=v;return this;}};
 const handler=checkoutHandler({authenticateCafe:async()=>user,serviceFor:()=>h.service,websiteStatus:async()=>({plan:'free',connectedToBilling:false,canManageBilling:false,billingPaused:false})});
 await handler({method,query:{action},body},res);return {...res,calls:h.calls};
}
test('checkout HTTP validates method, action, auth, JSON size and saved café role',async()=>{
 assert.equal((await http({method:'GET'})).code,405);assert.equal((await http({action:'charge'})).code,404);
 assert.equal((await http({user:null})).code,401);assert.equal((await http({user:{id:'b',profile:{role:'barista'}}})).code,403);
 assert.equal((await http({body:'{bad'})).code,400);assert.equal((await http({body:'x'.repeat(5000)})).code,413);
});
test('HTTP ignores caller-supplied account identity and exposes no underlying provider errors',async()=>{
 const result=await http({body:{...request,accountId:'other'}});assert.equal(result.code,200);assert.equal(result.calls.find(row=>row[0]==='claim')[1],account.id);
 const failed=await http({overrides:{inspectWebsiteBilling:async()=>{throw Error('private secret token');}}});assert.equal(failed.code,503);assert.equal(JSON.stringify(failed.body).includes('private'),false);
});
test('status is read through the existing website status contract plus the private native ledger',async()=>{
 const result=await http({method:'GET',action:'status'});assert.equal(result.code,200);assert.equal(result.body.accountId,account.id);assert.equal(result.headers['Cache-Control'],'no-store');
});
