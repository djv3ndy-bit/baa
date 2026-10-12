import test from 'node:test';
import assert from 'node:assert/strict';
import {createAndroidStripeReadClient,inspectAndroidPublicStripeBilling} from '../../server/android-public-billing/stripeInspection.mjs';

const userId='10000000-0000-4000-8000-000000000001';
const account={id:userId,role:'cafe_owner_manager',suspendedAt:null,email:'owner@example.invalid',emailConfirmed:true};
const local=()=>({user_id:userId,status:'free',current_period_end:null,cancel_at_period_end:false,
  stripe_customer_id:null,stripe_subscription_id:null,stripe_checkout_attempt_id:null});
const customer=(overrides={})=>({id:'cus_fixture',livemode:true,metadata:{cafe_user_id:userId},email:'owner@example.invalid',...overrides});
const subscription=(overrides={})=>({id:'sub_fixture',livemode:true,customer:'cus_fixture',metadata:{cafe_user_id:userId},status:'canceled',...overrides});
const session=(overrides={})=>({id:'cs_fixture',livemode:true,customer:'cus_fixture',metadata:{cafe_user_id:userId},client_reference_id:userId,status:'open',...overrides});
function fixture({customers=[],subscriptions=[],sessions=[],row=local(),client:override,...options}={}) {
  const calls=[];
  const client=Object.fromEntries(Object.entries({customers,subscriptions,sessions}).map(([name,data])=>[name,async params=>{
    calls.push([name,params]);return {object:'list',data,has_more:false};
  }]));
  Object.assign(client,override);
  return {calls,run:extra=>inspectAndroidPublicStripeBilling({account,readSubscription:async id=>{calls.push(['row',id]);return row;},createClient:async()=>{calls.push(['client']);return client;},...options,...extra})};
}
test('free local IDs are insufficient: exhaustive live customer, subscription and open-session lists must all complete',async()=>{
  const f=fixture();assert.equal(await f.run(),true);
  assert.deepEqual(f.calls.map(x=>x[0]),['row','client','customers','subscriptions','sessions']);
  assert.deepEqual(f.calls.slice(2),[['customers',{limit:100}],['subscriptions',{status:'all',limit:100}],['sessions',{status:'open',limit:100}]]);
});
test('metadata-owned orphan customer with changed email and renewable legacy subscription blocks a second charge',async()=>{
  for(const status of ['active','trialing','past_due','unpaid','incomplete','paused']) {
    const f=fixture({customers:[customer({email:'old@example.invalid'})],subscriptions:[subscription({status})]});
    await assert.rejects(f.run(),{code:'WEBSITE_BILLING_EXISTS'});
  }
});
test('unknown subscription status, wrong live mode and malformed pages fail closed even for unrelated rows',async()=>{
  for(const client of [
    {customers:async()=>({data:[],has_more:false})},
    {customers:async()=>({object:'list',data:[],has_more:'false'})},
    {customers:async()=>({object:'list',data:Array(101).fill(customer()),has_more:false})},
    {subscriptions:async()=>({object:'list',data:[subscription({status:'unknown'})],has_more:false})},
    {customers:async()=>({object:'list',data:[customer({livemode:false})],has_more:false})},
    {sessions:async()=>({object:'list',data:[session({livemode:false})],has_more:false})},
  ])await assert.rejects(fixture({client}).run(),{code:'PROVIDER_UNAVAILABLE'});
});
test('matching verified email with absent or different customer metadata is ambiguous and blocked',async()=>{
  for(const metadata of [{},{cafe_user_id:'10000000-0000-4000-8000-000000000002'}]) {
    await assert.rejects(fixture({customers:[customer({metadata,email:'OWNER@EXAMPLE.INVALID'})]}).run(),{code:'WEBSITE_BILLING_EXISTS'});
  }
});
test('caller metadata on an orphan subscription not found through customer ownership is blocked',async()=>{
  await assert.rejects(fixture({subscriptions:[subscription()]}).run(),{code:'WEBSITE_BILLING_EXISTS'});
  await assert.rejects(fixture({customers:[customer()],subscriptions:[subscription({metadata:{cafe_user_id:'other'}})]}).run(),{code:'WEBSITE_BILLING_EXISTS'});
});
test('owned terminal subscriptions permit Google only after all open checkout sessions are excluded',async()=>{
  for(const status of ['canceled','incomplete_expired'])assert.equal(await fixture({customers:[customer()],subscriptions:[subscription({status})]}).run(),true);
  for(const row of [session(),session({customer:null}),session({metadata:{},client_reference_id:null,customer:null,customer_email:account.email}),
    session({metadata:{},client_reference_id:null,customer:null,customer_details:{email:account.email}})]) {
    await assert.rejects(fixture({customers:[customer()],sessions:[row]}).run(),{code:'WEBSITE_BILLING_EXISTS'});
  }
});
test('complete linked terminal local history needs matching authoritative customer and subscription',async()=>{
  const row={...local(),status:'canceled',stripe_customer_id:'cus_fixture',stripe_subscription_id:'sub_fixture'};
  assert.equal(await fixture({row,customers:[customer()],subscriptions:[subscription()]}).run(),true);
  for(const values of [{},{customers:[customer()]},{customers:[customer({metadata:{cafe_user_id:'other'}})]}]) {
    await assert.rejects(fixture({row,...values}).run(),{code:'WEBSITE_BILLING_EXISTS'});
  }
});
test('unrelated live account records do not block a fully verified free caller',async()=>{
  const other='10000000-0000-4000-8000-000000000002';
  assert.equal(await fixture({customers:[customer({metadata:{cafe_user_id:other},email:'other@example.invalid'})],
    subscriptions:[subscription({metadata:{cafe_user_id:other},status:'active'})],
    sessions:[session({metadata:{cafe_user_id:other},client_reference_id:other,customer_email:'other@example.invalid'})]}).run(),true);
});
test('all customer pages are read including changed-email orphan records on a later page',async()=>{
  const f=fixture({subscriptions:[subscription({status:'active'})]});let count=0;
  const client={customers:async params=>{count++;if(count===1){assert.equal(params.starting_after,undefined);return {object:'list',data:[customer({id:'cus_other',metadata:{},email:'other@example.invalid'})],has_more:true};}
    assert.equal(params.starting_after,'cus_other');return {object:'list',data:[customer({email:'old@example.invalid'})],has_more:false};},
    subscriptions:async()=>({object:'list',data:[subscription({status:'active'})],has_more:false}),sessions:()=>assert.fail('not reached')};
  await assert.rejects(f.run({createClient:async()=>client}),{code:'WEBSITE_BILLING_EXISTS'});assert.equal(count,2);
});
test('pagination caps, empty has-more pages and repeating object IDs never authorize a charge',async()=>{
  for(const result of [{object:'list',data:[],has_more:true},{object:'list',data:[customer()],has_more:true},
    {object:'list',data:[customer(),customer()],has_more:false}]) {
    await assert.rejects(fixture({client:{customers:async()=>result},maxPages:2}).run(),{code:'PROVIDER_UNAVAILABLE'});
  }
});
test('missing, suspended, unverified or forged Auth email/account and ambiguous local state block before Stripe',async()=>{
  for(const change of [{emailConfirmed:false},{email:undefined},{role:'barista'},{id:'other'},{suspendedAt:'now'}]) {
    const f=fixture();await assert.rejects(f.run({account:{...account,...change}}),{code:'WEBSITE_BILLING_EXISTS'});assert.deepEqual(f.calls,[]);
  }
  for(const row of [null,{},Object.create(local()),{...local(),user_id:'other'},{...local(),status:'active'},
    {...local(),stripe_subscription_id:'sub_orphan'},{...local(),stripe_checkout_attempt_id:'attempt'},
    {...local(),stripe_customer_id:undefined},{...local(),cancel_at_period_end:undefined}]) {
    const f=fixture({row});await assert.rejects(f.run(),{code:'WEBSITE_BILLING_EXISTS'});assert.equal(f.calls.some(x=>x[0]==='client'),false);
  }
});
test('Stripe failure and a late timed-out client never become Free or continue scanning',async()=>{
  await assert.rejects(fixture({client:{customers:async()=>{throw Error('offline');}}}).run(),/offline/);
  let resolve,reads=0;
  const late=new Promise(r=>{resolve=r;});
  const operation=fixture().run({timeoutMs:5,createClient:()=>late});
  await assert.rejects(operation,{code:'PROVIDER_UNAVAILABLE'});
  resolve({customers:()=>{reads++;return {object:'list',data:[],has_more:false};}});
  await new Promise(r=>setImmediate(r));assert.equal(reads,0);
});
const price=()=>({id:'price_fixture',active:true,livemode:true,currency:'usd',unit_amount:999,type:'recurring',
  recurring:{interval:'month',interval_count:1},metadata:{application:'baristamatch',plan:'cafe_monthly',stripe_account_id:'acct_fixture'}});
test('restricted client verifies exact live account-specific price and exposes read methods only',async()=>{
  const calls=[];
  class Stripe {
    constructor(key,options){assert.equal(key,'rk_live_fixture');assert.deepEqual(options,{apiVersion:'2026-08-26.dahlia',timeout:5000,maxNetworkRetries:0});}
    prices={retrieve:async id=>{calls.push(['price',id]);return price();}};
    customers={list:async p=>{calls.push(['customers',p]);}};
    subscriptions={list:async p=>{calls.push(['subscriptions',p]);}};
    checkout={sessions:{list:async p=>{calls.push(['sessions',p]);}}};
  }
  const client=await createAndroidStripeReadClient({restrictedKey:'rk_live_fixture',accountId:'acct_fixture',priceId:'price_fixture'},{loadStripe:async()=>({default:Stripe})});
  assert.deepEqual(Object.keys(client),['customers','subscriptions','sessions']);assert(Object.isFrozen(client));
  await client.customers({limit:100});assert.deepEqual(calls,[['price','price_fixture'],['customers',{limit:100}]]);
});
test('test/full keys or wrong account/price metadata never produce a read client',async()=>{
  const settings={restrictedKey:'rk_live_fixture',accountId:'acct_fixture',priceId:'price_fixture'};
  for(const restrictedKey of ['rk_test_fixture','sk_live_fixture','',undefined])await assert.rejects(createAndroidStripeReadClient({...settings,restrictedKey},{loadStripe:()=>assert.fail('no load')}),{code:'PROVIDER_UNAVAILABLE'});
  for(const change of [{id:'price_other'},{livemode:false},{active:false},{unit_amount:1000},{metadata:{...price().metadata,stripe_account_id:'acct_other'}},
    {recurring:{interval:'year',interval_count:1}}]) {
    class Stripe {prices={retrieve:async()=>({...price(),...change})};}
    await assert.rejects(createAndroidStripeReadClient(settings,{loadStripe:async()=>({default:Stripe})}),{code:'PROVIDER_UNAVAILABLE'});
  }
});
