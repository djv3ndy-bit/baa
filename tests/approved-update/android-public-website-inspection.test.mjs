import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectAndroidPublicWebsiteBilling} from '../../server/android-public-billing/websiteInspection.mjs';

const userId='10000000-0000-4000-8000-000000000001';
const valid=()=>({user_id:userId,status:'free',current_period_end:null,cancel_at_period_end:false,
  stripe_customer_id:null,stripe_subscription_id:null,stripe_checkout_attempt_id:null});
const inspect=(row,extra={})=>inspectAndroidPublicWebsiteBilling({provider:'google',userId,readSubscription:async id=>{assert.equal(id,userId);return row;},...extra});
test('only a complete caller-bound existing row with explicit null Stripe IDs passes the local shape check',async()=>{
  assert.equal(await inspect(valid()),true);
});
test('missing, array, empty, inherited or mismatched row cannot authorize local eligibility',async()=>{
  for(const row of [null,undefined,[],{},Object.create(valid()),{...valid(),user_id:'other'}])await assert.rejects(inspect(row),{code:'WEBSITE_BILLING_EXISTS'});
});
for(const key of ['stripe_customer_id','stripe_subscription_id','stripe_checkout_attempt_id']) {
  test(`${key}: linked, orphaned, empty, missing or ambiguous identifiers block without Stripe access`,async()=>{
    for(const value of ['cus_fixture','sub_fixture','attempt_fixture','',undefined,false,0,{}])await assert.rejects(inspect({...valid(),[key]:value}),{code:'WEBSITE_BILLING_EXISTS'});
    const row=valid();delete row[key];await assert.rejects(inspect(row),{code:'WEBSITE_BILLING_EXISTS'});
  });
}
test('Apple and unknown providers are rejected before subscription lookup; Apple implementation remains separate',async()=>{
  for(const provider of ['apple','stripe',undefined])await assert.rejects(inspect(valid(),{provider,readSubscription:()=>assert.fail('no read')}),{code:'PROVIDER_UNAVAILABLE'});
});
test('database failure propagates as unavailable rather than permissive local state',async()=>{
  await assert.rejects(inspect(null,{readSubscription:async()=>{throw Error('database unavailable');}}),/database unavailable/);
});
test('missing or malformed account identity is blocked before lookup',async()=>{
  for(const userId of [undefined,null,'','other',{}])await assert.rejects(inspect(null,{userId,readSubscription:()=>assert.fail('must not read')}),{code:'WEBSITE_BILLING_EXISTS'});
});
test('paid, pending or ambiguous local status is blocked despite null Stripe identifiers',async()=>{
  for(const status of ['active','trialing','pending','past_due','canceled','',undefined,null])await assert.rejects(inspect({...valid(),status}),{code:'WEBSITE_BILLING_EXISTS'});
  for(const [key,values] of [['current_period_end',['2026-11-01',undefined,false]],['cancel_at_period_end',[true,undefined,null]]]) {
    for(const value of values)await assert.rejects(inspect({...valid(),[key]:value}),{code:'WEBSITE_BILLING_EXISTS'});
  }
  for(const key of ['status','current_period_end','cancel_at_period_end']) {const row=valid();delete row[key];await assert.rejects(inspect(row),{code:'WEBSITE_BILLING_EXISTS'});}
});
