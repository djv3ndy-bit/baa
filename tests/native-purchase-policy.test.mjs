import test from 'node:test';
import assert from 'node:assert/strict';
import { nativePurchasePolicy, nativePurchasePolicyFromEnvironment } from '../server/native-billing/purchasePolicy.mjs';
import { nativeCheckoutService } from '../server/native-billing/checkoutService.mjs';
import { checkoutHandler } from '../server/native-billing/checkoutHandler.mjs';
import { APPLE_STORE_GUARD } from '../server/native-billing/billingContext.mjs';

const production={environment:'Production',appleSandboxTester:false};
const sandbox={environment:'Sandbox',appleSandboxTester:false};
const mapped={environment:'Sandbox',appleSandboxTester:true};
const policy=(overrides={})=>nativePurchasePolicy({environment:'Production',billingEnabled:true,nativePurchasesEnabled:false,appleSandboxPurchasesEnabled:false,...overrides});
const account={id:'synthetic-policy-cafe',role:'cafe_owner_manager'};
const attemptId='10000000-0000-4000-8000-000000000001',binding='20000000-0000-4000-8000-000000000001';
const request={provider:'apple',productId:'synthetic.monthly',storefront:'USA'};
const website={plan:'free',connectedToBilling:false,canManageBilling:false,billingPaused:false};

test('the override defaults OFF and only literal server true enables it',()=>{
  const base={NATIVE_BILLING_ENVIRONMENT:'Production',BILLING_ENABLED:'true',NATIVE_PURCHASES_ENABLED:'false'};
  for(const value of [undefined,'','false','TRUE',' true','true ',true,1])assert.equal(nativePurchasePolicyFromEnvironment({...base,APPLE_SANDBOX_PURCHASES_ENABLED:value})(mapped,'apple'),false);
  assert.equal(nativePurchasePolicyFromEnvironment({...base,APPLE_SANDBOX_PURCHASES_ENABLED:'true'})(mapped,'apple'),true);
});
test('override permits only trusted mapped Apple Sandbox in global Production',()=>{
  const allow=policy({appleSandboxPurchasesEnabled:true});
  assert.equal(allow(mapped,'apple'),true);
  for(const context of [production,sandbox,undefined,null,{},[],{environment:'Production',appleSandboxTester:true},{environment:'Sandbox',appleSandboxTester:'true'},{environment:'Unknown',appleSandboxTester:true}])assert.equal(allow(context,'apple'),false);
  for(const provider of ['google','stripe','unknown',undefined,null])assert.equal(allow(mapped,provider),false);
  for(const environment of ['Sandbox','unknown',undefined])assert.equal(policy({environment,appleSandboxPurchasesEnabled:true})(mapped,'apple'),false);
});
test('master billing pause denies every native/override combination',()=>{
  for(const billingEnabled of [false,undefined,'true'])for(const nativePurchasesEnabled of [false,true])for(const appleSandboxPurchasesEnabled of [false,true]){
    const allow=policy({billingEnabled,nativePurchasesEnabled,appleSandboxPurchasesEnabled});
    for(const context of [production,sandbox,mapped])assert.equal(allow(context,'apple'),false);
  }
});
test('legacy enabled cases preserve Production, isolated Sandbox and mapped Sandbox',()=>{
  for(const [environment,context] of [['Production',production],['Sandbox',sandbox],['Production',mapped]]){
    assert.equal(policy({environment,nativePurchasesEnabled:true})(context,'apple'),true);
  }
  assert.equal(policy({nativePurchasesEnabled:true})(production,'google'),true);
  assert.equal(policy({environment:'Sandbox',nativePurchasesEnabled:true})(sandbox,'google'),true);
  assert.equal(policy({nativePurchasesEnabled:true})(mapped,'google'),false);
});

function harness({context=mapped,flags={},attempt,pending=false,nativeRows=[],inspect=async()=>true,ready,contextReader,withAttemptContext=true}={}){
  const calls=[],resolutions=[];
  let current=context;
  const repo={
    settleVerifiedCheckout:async(...args)=>{calls.push(['settle',...args]);return true;},
    summary:async(id,environment)=>({accountId:id,environment,ownerPaused:false,subscriptions:nativeRows}),
    checkoutPending:async()=>pending,
    claimCheckout:async(...args)=>{calls.push(['claim',...args]);return {attemptId,accountBinding:binding};},
    recoverAppleCheckout:async(...args)=>{calls.push(['recover',...args]);return {attemptId,accountBinding:binding};},
    startCheckout:async(...args)=>{calls.push(['start',...args]);return true;},
    cancelCheckout:async(...args)=>{calls.push(['cancel',...args]);return true;},
    ...(withAttemptContext?{attemptContext:async(...args)=>{calls.push(['attempt-context',...args]);return attempt===undefined?{environment:context?.environment??'Sandbox',provider:'apple',guardProtocol:APPLE_STORE_GUARD}:attempt;}}:{}),
  };
  const allow=policy({appleSandboxPurchasesEnabled:true,...flags});
  const service=nativeCheckoutService({repository:repo,environment:flags.environment??'Production',enabled:false,purchaseAllowed:allow,
    contextFor:async(id,provider)=>{resolutions.push([id,provider]);return contextReader?contextReader():current;},productId:request.productId,createId:()=>attemptId,
    ready:async c=>{calls.push(['ready',c.environment]);if(ready)await ready(c);},inspectWebsiteBilling:async id=>{calls.push(['inspect',id]);return inspect(id);}});
  return {service,calls,resolutions,repo,setContext:c=>{current=c;}};
}
const noAdmission=h=>assert.deepEqual(h.calls.filter(x=>['claim','recover','start','ready'].includes(x[0])),[]);
async function deniedEverywhere(h){
  try{const status=await h.service.status(account,website);assert.equal(status.canPurchase,false);assert.equal(status.canResumeAppleCheckout,false);}catch(error){assert.equal(error.code,'SERVER_CONFIGURATION');}
  await assert.rejects(h.service.prepare(account,request,APPLE_STORE_GUARD));
  await assert.rejects(h.service.resume(account,request,website,APPLE_STORE_GUARD));
  await assert.rejects(h.service.start(account,attemptId,APPLE_STORE_GUARD));noAdmission(h);
}

test('all four entry points admit the explicit mapped override through the same owned context',async()=>{
  const h=harness();assert.equal((await h.service.status(account,website)).canPurchase,true);
  const prepared=await h.service.prepare(account,request,APPLE_STORE_GUARD);assert.equal(prepared.storeEnvironment,'Sandbox');assert.equal(prepared.appleSandboxTester,true);
  assert.equal((await h.service.resume(account,request,website,APPLE_STORE_GUARD)).storeEnvironment,'Sandbox');
  assert.equal((await h.service.start(account,attemptId,APPLE_STORE_GUARD)).started,true);
  assert.equal(h.calls.filter(x=>x[0]==='claim').length,1);assert.equal(h.calls.filter(x=>x[0]==='recover').length,1);assert.equal(h.calls.filter(x=>x[0]==='start').length,1);
  assert(h.resolutions.every(([id,provider])=>id===account.id&&provider==='apple'));
  assert(h.calls.filter(x=>['claim','recover','start'].includes(x[0])).every(x=>x[1]===account.id));
});
for(const [label,options] of [['override OFF',{flags:{appleSandboxPurchasesEnabled:false}}],['ordinary Production',{context:production}],['unmapped Sandbox',{context:sandbox}],['expired map',{context:production}],['revoked map',{context:production}],['master paused',{flags:{billingEnabled:false,nativePurchasesEnabled:true}}],['missing resolver context',{context:null}]]){
  test(label+' denies status admission, prepare, resume and start',()=>deniedEverywhere(harness(options)));
}
test('legacy enabled paths still agree across status/prepare/resume/start',async()=>{
  for(const [environment,context] of [['Production',production],['Sandbox',sandbox],['Production',mapped]]){
    const h=harness({context,flags:{environment,nativePurchasesEnabled:true,appleSandboxPurchasesEnabled:false}});
    assert.equal((await h.service.status(account,website)).canPurchase,true);
    await h.service.prepare(account,request,APPLE_STORE_GUARD);await h.service.resume(account,request,website,APPLE_STORE_GUARD);await h.service.start(account,attemptId,APPLE_STORE_GUARD);
    assert.equal(h.calls.filter(x=>x[0]==='start').length,1);
  }
});
test('pending recovery is controlled by the same switch without releasing the existing reservation',async()=>{
  const off=harness({pending:true,flags:{appleSandboxPurchasesEnabled:false}});assert.equal((await off.service.status(account,website)).canResumeAppleCheckout,false);assert(!off.calls.some(x=>x[0]==='recover'));
  const on=harness({pending:true});assert.equal((await on.service.status(account,website)).canResumeAppleCheckout,true);assert.equal(on.calls.filter(x=>x[0]==='recover').length,1);assert(!on.calls.some(x=>x[0]==='cancel'));
});
test('Google prepare/resume cannot borrow mapped Apple authority',async()=>{
  const h=harness();await assert.rejects(h.service.prepare(account,{...request,provider:'google'},APPLE_STORE_GUARD));await assert.rejects(h.service.resume(account,{...request,provider:'google'},website,APPLE_STORE_GUARD));noAdmission(h);
});
for(const [label,attempt,withAttemptContext] of [['missing attempt',null,true],['Google attempt',{environment:'Sandbox',provider:'google',guardProtocol:APPLE_STORE_GUARD},true],['wrong environment',{environment:'Production',provider:'apple',guardProtocol:APPLE_STORE_GUARD},true],['missing protocol',{environment:'Sandbox',provider:'apple'},true],['missing durable reader',undefined,false]]){
  test('start rejects '+label+' before readiness or SQL start',async()=>{const h=harness({attempt,withAttemptContext});await assert.rejects(h.service.start(account,attemptId,APPLE_STORE_GUARD));noAdmission(h);});
}
test('the override does not bypass the installed store guard',async()=>{
  for(const method of ['prepare','resume','start']){
    const h=harness();const args=method==='prepare'?[account,request]:method==='resume'?[account,request,website]:[account,attemptId];await assert.rejects(h.service[method](...args),error=>error.code==='STORE_GUARD_REQUIRED');noAdmission(h);
  }
});
test('context expiry after reservation preserves unused-reservation cleanup and never succeeds',async()=>{
  let reads=0;const h=harness({contextReader:()=>++reads===1?mapped:production});await assert.rejects(h.service.prepare(account,request,APPLE_STORE_GUARD),error=>error.code==='CHECKOUT_BLOCKED');assert.equal(h.calls.filter(x=>x[0]==='claim').length,1);assert.equal(h.calls.filter(x=>x[0]==='cancel').length,1);assert(!h.calls.some(x=>x[0]==='start'));
});
test('verification readiness failure cannot allocate a binding/reservation',async()=>{const h=harness({ready:async()=>{throw Error('synthetic unavailable');}});await assert.rejects(h.service.prepare(account,request,APPLE_STORE_GUARD));assert(!h.calls.some(x=>['claim','recover','start'].includes(x[0])));});
test('website coordination still cancels only the unused reservation on a conflicting subscription',async()=>{const h=harness({inspect:async()=>false});await assert.rejects(h.service.prepare(account,request,APPLE_STORE_GUARD),error=>error.code==='WEBSITE_BILLING_EXISTS');assert(h.calls.some(x=>x[0]==='cancel'&&x.at(-1)===true));});

test('HTTP body/query/metadata spoofing cannot turn an ordinary account into a Sandbox tester',async()=>{
  const h=harness({context:production});const res={code:0,setHeader(){},status(c){this.code=c;return this;},json(v){this.body=v;return this;}};
  const handler=checkoutHandler({authenticateCafe:async()=>({id:account.id,profile:{role:account.role},user_metadata:{appleSandboxTester:true}}),serviceFor:()=>h.service,websiteStatus:async()=>website});
  await handler({method:'POST',headers:{'x-bjm-store-guard':APPLE_STORE_GUARD},query:{action:'prepare',appleSandboxTester:true},body:{...request,accountId:'other',storeEnvironment:'Sandbox',appleSandboxTester:true,user_metadata:{appleSandboxTester:true}}},res);
  assert.notEqual(res.code,200);noAdmission(h);assert(h.resolutions.every(([id])=>id===account.id));
});
test('turning off new purchase admission preserves verified access, management and recorded cancellation',async()=>{
  const h=harness({flags:{billingEnabled:false},nativeRows:[{provider:'apple',status:'active',currentPeriodEnd:'2099-01-01T00:00:00Z',gracePeriodEnd:null,autoRenews:true}]});
  const status=await h.service.status(account,website);assert.equal(status.access,'pro');assert.equal(status.canManage,true);assert.equal(status.canPurchase,false);
  await h.service.cancel(account,attemptId,'user-cancelled');assert(h.calls.some(x=>x[0]==='cancel'));assert(h.calls.some(x=>x[0]==='settle'));
});
