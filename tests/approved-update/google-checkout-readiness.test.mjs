import test from 'node:test';
import assert from 'node:assert/strict';
import {createCheckoutReadiness} from '../../server/native-billing/checkoutReadiness.mjs';
import {validateGoogleCheckoutCatalog,verifyGoogleCheckoutCatalog} from '../../server/native-billing/googleCheckoutReadiness.mjs';

// Synthetic fixtures exercise the contract. They are never release product IDs.
const googlePlan={productId:'fixture.monthly',basePlanId:'fixture-monthly'};
const config={provider:'google',environment:'Production',packageName:'com.baristajobmatch.app',...googlePlan,credentials:{type:'service_account'}};
const catalog=()=>({packageName:config.packageName,productId:config.productId,basePlans:[{
 basePlanId:config.basePlanId,state:'ACTIVE',autoRenewingBasePlanType:{billingPeriodDuration:'P1M'},
 regionalConfigs:[{regionCode:'US',newSubscriberAvailability:true,price:{currencyCode:'USD',units:'9',nanos:990_000_000}},
 {regionCode:'CA',newSubscriberAvailability:false}],otherRegionsConfig:{newSubscriberAvailability:false},
}]});

test('Google catalog readiness accepts only the configured active monthly US base plan at the approved price',()=>{
 assert.doesNotThrow(()=>validateGoogleCheckoutCatalog(catalog(),config));
 const omitted=catalog();delete omitted.basePlans[0].otherRegionsConfig;assert.doesNotThrow(()=>validateGoogleCheckoutCatalog(omitted,config));
});
test('unexpected Google catalog identity, terms, prices and regional availability block checkout',()=>{
 const mutations=[
  value=>{value.packageName='other.app';},value=>{value.productId='other.product';},value=>{value.archived=true;},
  value=>{value.basePlans=[];},value=>{value.basePlans.push(structuredClone(value.basePlans[0]));},
  value=>{value.basePlans[0].basePlanId='other';},value=>{value.basePlans[0].state='DRAFT';},value=>{value.basePlans[0].state='INACTIVE';},
  value=>{value.basePlans[0].autoRenewingBasePlanType.billingPeriodDuration='P1Y';},
  value=>{value.basePlans[0].prepaidBasePlanType={billingPeriodDuration:'P1M'};},
  value=>{value.basePlans[0].installmentsBasePlanType={committedPaymentsCount:12};},
  value=>{value.basePlans[0].regionalConfigs[0].newSubscriberAvailability=false;},
  value=>{value.basePlans[0].regionalConfigs[0].regionCode='CA';},
  value=>{value.basePlans[0].regionalConfigs.push(structuredClone(value.basePlans[0].regionalConfigs[0]));},
  value=>{value.basePlans[0].regionalConfigs[0].price.currencyCode='CAD';},
  value=>{value.basePlans[0].regionalConfigs[0].price.units='10';},
  value=>{value.basePlans[0].regionalConfigs[0].price.nanos=980_000_000;},
  value=>{value.basePlans[0].regionalConfigs[1].newSubscriberAvailability=true;},
  value=>{value.basePlans[0].regionalConfigs[1].newSubscriberAvailability='true';},
  value=>{value.basePlans[0].regionalConfigs.push(null);},
  value=>{value.basePlans[0].otherRegionsConfig.newSubscriberAvailability=true;},
  value=>{value.basePlans[0].otherRegionsConfig.newSubscriberAvailability='false';},
 ];
 for(const mutate of mutations){const value=catalog();mutate(value);assert.throws(()=>validateGoogleCheckoutCatalog(value,config),{code:'SERVER_CONFIGURATION'});}
 for(const value of [null,{}, {...catalog(),basePlans:null}])assert.throws(()=>validateGoogleCheckoutCatalog(value,config),{code:'SERVER_CONFIGURATION'});
});
function sdk(request) {
 return {GoogleAuth:class {
  constructor(options){assert.deepEqual(options,{credentials:config.credentials,scopes:['https://www.googleapis.com/auth/androidpublisher']});}
  async getClient(){return {request};}
 }};
}
test('Google readiness performs a bounded authenticated catalog GET without mutating the store',async()=>{
 const requests=[];
 await verifyGoogleCheckoutCatalog(config,{loadGoogle:async()=>sdk(async request=>{requests.push(request);return {data:catalog()};})});
 assert.deepEqual(requests,[{url:`https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${config.packageName}/subscriptions/${config.productId}`,method:'GET',timeout:15_000}]);
});
test('Google permission failures, malformed responses and unsupported configured IDs cannot report readiness',async()=>{
 for(const request of [async()=>{throw Error('permission denied');},async()=>({data:{}})])await assert.rejects(verifyGoogleCheckoutCatalog(config,{loadGoogle:async()=>sdk(request)}));
 for(const mutation of [{provider:'apple'},{packageName:'other.app'},{productId:'a'.repeat(41)},{basePlanId:'bad.id'}]){
  await assert.rejects(verifyGoogleCheckoutCatalog({...config,...mutation},{loadGoogle:async()=>{throw Error('SDK must not load');}}),{code:'SERVER_CONFIGURATION'});
 }
});
test('an unresponsive Google authentication or catalog read reaches the readiness deadline',async()=>{
 const never=()=>new Promise(()=>{});
 await assert.rejects(verifyGoogleCheckoutCatalog(config,{loadGoogle:never,timeoutMs:5}),{code:'SERVER_CONFIGURATION'});
 await assert.rejects(verifyGoogleCheckoutCatalog(config,{loadGoogle:async()=>sdk(never),timeoutMs:5}),{code:'SERVER_CONFIGURATION'});
});
test('Apple readiness remains independent of Google configuration and does not perform a Play lookup',async()=>{
 const calls=[],apple={provider:'apple',environment:'Production',productId:'apple.fixture'};
 const ready=createCheckoutReadiness({environment:'Production',productId:apple.productId},{
  readConfiguration:provider=>{calls.push(['config',provider]);return apple;},
  createRuntime:async value=>{calls.push(['runtime',value.provider]);return {};},
  verifyGoogleCatalog:async()=>{throw Error('Google must not be called');},
 });
 await ready('apple');await ready('apple');assert.deepEqual(calls,[['config','apple'],['runtime','apple'],['config','apple']]);
});
test('Google readiness validates its own runtime and reads current catalog terms again at startup',async()=>{
 const calls=[];
 const ready=createCheckoutReadiness({environment:'Production',productId:'apple.fixture',googlePlan},{
  readConfiguration:provider=>{calls.push(['config',provider]);assert.equal(provider,'google');return config;},
  createRuntime:async value=>{calls.push(['runtime',value.provider]);return {};},
  verifyGoogleCatalog:async value=>calls.push(['catalog',value.basePlanId]),
 });
 await ready('google');await ready('google');
 assert.deepEqual(calls,[['config','google'],['runtime','google'],['catalog',googlePlan.basePlanId],['config','google'],['catalog',googlePlan.basePlanId]]);
});
test('mismatched provider configuration fails before creating a verification runtime',async()=>{
 for(const mutation of [{provider:'apple'},{environment:'Sandbox'},{productId:'other'},{basePlanId:'other'}]){
  const ready=createCheckoutReadiness({environment:'Production',productId:'apple.fixture',googlePlan},{
   readConfiguration:()=>({...config,...mutation}),createRuntime:async()=>{throw Error('runtime must not initialize');},
  });
  await assert.rejects(ready('google'),{code:'SERVER_CONFIGURATION'});
 }
});
test('failed verification-runtime initialization is retried and failed catalog checks never become cached successes',async()=>{
 let attempts=0,catalogReads=0;
 const ready=createCheckoutReadiness({environment:'Production',productId:'apple.fixture',googlePlan},{
  readConfiguration:()=>config,createRuntime:async()=>{attempts++;if(attempts===1)throw Error('SDK unavailable');return {};},
  verifyGoogleCatalog:async()=>{catalogReads++;if(catalogReads===1)throw Error('permission denied');},
 });
 await assert.rejects(ready('google'),/SDK unavailable/);await assert.rejects(ready('google'),/permission denied/);await ready('google');
 assert.equal(attempts,2);assert.equal(catalogReads,2);
});
