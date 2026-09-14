import test from 'node:test';
import assert from 'node:assert/strict';
import {loadTypescript} from './load-typescript.mjs';
const {nativePurchaseDependencies,checkedSubscription}=loadTypescript('mobile/features/native-subscription/nativeBillingClient.ts');
const {PurchaseCoordinator}=loadTypescript('mobile/features/native-subscription/purchaseCoordinator.ts');
const account={id:'cafe-a',role:'cafe_owner_manager'},id='10000000-0000-4000-8000-000000000001',binding='20000000-0000-4000-8000-000000000001';
const product={id:'actual.monthly',provider:'apple',displayPrice:'$9.99',currency:'USD',period:'month'},purchase={id:'tx',productId:product.id,provider:'apple',proof:'synthetic-proof'};
const free={accountId:account.id,verified:true,provider:null,access:'free',status:'free',canManage:false,canPurchase:true,autoRenews:false,currentPeriodEnd:null};
const paid={...free,provider:'apple',access:'pro',status:'active',canManage:true,canPurchase:false,autoRenews:true};
function harness({result={kind:'purchased',purchase},status=paid,verification='active',transport,readAccount}={}){
 const calls=[];let verified=false;
 const call=async(path,body,method,accountId)=>{
 calls.push([path,body,method,accountId]);if(transport){const value=await transport(path,body);if(value!==undefined)return value;}
 if(path.endsWith('status'))return verified?status:free;
 if(path.endsWith('prepare'))return {attemptId:id,accountBinding:binding};
 if(path.endsWith('start'))return {started:true};
 if(path.endsWith('cancel'))return {cancelled:true};
 if(path==='/native-purchases'){verified=true;return {accountId:account.id,verified:true,purchase:{provider:'apple',status:verification}};}
 throw Error('Unexpected route');
 };
 const store={country:async()=> 'USA',buy:async()=>{calls.push(['store-buy']);return result;},restore:async()=>[purchase],finish:async()=>calls.push(['finish'])};
 const deps=nativePurchaseDependencies({account:readAccount||(async()=>account),call,store});return {deps,calls,coordinator:new PurchaseCoordinator(deps)};
}
test('native buy follows real account-bound prepare/start/verify/status/finish routes in order',async()=>{
 const h=harness();const result=await h.coordinator.buy(product);assert.equal(result.kind,'verified');assert.equal(result.subscription.access,'pro');
 assert.deepEqual(h.calls.map(row=>row[0]),['/native-billing?action=status','/native-billing?action=prepare','/native-billing?action=start','store-buy','/native-purchases','/native-billing?action=status','finish']);
 for(const row of h.calls.filter(row=>row[0].startsWith('/')))assert.equal(row[3],account.id);
});
test('only an explicit SDK user cancellation releases the server reservation',async()=>{
 const h=harness({result:{kind:'cancelled'}});assert.equal((await h.coordinator.buy(product)).kind,'cancelled');
 const cancellation=h.calls.find(row=>row[0].endsWith('cancel'));assert.equal(cancellation[1].reason,'user-cancelled');assert.equal(cancellation[1].attemptId,id);
 const pending=harness({result:{kind:'pending'}});assert.equal((await pending.coordinator.buy(product)).kind,'pending');assert.equal(pending.calls.some(row=>row[0].endsWith('cancel')),false);
});
test('lost launch response never opens native checkout or sends a guessed cancellation',async()=>{
 const h=harness({transport:async path=>{if(path.endsWith('start'))throw Error('offline');}});
 assert.equal((await h.coordinator.buy(product)).kind,'pending');assert.equal(h.calls.some(row=>row[0]==='store-buy'),false);assert.equal(h.calls.some(row=>row[0].endsWith('cancel')),false);
});
test('failed cancellation synchronization remains pending without a false success result',async()=>{
 const h=harness({result:{kind:'cancelled'},transport:async path=>{if(path.endsWith('cancel'))throw Error('offline');}});
 assert.equal((await h.coordinator.buy(product)).kind,'pending');
});
test('restored expired native proof retains another provider’s verified paid access',async()=>{
 const h=harness({verification:'expired',status:{...paid,provider:'stripe'}});
 const result=await h.coordinator.restore();assert.equal(result.kind,'verified');assert.equal(result.subscription.access,'pro');assert.equal(result.subscription.provider,'stripe');
 assert.equal(h.calls.some(row=>row[0]==='store-buy'),false);assert.equal(h.calls.filter(row=>row[0]==='finish').length,1);assert.equal(h.calls.at(-1)[0],'/native-billing?action=status');
});
test('a pending native proof is not finished merely because another provider grants pro',async()=>{
 for(const verification of ['pending','payment_required']){
 const h=harness({verification,status:{...paid,provider:'stripe'}});assert.equal((await h.coordinator.restore()).kind,'verification_pending');assert.equal(h.calls.some(row=>row[0]==='finish'),false);
 }
});
test('account changes, mismatched confirmations and malformed status never finish a receipt',async()=>{
 const h=harness({transport:async path=>{if(path==='/native-purchases')return {accountId:'other',verified:true,purchase:{provider:'apple',status:'active'}};}});
 assert.equal((await h.coordinator.restore()).kind,'verification_pending');assert.equal(h.calls.some(row=>row[0]==='finish'),false);
 for(const value of [null,{...free,accountId:'other'},{...free,verified:false},{...free,canPurchase:'yes'},{...free,currentPeriodEnd:'bad'}])assert.throws(()=>checkedSubscription(value,account.id));
});
test('barista accounts cannot contact the payment routes',async()=>{
 const h=harness({readAccount:async()=>({id:'barista-a',role:'barista'})});assert.equal((await h.coordinator.buy(product)).kind,'account_changed');assert.equal(h.calls.length,0);
});
