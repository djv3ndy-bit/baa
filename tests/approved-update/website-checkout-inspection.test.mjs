import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectNativeWebsiteBilling} from '../../server/native-billing/websiteCheckoutInspection.mjs';
import {nativeCheckoutService} from '../../server/native-billing/checkoutService.mjs';
const userId='test-cafe';
const missingStripe=()=>{throw Error('Stripe configuration is absent');};
const inspect=(subscription,overrides={})=>inspectNativeWebsiteBilling({
  provider:'google',userId,readSubscription:async()=>subscription,
  createStripe:missingStripe,readStripeMode:()=>{throw Error('Stripe mode must not be read');},...overrides,
});
function stripe({customer={},subscriptions=[],sessions=[]}={}) {
  const calls=[];
  return {calls,client:{
    customers:{retrieve:async id=>{calls.push(['customer',id]);return {id:'cus_test',livemode:false,metadata:{cafe_user_id:userId},...customer};}},
    subscriptions:{list:async options=>{calls.push(['subscriptions',options]);return {data:subscriptions,has_more:false};}},
    checkout:{sessions:{list:async options=>{calls.push(['sessions',options]);return {data:sessions,has_more:false};}}},
  }};
}
test('Google without Stripe identifiers succeeds without a Stripe key, account, price or mode',async()=>{
  assert.equal(await inspect({stripe_customer_id:null,stripe_subscription_id:null,stripe_checkout_attempt_id:null}),true);
  assert.equal(await inspect({}),true);
});
test('Google missing records and orphaned Stripe identifiers fail closed without initializing Stripe',async()=>{
  for(const subscription of [null,undefined,{stripe_subscription_id:'sub_orphan'},{stripe_checkout_attempt_id:'checkout_orphan'}]) {
    assert.equal(await inspect(subscription),false);
  }
});
test('Google linked customers require the existing Stripe configuration and complete ownership and conflict reads',async()=>{
  const subscription={stripe_customer_id:'cus_test'};
  await assert.rejects(inspect(subscription),/Stripe configuration is absent/);
  const provider=stripe();
  assert.equal(await inspect(subscription,{createStripe:async()=>provider.client,readStripeMode:()=>'test'}),true);
  assert.deepEqual(provider.calls.map(call=>call[0]),['customer','subscriptions','sessions']);
  assert.equal(provider.calls[1][1].customer,'cus_test');
  assert.equal(provider.calls[2][1].customer,'cus_test');
});
test('Google linked active or unpaid subscriptions, open web checkout and wrong customer ownership remain blocked',async()=>{
  for(const status of ['active','past_due','incomplete','unknown']) {
    const provider=stripe({subscriptions:[{id:'sub_test',customer:'cus_test',livemode:false,status}]});
    assert.equal(await inspect({stripe_customer_id:'cus_test'},{createStripe:async()=>provider.client,readStripeMode:()=>'test'}),false);
  }
  for(const options of [{sessions:[{id:'cs_open'}]},{customer:{metadata:{cafe_user_id:'other-cafe'}}},{customer:{livemode:true}},{customer:{deleted:true}}]) {
    const provider=stripe(options);
    assert.equal(await inspect({stripe_customer_id:'cus_test'},{createStripe:async()=>provider.client,readStripeMode:()=>'test'}),false);
  }
});
test('Google propagates database and linked Stripe failures instead of permitting checkout',async()=>{
  await assert.rejects(inspect(null,{readSubscription:async()=>{throw Error('Database unavailable');}}),/Database unavailable/);
  const provider=stripe();provider.client.subscriptions.list=async()=>{throw Error('Stripe unavailable');};
  await assert.rejects(inspect({stripe_customer_id:'cus_test'},{createStripe:async()=>provider.client,readStripeMode:()=>'test'}),/Stripe unavailable/);
});
test('Apple retains eager Stripe initialization and the original subscription/configuration/mode order',async()=>{
  for(const subscription of [null,{}])await assert.rejects(inspect(subscription,{provider:'apple'}),/Stripe configuration is absent/);
  const order=[];
  assert.equal(await inspect({},{
    provider:'apple',readSubscription:async id=>{assert.equal(id,userId);order.push('subscription');return {};},
    createStripe:async()=>{order.push('Stripe');return {};},readStripeMode:()=>{order.push('mode');return 'test';},
  }),true);
  assert.deepEqual(order,['subscription','Stripe','mode']);
});
test('Apple linked customers still use all existing Stripe ownership and conflict checks',async()=>{
  for(const options of [{},{sessions:[{id:'cs_open'}]},{customer:{metadata:{cafe_user_id:'other-cafe'}}}]) {
    const provider=stripe(options);
    const result=await inspect({stripe_customer_id:'cus_test'},{provider:'apple',createStripe:async()=>provider.client,readStripeMode:()=>'test'});
    assert.equal(result,Object.keys(options).length===0);
  }
});
test('unknown providers are rejected before database or Stripe access',async()=>{
  await assert.rejects(inspect(null,{provider:'unknown',readSubscription:async()=>{throw Error('Must not read');}}),{code:'PROVIDER_UNAVAILABLE'});
});
function checkout(provider,subscription) {
  const calls=[];
  const account={id:userId,role:'cafe_owner_manager'};
  const attempt={attemptId:'10000000-0000-4000-8000-000000000001',accountBinding:'20000000-0000-4000-8000-000000000001'};
  const repository={
    claimCheckout:async()=>{calls.push(['claim']);return attempt;},
    cancelCheckout:async(...args)=>{calls.push(['cancel',...args]);return true;},
  };
  const service=nativeCheckoutService({
    repository,environment:'Sandbox',enabled:true,productId:'apple.monthly',
    googlePlan:{productId:'google.monthly',basePlanId:'monthly'},
    ready:async value=>calls.push(['ready',value]),
    inspectWebsiteBilling:async(...args)=>{
      calls.push(['inspect',...args]);
      return inspect(subscription,{provider:args[1] || 'apple'});
    },
  });
  const request=provider==='google'?{provider,productId:'google.monthly',basePlanId:'monthly',storefront:'US'}
    :{provider,productId:'apple.monthly',storefront:'USA'};
  return {account,attempt,calls,service,request};
}
test('Google prepare passes its validated provider and succeeds after reservation without Stripe configuration',async()=>{
  const h=checkout('google',{});
  assert.deepEqual(await h.service.prepare(h.account,h.request),h.attempt);
  assert.deepEqual(h.calls,[['ready','google'],['claim'],['inspect',userId,'google']]);
});
test('Google missing billing records reject prepare and release only the unused reservation',async()=>{
  const h=checkout('google',null);
  await assert.rejects(h.service.prepare(h.account,h.request),{code:'WEBSITE_BILLING_EXISTS'});
  assert.deepEqual(h.calls.at(-1),['cancel',userId,'Sandbox',h.attempt.attemptId,true]);
});
test('Apple prepare keeps its one-argument inspection contract and remains blocked by missing Stripe configuration',async()=>{
  const h=checkout('apple',{});
  await assert.rejects(h.service.prepare(h.account,h.request),/Stripe configuration is absent/);
  assert.deepEqual(h.calls[2],['inspect',userId]);
  assert.deepEqual(h.calls.at(-1),['cancel',userId,'Sandbox',h.attempt.attemptId,true]);
});
