import test from 'node:test';
import assert from 'node:assert/strict';
import {loadTypescript,plain} from './load-typescript.mjs';
import {nativeCheckoutService} from '../../server/native-billing/checkoutService.mjs';
const {nativePurchaseDependencies,checkedSubscription}=loadTypescript('mobile/features/native-subscription/nativeBillingClient.ts');
const {PurchaseCoordinator}=loadTypescript('mobile/features/native-subscription/purchaseCoordinator.ts');
const {ExpoStoreGateway}=loadTypescript('mobile/features/native-subscription/expoStoreGateway.ts',{'./storeTimeout':loadTypescript('mobile/features/native-subscription/storeTimeout.ts')});
const account={id:'cafe-a',role:'cafe_owner_manager'},id='10000000-0000-4000-8000-000000000001',binding='20000000-0000-4000-8000-000000000001';
const product={id:'actual.monthly',provider:'apple',displayPrice:'$9.99',currency:'USD',period:'month'};
const purchase={id:'tx',productId:product.id,provider:'apple',proof:'synthetic-proof'};
const pending={accountId:account.id,verified:true,provider:null,access:'free',status:'pending',canManage:false,canPurchase:false,canResumeAppleCheckout:true,autoRenews:false,currentPeriodEnd:null};
const paid={...pending,provider:'apple',access:'pro',status:'active',canManage:true,canResumeAppleCheckout:false};
const flush=async()=>{for(let i=0;i<30;i++)await Promise.resolve();};
function harness({restore=[],result={kind:'purchased',purchase},status=pending,restoredStatus=paid,transport,readAccount}={}) {
 const calls=[];let confirmed=false;
 const call=async(path,body,method,accountId)=>{
  calls.push([path,body,method,accountId]);
  if(transport){const value=await transport(path,body);if(value!==undefined)return value;}
  if(path.endsWith('status'))return confirmed?restoredStatus:status;
  if(path.endsWith('resume'))return {attemptId:id,accountBinding:binding};
  if(path==='/native-purchases'){confirmed=true;return {accountId:account.id,verified:true,purchase:{provider:'apple',status:'active'}};}
  throw Error('No prepare/start/cancel route may be called during recovery');
 };
 const store={country:async()=> 'USA',buy:async()=>{throw Error('Must reuse Apple checkout');},resume:async(...args)=>{calls.push(['store-resume',...args]);return result;},restore:async()=>{calls.push(['restore']);return typeof restore==='function'?restore():restore;},finish:async()=>calls.push(['finish'])};
 const deps=nativePurchaseDependencies({account:readAccount||(async()=>account),call,store});return {deps,calls,store,coordinator:new PurchaseCoordinator(deps)};
}
test('recovery restores first and verifies a fresh purchase using the original account binding without a new reservation',async()=>{
 const h=harness(),result=await h.coordinator.resume(product);assert.equal(result.kind,'verified');assert.equal(result.subscription.access,'pro');
 assert.deepEqual(h.calls.map(x=>x[0]),['restore','/native-billing?action=status','/native-billing?action=resume','store-resume','/native-purchases','/native-billing?action=status','finish']);
 assert.equal(h.calls.find(x=>x[0]==='store-resume')[2],binding);
 for(const row of h.calls.filter(row=>row[0].startsWith('/')))assert.equal(row[3],account.id);
});
test('an existing purchase is verified and restored instead of reopening checkout',async()=>{
 const h=harness({restore:[purchase]});const result=await h.coordinator.resume(product);
 assert.equal(result.subscription.access,'pro');assert.ok(h.calls.some(x=>x[0]==='finish'));assert.ok(!h.calls.some(x=>x[0]==='store-resume'));
});
test('canceling a resumed sheet or receiving pending keeps the original reservation protected',async()=>{
 for(const kind of ['cancelled','pending']){const h=harness({result:{kind}});assert.equal((await h.coordinator.resume(product)).kind,'pending');assert.ok(!h.calls.some(x=>/prepare|start|cancel/.test(x[0])));}
});
test('lost recovery authorization never opens the store or cancels the original checkout',async()=>{
 const h=harness({transport:async path=>{if(path.endsWith('resume'))throw Error('offline');}});
 assert.equal((await h.coordinator.resume(product)).kind,'failed');assert.ok(!h.calls.some(x=>x[0]==='store-resume'));
});
test('active Stripe access, billing retry and absent recovery permission block store recovery',async()=>{
 for(const status of [{...paid,provider:'stripe'},{...pending,status:'payment_required'},{...pending,canResumeAppleCheckout:false}]){
 const h=harness({status});assert.equal((await h.coordinator.resume(product)).kind,'blocked');assert.ok(!h.calls.some(x=>x[0]==='store-resume'));
 }
});
test('an empty restore alone does not resume or release a checkout',async()=>{
 const h=harness();const result=await h.coordinator.restore();assert.equal(result.subscription.status,'pending');assert.ok(!h.calls.some(x=>/resume|cancel|prepare/.test(x[0])));
});
test('repeat recovery taps share the controller lock and open at most one sheet',async()=>{
 let release;const h=harness({restore:()=>new Promise(resolve=>{release=resolve;})});
 const first=h.coordinator.resume(product);await flush();assert.equal((await h.coordinator.resume(product)).kind,'busy');release([]);await first;
 assert.equal(h.calls.filter(x=>x[0]==='store-resume').length,1);
});
test('account switching after restoration prevents recovery for the old café',async()=>{
 let switched=false;const h=harness({restore:()=>{switched=true;return [];},readAccount:async()=>switched?{id:'other',role:'cafe_owner_manager'}:account});
 assert.equal((await h.coordinator.resume(product)).kind,'failed');assert.ok(!h.calls.some(x=>x[0]==='store-resume'));
});
test('baristas and Google purchases cannot use Apple recovery',async()=>{
 const h=harness({readAccount:async()=>({id:'b',role:'barista'})});assert.equal((await h.coordinator.resume(product)).kind,'account_changed');assert.equal(h.calls.length,0);
 const other=harness();assert.equal((await other.coordinator.resume({...product,provider:'google'})).kind,'failed');assert.equal(other.calls.length,0);
});
test('an unverified restored purchase blocks retry and is never finished',async()=>{
 const h=harness({restore:[purchase],transport:async path=>{if(path==='/native-purchases')throw Error('verification unavailable');}});
 assert.equal((await h.coordinator.resume(product)).kind,'verification_pending');assert.ok(!h.calls.some(x=>['store-resume','finish'].includes(x[0])));
});
test('malformed recovery permissions cannot reach the UI',()=>{assert.throws(()=>checkedSubscription({...pending,canResumeAppleCheckout:'yes'},account.id));});

function server({attempt={attemptId:id,accountBinding:binding},inspect=async()=>true,enabled=true}={}){
 const calls=[],repository={recoverAppleCheckout:async(...args)=>{calls.push(['recover',...args]);return attempt;}};
 const service=nativeCheckoutService({repository,environment:'Sandbox',productId:product.id,enabled,ready:async()=>calls.push(['ready']),inspectWebsiteBilling:inspect});
 return {service,calls};
}
const request={provider:'apple',productId:product.id,storefront:'USA'};
test('server recovery only reads the original reservation and rechecks existing website billing',async()=>{
 const h=server();assert.deepEqual(await h.service.resume(account,request,{plan:'free',billingPaused:false}),{attemptId:id,accountBinding:binding});assert.deepEqual(h.calls,[['ready'],['recover',account.id,'Sandbox']]);
});
test('server recovery rejects invalid role, storefront, product, disabled billing and missing reservations',async()=>{
 for(const [a,r] of [[{...account,role:'barista'},request],[{...account,suspendedAt:'now'},request],[account,{...request,provider:'google'}],[account,{...request,storefront:'GBR'}],[account,{...request,productId:'other'}]])await assert.rejects(server().service.resume(a,r,{plan:'free',billingPaused:false}));
 await assert.rejects(server({enabled:false}).service.resume(account,request,{plan:'free',billingPaused:false}));await assert.rejects(server({attempt:null}).service.resume(account,request,{plan:'free',billingPaused:false}));
});
test('server errors and existing web subscriptions never release the native reservation',async()=>{
 for(const inspect of [async()=>false,async()=>{throw Error('provider unavailable');}])await assert.rejects(server({inspect}).service.resume(account,request,{plan:'free',billingPaused:false}));
});

function storeHarness({never=false}={}) {
 let update,error,rejectRequest,calls=0;
 const plan={id:product.id,provider:'apple',storefront:'US',prices:{USD:9.99}};
 const p={id:product.id,platform:'ios',type:'subs',currency:'USD',price:9.99,displayPrice:'$9.99',subscriptionPeriodNumberIOS:'1',subscriptionPeriodUnitIOS:'month'};
 const api={initConnection:async()=>true,endConnection:async()=>{},getStorefront:async()=> 'USA',fetchProducts:async()=>[p],purchaseUpdatedListener:fn=>{update=fn;return{remove(){}};},purchaseErrorListener:fn=>{error=fn;return{remove(){}};},getAvailablePurchases:async()=>[],restorePurchases:async()=>{},requestPurchase:async()=>{calls++;if(calls===1){if(never)return new Promise((_,reject)=>{rejectRequest=reject;});throw Object.assign(Error('Store rejected'),{code:'unknown',productId:product.id});}return {id:'tx',productId:product.id,store:'apple',purchaseState:'purchased',purchaseToken:'synthetic-proof',appAccountToken:binding.toUpperCase()};}};
 const recovered=[],gateway=new ExpoStoreGateway(api,plan,p=>recovered.push(p),10,10);
 return {gateway,calls:()=>calls,reject:()=>rejectRequest(Object.assign(Error('late rejection'),{code:'unknown'})),recovered};
}
test('captured Apple unknown error remains pending until explicit recovery reuses the same product and binding',async()=>{
 const h=storeHarness();const p=await h.gateway.product();assert.equal((await h.gateway.buy(p,binding)).kind,'pending');await flush();
 assert.equal((await h.gateway.buy(p,binding)).kind,'pending');assert.equal(h.calls(),1);
 await h.gateway.restore();await flush();assert.equal((await h.gateway.resume(p,binding)).kind,'purchased');assert.equal(h.calls(),2);await h.gateway.dispose();
});
test('a UI timeout cannot open another checkout while the original native request is still running',async()=>{
 const h=storeHarness({never:true});const p=await h.gateway.product();assert.equal((await h.gateway.buy(p,binding)).kind,'pending');
 await h.gateway.restore();assert.equal((await h.gateway.resume(p,binding)).kind,'pending');assert.equal(h.calls(),1);
 h.reject();await flush();assert.equal((await h.gateway.resume(p,binding)).kind,'purchased');await h.gateway.dispose();
});
test('billing pause or a website Pro plan denies recovery even with a retained Apple reservation',async()=>{
 for(const website of [undefined,{plan:'free',billingPaused:true},{plan:'pro',billingPaused:false}]){
 const h=server();await assert.rejects(h.service.resume(account,request,website));assert.ok(!h.calls.some(x=>x[0]==='recover'));
 }
});
test('recreating the screen cannot resume while its earlier native request is still open',async()=>{
 const original=storeHarness({never:true});const p=await original.gateway.product();await original.gateway.buy(p,binding);await original.gateway.dispose();
 const reopened=storeHarness();await reopened.gateway.product();assert.equal((await reopened.gateway.resume(p,binding)).kind,'pending');assert.equal(reopened.calls(),0);
 original.reject();await flush();assert.equal((await reopened.gateway.resume(p,binding)).kind,'pending');assert.equal(reopened.calls(),1);
 await reopened.gateway.dispose();
});
