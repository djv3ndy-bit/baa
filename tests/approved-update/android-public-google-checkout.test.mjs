import test from 'node:test';
import assert from 'node:assert/strict';
import {androidPublicGoogleCheckoutService,androidGoogleCheckoutRepository} from '../../server/android-public-billing/checkout.mjs';

const user='10000000-0000-4000-8000-000000000001',id='20000000-0000-4000-8000-000000000001',binding='30000000-0000-4000-8000-000000000001';
const account={id:user,role:'cafe_owner_manager',suspendedAt:null,email:'owner@example.invalid',emailConfirmed:true};
const selection={provider:'google',productId:'baristamatch_cafe_pro',basePlanId:'monthly-us',storefront:'US'};
function setup(overrides={}) {
  const calls=[];
  const repository={claimCheckout:async(...a)=>{calls.push(['claim',...a]);return {attemptId:id,accountBinding:binding};},
    checkoutProvider:async(...a)=>{calls.push(['provider',...a]);return 'google';},
    startCheckout:async(...a)=>{calls.push(['start',...a]);return true;},
    cancelGoogleCheckout:async(...a)=>{calls.push(['cancel',...a]);return true;},...overrides.repository};
  const service=androidPublicGoogleCheckoutService({repository,enabled:true,createId:()=>id,
    ready:async()=>calls.push(['ready']),inspectWebsiteBilling:async a=>{calls.push(['inspect',a.id]);return true;},...overrides,repository});
  return {service,calls};
}
test('Google prepares only after readiness, an exact durable owned claim and remote Stripe inspection',async()=>{
  const f=setup();assert.deepEqual(await f.service.prepare(account,selection),{attemptId:id,accountBinding:binding});
  assert.deepEqual(f.calls,[['ready'],['claim',user,'google','Production',id],['inspect',user]]);
});
test('disabled sales, wrong account and stale/Apple catalog selection fail before any dependencies',async()=>{
  const off=setup({enabled:false});await assert.rejects(off.service.prepare(account,selection),{code:'NOT_ENABLED'});assert.deepEqual(off.calls,[]);
  for(const a of [{...account,id:'other'},{...account,role:'barista'},{...account,suspendedAt:'now'}]) {
    const f=setup();await assert.rejects(f.service.prepare(a,selection));assert.deepEqual(f.calls,[]);
  }
  for(const s of [{...selection,provider:'apple'},{...selection,basePlanId:'old'},{...selection,storefront:'USA'},{...selection,productId:'other'}]) {
    const f=setup();await assert.rejects(f.service.prepare(account,s),{code:'PRODUCT_UNAVAILABLE'});assert.deepEqual(f.calls,[]);
  }
});
test('provider readiness failure cannot allocate a reservation',async()=>{
  const f=setup({ready:async()=>{throw Error('not configured');}});await assert.rejects(f.service.prepare(account,selection));assert.deepEqual(f.calls,[]);
});
test('a blocked or malformed claim never reaches Stripe inspection',async()=>{
  for(const result of [null,{attemptId:id},{attemptId:binding,accountBinding:binding},{attemptId:id,accountBinding:'bad'}]) {
    const f=setup({repository:{claimCheckout:async()=>result}});await assert.rejects(f.service.prepare(account,selection),{code:'CHECKOUT_BLOCKED'});assert.deepEqual(f.calls,[['ready']]);
  }
});
test('remote conflicts/outages release only the original unused Google claim; lost cleanup does not authorize launch',async()=>{
  for(const inspectWebsiteBilling of [async()=>false,async()=>{throw Error('offline');}]) {
    const f=setup({inspectWebsiteBilling,repository:{cancelGoogleCheckout:async(...a)=>{f.calls.push(['cancel',...a]);throw Error('lost response');}}});
    await assert.rejects(f.service.prepare(account,selection));assert.deepEqual(f.calls.at(-1),['cancel',user,id,true]);
  }
});
test('start uses stored provider, revalidates original plan and fresh remote conflicts, then atomically authorizes once',async()=>{
  const f=setup();assert.deepEqual(await f.service.start(account,id,selection),{started:true});
  assert.deepEqual(f.calls,[['provider',user,'Production',id],['ready'],['inspect',user],['start',user,'Production',id]]);
});
test('Apple reservation, stale client plan and expired/rejected atomic start cannot be redirected or launched',async()=>{
  for(const provider of ['apple',null,undefined]) {
    const f=setup({repository:{checkoutProvider:async()=>provider}});await assert.rejects(f.service.start(account,id,selection),{code:'CHECKOUT_BLOCKED'});assert.deepEqual(f.calls,[]);
  }
  const stale=setup();await assert.rejects(stale.service.start(account,id,{...selection,basePlanId:'old'}));assert.deepEqual(stale.calls,[]);
  const denied=setup({repository:{startCheckout:async()=>false}});await assert.rejects(denied.service.start(account,id,selection),{code:'CHECKOUT_BLOCKED'});
});
test('new remote conflict between prepare/start never reaches atomic start and cleanup cannot release an already-started attempt',async()=>{
  let clear=true;
  const f=setup({inspectWebsiteBilling:async()=>clear});await f.service.prepare(account,selection);clear=false;
  await assert.rejects(f.service.start(account,id,selection),{code:'WEBSITE_BILLING_EXISTS'});
  assert.equal(f.calls.some(x=>x[0]==='start'),false);assert.deepEqual(f.calls.at(-1),['cancel',user,id,true]);
});
test('explicit SDK user cancellation uses Google-only atomic cancel and remains available with sales off',async()=>{
  const f=setup({enabled:false});assert.deepEqual(await f.service.cancel(account,id,'user-cancelled'),{cancelled:true});
  assert.deepEqual(f.calls,[['cancel',user,id,false]]);
  for(const reason of ['pending','network-error','no-purchases',undefined])await assert.rejects(f.service.cancel(account,id,reason),{code:'INVALID_CANCELLATION'});
  const denied=setup({repository:{cancelGoogleCheckout:async()=>false}});await assert.rejects(denied.service.cancel(account,id,'user-cancelled'),{code:'CHECKOUT_BLOCKED'});
});
test('scoped repository hardcodes Google Production and refuses broad cancel/provider/environment changes before transport',async()=>{
  const calls=[],repo=androidGoogleCheckoutRepository(async(path,options)=>{calls.push([path,JSON.parse(options.body)]);return true;});
  await repo.claimCheckout(user,'google','Production',id);await repo.checkoutProvider(user,'Production',id);
  await repo.startCheckout(user,'Production',id);await repo.cancelGoogleCheckout(user,id,false);
  assert.deepEqual(calls.map(x=>x[0]),['rpc/native_checkout_claim','rpc/native_checkout_provider','rpc/native_checkout_start','rpc/android_google_checkout_cancel']);
  assert.deepEqual(calls.at(-1)[1],{p_user_id:user,p_attempt_id:id,p_before_launch:false});
  await repo.settleVerifiedGoogleCheckout(user);assert.deepEqual(calls.at(-1),['rpc/android_google_checkout_settle_verified',{p_user_id:user}]);
  assert.equal('cancelCheckout' in repo,false);
  assert.throws(()=>repo.claimCheckout(user,'apple','Production',id));assert.throws(()=>repo.startCheckout(user,'Sandbox',id));
  assert.throws(()=>repo.cancelGoogleCheckout(user,id,null));assert.equal(calls.length,5);
});
