import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import {readProviderConfiguration,readContextConfiguration,readAppleEventConfiguration,createProviderRuntime,providerRuntimeCache} from '../../server/native-billing/runtime.mjs';
import {configuredBillingContext,sandboxReconciliationAuthorizer,APPLE_STORE_GUARD} from '../../server/native-billing/billingContext.mjs';
import {verificationHandler} from '../../server/native-billing/verificationHandler.mjs';
import {createReconciler} from '../../server/native-billing/reconcile.mjs';
import {appleProvider} from '../../server/native-billing/providers.mjs';
import {checkoutHandler} from '../../server/native-billing/checkoutHandler.mjs';
import {nativeCheckoutService} from '../../server/native-billing/checkoutService.mjs';
import {nativeBillingRepository} from '../../server/native-billing/repository.mjs';
import {verifiedAppleEvent} from '../../server/native-billing/appleEventRouter.mjs';
import {loadTypescript} from './load-typescript.mjs';

const production={environment:'Production',appleSandboxTester:false};
const sandbox={environment:'Sandbox',appleSandboxTester:true};
test('owner-paused status never offers Apple recovery or launches a new purchase, while unpause preserves the pending financial state',async()=>{
  let paused=true,recoveries=0,preflights=0;
  const service=nativeCheckoutService({environment:'Production',enabled:true,productId:'test.monthly',contextFor:async()=>production,
    repository:{settleVerifiedCheckout:async()=>true,summary:async()=>({accountId:'reviewer',environment:'Production',ownerPaused:paused,subscriptions:[]}),
      checkoutPending:async()=>true,recoverAppleCheckout:async()=>{recoveries++;return {attemptId:'attempt'};}},ready:async()=>{}});
  const account={id:'reviewer',role:'cafe_owner_manager'};
  const website={plan:'free',connectedToBilling:false,canManageBilling:false,billingPaused:false};
  const status=await service.status(account,website);
  assert.equal(status.access,'free');assert.equal(status.accessPaused,true);assert.equal(status.canPurchase,false);assert.equal(status.canResumeAppleCheckout,false);assert.equal(recoveries,0);
  const {PurchaseCoordinator}=loadTypescript('mobile/features/native-subscription/purchaseCoordinator.ts');
  const coordinator=new PurchaseCoordinator({account:async()=>account,status:async()=>status,preflight:async()=>{preflights++;throw Error('must not launch');}});
  assert.equal((await coordinator.buy({provider:'apple',id:'test.monthly'})).kind,'blocked');assert.equal(preflights,0);
  paused=false;const restored=await service.status(account,website);
  assert.equal(restored.accessPaused,false);assert.equal(restored.status,'pending');assert.equal(restored.canResumeAppleCheckout,true);assert.equal(recoveries,1);
});
const {privateKey}=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
const env={NATIVE_BILLING_ENVIRONMENT:'Production',VERCEL_ENV:'production',APPLE_IAP_PRODUCT_ID:'test.monthly',
  APPLE_IAP_KEY_ID:'TESTKEY123',APPLE_IAP_ISSUER_ID:'00000000-0000-4000-8000-000000000001',
  APPLE_IAP_PRIVATE_KEY:privateKey.export({type:'pkcs8',format:'pem'})};
test('host pin stays strict; only trusted Apple mapped context can select Sandbox on Production',()=>{
  assert.throws(()=>readProviderConfiguration('apple',{...env,NATIVE_BILLING_ENVIRONMENT:'Sandbox'}));
  assert.equal(readContextConfiguration('apple',sandbox,env).environment,'Sandbox');
  assert.equal(readContextConfiguration('apple',production,env).environment,'Production');
  assert.throws(()=>readContextConfiguration('apple',{environment:'Sandbox',appleSandboxTester:false},env));
  assert.throws(()=>configuredBillingContext({environment:'Sandbox',appleSandboxTester:false},'Production'));
  assert.throws(()=>configuredBillingContext(sandbox,'Production','google'));
  assert.deepEqual(configuredBillingContext({environment:'Sandbox',appleSandboxTester:false},'Sandbox'),{environment:'Sandbox',appleSandboxTester:false});
});
test('verification-only event runtimes preserve preview isolation and reject arbitrary environments',()=>{
  assert.equal(readAppleEventConfiguration('Sandbox',env).environment,'Sandbox');
  assert.equal(readAppleEventConfiguration('Production',env).environment,'Production');
  const qa={...env,NATIVE_BILLING_ENVIRONMENT:'Sandbox',VERCEL_ENV:'preview'};
  assert.throws(()=>readAppleEventConfiguration('Production',qa));
  for(const value of ['Xcode','sandbox',null,{},''])assert.throws(()=>readAppleEventConfiguration(value,env));
});
test('fallback recognizes only the pinned official SDK environment exception, not a status-shaped spoof',async()=>{
  const {VerificationException,VerificationStatus}=await import('@apple/app-store-server-library');
  const runtime=await createProviderRuntime(readContextConfiguration('apple',production,env));
  assert.equal(runtime.isEnvironmentMismatch(new VerificationException(VerificationStatus.INVALID_ENVIRONMENT)),true);
  assert.equal(runtime.isEnvironmentMismatch(new VerificationException(VerificationStatus.INVALID_CERTIFICATE)),false);
  assert.equal(runtime.isEnvironmentMismatch({status:VerificationStatus.INVALID_ENVIRONMENT}),false);
  assert.equal(runtime.isEnvironmentMismatch(Object.assign(Error('forged'),{status:VerificationStatus.INVALID_ENVIRONMENT})),false);
  assert.equal(runtime.mayVerifySandbox(new VerificationException(VerificationStatus.INVALID_APP_IDENTIFIER)),true);
  assert.equal(runtime.mayVerifySandbox({status:VerificationStatus.INVALID_APP_IDENTIFIER}),false);
});
test('official metadata validation reproduces optional Sandbox appAppleId asymmetry; routing still verifies the entire second payload',async()=>{
  const {SignedDataVerifier,Environment,VerificationStatus}=await import('@apple/app-store-server-library');
  const productionRuntime=await createProviderRuntime(readContextConfiguration('apple',production,env));
  const sandboxRuntime=await createProviderRuntime(readContextConfiguration('apple',sandbox,env));
  const productionVerifier=new SignedDataVerifier([],false,Environment.PRODUCTION,'com.baristajobmatch.app',6807117736);
  const sandboxVerifier=new SignedDataVerifier([],false,Environment.SANDBOX,'com.baristajobmatch.app',6807117736);
  let mismatch;
  try {productionVerifier.verifyNotification('com.baristajobmatch.app',undefined,Environment.SANDBOX);}catch(error){mismatch=error;}
  assert.equal(mismatch.status,VerificationStatus.INVALID_APP_IDENTIFIER);assert.equal(productionRuntime.mayVerifySandbox(mismatch),true);
  assert.doesNotThrow(()=>sandboxVerifier.verifyNotification('com.baristajobmatch.app',undefined,Environment.SANDBOX));
  assert.throws(()=>sandboxVerifier.verifyNotification('wrong.bundle',undefined,Environment.SANDBOX));
  assert.throws(()=>sandboxVerifier.verifyNotification('com.baristajobmatch.app',undefined,Environment.PRODUCTION));
  assert.equal(sandboxRuntime.environment,'Sandbox');
});
test('Sandbox notifications accept omitted app ID but reject a supplied mismatching ID before reconciliation',async()=>{
  const metadata={notificationUUID:'event',notificationType:'TEST',data:{bundleId:'com.baristajobmatch.app',environment:'Sandbox'}};
  const provider=appleProvider({bundleId:'com.baristajobmatch.app',productId:'test.monthly',appAppleId:6807117736,environment:'Sandbox',client:{},
    verifier:{verifyAndDecodeNotification:async()=>metadata}});
  assert.equal((await provider.notification('fully verified fixture')).test,true);
  metadata.data.appAppleId=123;await assert.rejects(provider.notification('fully verified fixture'),{code:'INVALID_EVENT'});
  metadata.data.appAppleId=6807117736;assert.equal((await provider.notification('fully verified fixture')).test,true);
});
async function metadataEventFixture({environment='Sandbox',appId,wrongBundle=false,badNested=false}={}) {
  const {SignedDataVerifier,Environment,VerificationException,VerificationStatus}=await import('@apple/app-store-server-library');
  const metadata={notificationUUID:'event',notificationType:'DID_RENEW',data:{bundleId:wrongBundle?'wrong.bundle':'com.baristajobmatch.app',environment,
    signedTransactionInfo:'nested-signed-fixture',...(appId===undefined?{}:{appAppleId:appId})}};
  const calls=[];
  const runtimes={};
  for(const selected of ['Production','Sandbox']) {
    const runtime=await createProviderRuntime(readAppleEventConfiguration(selected,env));
    const validator=new SignedDataVerifier([],false,selected==='Production'?Environment.PRODUCTION:Environment.SANDBOX,'com.baristajobmatch.app',6807117736);
    // Offline fixtures inject the signature boundary; the installed official
    // metadata validation, provider checks and separate retry are real code.
    const verifier={
      verifyAndDecodeNotification:async payload=>{assert.equal(payload,'outer-signed-fixture');calls.push(selected);
        validator.verifyNotification(metadata.data.bundleId,metadata.data.appAppleId,metadata.data.environment);return metadata;},
      verifyAndDecodeTransaction:async()=>{if(badNested)throw new VerificationException(VerificationStatus.INVALID_CERTIFICATE);
        return {bundleId:metadata.data.bundleId,productId:'test.monthly',environment,originalTransactionId:'original'};},
    };
    runtimes[selected]={...runtime,provider:appleProvider({client:{},verifier,environment:selected,bundleId:'com.baristajobmatch.app',appAppleId:6807117736,productId:'test.monthly'})};
  }
  return {calls,run:()=>verifiedAppleEvent(async selected=>runtimes[selected],'outer-signed-fixture','Production')};
}
test('omitted-ID Sandbox event succeeds only after a separate complete Sandbox provider verification',async()=>{
  const h=await metadataEventFixture();const result=await h.run();
  assert.deepEqual(h.calls,['Production','Sandbox']);assert.equal(result.runtime.environment,'Sandbox');assert.equal(result.event.providerSubscriptionId,'original');
});
for(const [name,options] of [
  ['Sandbox supplied wrong app ID',{appId:123}],['Sandbox wrong bundle',{wrongBundle:true}],
  ['Production wrong app ID',{environment:'Production',appId:123}],['invalid nested transaction',{badNested:true}],
])test(`alternate full verification rejects ${name}`,async()=>{
  const h=await metadataEventFixture(options);await assert.rejects(h.run());assert.deepEqual(h.calls,['Production','Sandbox']);
});
test('runtime cache separates provider and environment, shares concurrent setup, and retries failed setup',async()=>{
  const calls=[];let fail=true;
  const cached=providerRuntimeCache(async config=>{calls.push(`${config.provider}:${config.environment}`);if(config.provider==='google' && fail){fail=false;throw Error('setup');}return {...config};});
  const a=cached({provider:'apple',environment:'Production'}),b=cached({provider:'apple',environment:'Production'});
  assert.equal(a,b);await a;
  const c=await cached({provider:'apple',environment:'Sandbox'});assert.equal(c.environment,'Sandbox');
  await assert.rejects(cached({provider:'google',environment:'Production'}));
  await cached({provider:'google',environment:'Production'});
  assert.deepEqual(calls,['apple:Production','apple:Sandbox','google:Production','google:Production']);
});

const baseStatus={provider:'apple',environment:'Sandbox',providerSubscriptionId:'original',transactionId:'transaction',binding:'binding',
  productId:'test.monthly',access:'pro',status:'active',currentPeriodEnd:'2099-01-01T00:00:00Z',gracePeriodEnd:null,autoRenews:true,canManage:true};
function reconciliation(options={}) {
  const writes=[],events=[];let mapped=options.mapped!==false;
  const previous=options.previous===undefined?{userId:'reviewer',revision:1}:options.previous;
  const repository={owner:async()=>({userId:options.owner || 'reviewer'}),activeCafe:async()=>options.deleted!==true,
    read:async()=>previous,apply:async value=>{writes.push(value);return 'applied';},
    claimEvent:async value=>{events.push(['claim',value]);return 'claimed';},finishEvent:async value=>{events.push(['finish',value]);return true;}};
  const provider={identify:async()=>({providerSubscriptionId:'original',binding:'binding'}),verify:async()=>({...baseStatus,...options.status})};
  const authorize=sandboxReconciliationAuthorizer({environment:'Production',activeCafe:repository.activeCafe,
    contextFor:async()=>{if(options.contextFailure)throw Error('database unavailable');return mapped?sandbox:production;}});
  return {writes,events,map:value=>{mapped=value;},reconciler:createReconciler({repository,providers:{apple:provider},environment:'Sandbox',authorize})};
}
test('only mapped authoritative context permits new Sandbox entitlement; caller identity cannot transfer ownership',async()=>{
  const allowed=reconciliation({previous:null});await allowed.reconciler.reconcile({provider:'apple',proof:'verified fixture',accountId:'reviewer'});
  assert.equal(allowed.writes.length,1);assert.equal(allowed.writes[0].environment,'Sandbox');assert.equal(allowed.writes[0].userId,'reviewer');
  const denied=reconciliation({mapped:false,previous:null});await assert.rejects(denied.reconciler.reconcile({provider:'apple',proof:'fixture',accountId:'reviewer'}),{code:'ACCOUNT_UNAVAILABLE'});
  assert.equal(denied.writes.length,0);
  const wrong=reconciliation();await assert.rejects(wrong.reconciler.reconcile({provider:'apple',proof:'fixture',accountId:'attacker'}),{code:'ACCOUNT_MISMATCH'});assert.equal(wrong.writes.length,0);
});
for(const status of ['expired','revoked'])test(`already-owned ${status} webhook survives revoked mapping and deleted profile without new access`,async()=>{
  const h=reconciliation({mapped:false,deleted:true,status:{status,access:'free'}});
  const result=await h.reconciler.notification({provider:'apple',eventId:status,proof:'verified fixture',payload:'signed fixture'});
  assert.equal(result.kind,'processed');assert.equal(h.writes.length,1);assert.equal(h.writes[0].access,'free');
  assert.equal(h.writes[0].environment,'Sandbox');assert.equal(h.events.at(-1)[1].success,true);
});
for(const deleted of [false,true])test(`already-owned nonterminal revoked-map event is acknowledged as ignored, not endlessly retried (deleted=${deleted})`,async()=>{
  const h=reconciliation({mapped:false,deleted});
  const result=await h.reconciler.notification({provider:'apple',eventId:'renewal',proof:'verified fixture',payload:'signed fixture'});
  assert.equal(result.status.ignored,true);assert.equal(h.writes.length,0);assert.equal(h.events.at(-1)[1].success,true);
});
test('unmapped unknown Sandbox subscription, transient mapping failure, and wrong previous owner never get ignored success',async()=>{
  for(const options of [{mapped:false,previous:null},{contextFailure:true},{previous:{userId:'other',revision:2}}]) {
    const h=reconciliation(options);await assert.rejects(h.reconciler.notification({provider:'apple',eventId:'event',proof:'fixture',payload:'signed fixture'}));
    assert.equal(h.writes.length,0);assert.equal(h.events.at(-1)[1].success,false);
  }
});
test('an authenticated client never receives historical ignored-success after mapping revocation',async()=>{
  const h=reconciliation({mapped:false});await assert.rejects(h.reconciler.reconcile({provider:'apple',proof:'fixture',accountId:'reviewer'}));assert.equal(h.writes.length,0);
});
test('provider still rejects valid decoded Sandbox claims under a Production-pinned verifier context',async()=>{
  const provider=appleProvider({environment:'Production',bundleId:'com.baristajobmatch.app',productId:'test.monthly',client:{},
    verifier:{verifyAndDecodeTransaction:async()=>({bundleId:'com.baristajobmatch.app',productId:'test.monthly',environment:'Sandbox',originalTransactionId:'original',appAccountToken:'binding'})}});
  await assert.rejects(provider.identify('signature already checked fixture'),{code:'PURCHASE_MISMATCH'});
});

function httpFixture(options={}) {
  const calls=[];let context=options.context || production;
  const handler=verificationHandler({authenticateCafe:async()=>({id:'reviewer',profile:{role:'cafe_owner_manager'}}),
    contextFor:async(id,provider)=>{calls.push(['context',id,provider]);if(options.contextFailure)throw Error('db');return context;},
    runtimeFor:async(provider,value)=>{calls.push(['runtime',provider,value.environment]);if(options.runtimeFailure)throw Object.assign(Error('bad proof'),{code:'PURCHASE_MISMATCH'});return {environment:value.environment};},
    reconcilerFor:()=>({reconcile:async value=>{calls.push(['reconcile',value]);if(options.revoke)context=production;return {...baseStatus};}}),logFailure:()=>{}});
  return {calls,async request(body={provider:'apple',proof:'signed fixture'}){const res={code:0,headers:{},setHeader(k,v){this.headers[k]=v;},status(code){this.code=code;return this;},json(value){this.body=value;return this;}};
    await handler({method:'POST',query:{},headers:{'x-bjm-store-guard':APPLE_STORE_GUARD},body},res);return res;}};
}
test('verify context derives from authenticated owner, not request environment/tester/account/guard claims',async()=>{
  const h=httpFixture();const r=await h.request({provider:'apple',proof:'fixture',environment:'Sandbox',appleSandboxTester:true,accountId:'attacker'});
  assert.equal(r.code,200);assert.deepEqual(h.calls[0],['context','reviewer','apple']);assert.deepEqual(h.calls[1],['runtime','apple','Production']);
  assert.equal(h.calls[2][1].accountId,'reviewer');assert.equal(r.body.accountId,'reviewer');
});
test('mapped verify selects Sandbox but mapping failure/changed context cannot fall back or claim success',async()=>{
  const valid=httpFixture({context:sandbox});assert.equal((await valid.request()).code,200);assert.equal(valid.calls[1][2],'Sandbox');
  const missing=httpFixture({contextFailure:true});assert.equal((await missing.request()).code,503);assert.equal(missing.calls.some(x=>x[0]==='runtime'),false);
  const changed=httpFixture({context:sandbox,revoke:true});assert.equal((await changed.request()).code,403);
  const wrong=httpFixture({runtimeFailure:true});assert.equal((await wrong.request()).code,403);assert.equal(wrong.calls.some(x=>x[0]==='reconcile'),false);
});
test('mapped resume guard rejection precedes website/provider work; body/header impersonation cannot admit old clients',async()=>{
  let work=0;
  const service=nativeCheckoutService({repository:{},environment:'Production',contextFor:async()=>sandbox,enabled:true,productId:'test.monthly',ready:async()=>{work++;}});
  const handler=checkoutHandler({authenticateCafe:async()=>({id:'reviewer',profile:{role:'cafe_owner_manager'}}),serviceFor:()=>service,websiteStatus:async()=>{work++;return {};}});
  for(const header of [undefined,['apple-app-transaction-v1'],'incorrect']) {
    const res={status(code){this.code=code;return this;},setHeader(){},json(value){this.body=value;}};
    await handler({method:'POST',query:{action:'resume'},headers:{'x-bjm-store-guard':header},body:{provider:'apple',productId:'test.monthly',storefront:'USA',guardProtocol:APPLE_STORE_GUARD}},res);
    assert.equal(res.code,409);assert.equal(work,0);
  }
});
test('repository reads sanitized DB context and exact recorded attempt; guard protocol is explicitly persisted',async()=>{
  const calls=[];const repository=nativeBillingRepository(async(path,options)=>{calls.push([path,JSON.parse(options.body)]);return path.endsWith('attempt_context')?{environment:'Sandbox',provider:'apple',guardProtocol:APPLE_STORE_GUARD}:sandbox;});
  assert.deepEqual(await repository.context('reviewer','apple'),sandbox);
  assert.equal((await repository.attemptContext('reviewer','attempt')).environment,'Sandbox');
  await repository.claimCheckout('reviewer','apple','Sandbox','attempt',APPLE_STORE_GUARD);
  await repository.startCheckout('reviewer','Sandbox','attempt',APPLE_STORE_GUARD);
  await repository.recoverAppleCheckout('reviewer','Sandbox',APPLE_STORE_GUARD);
  assert.deepEqual(calls[0][1],{p_user_id:'reviewer',p_provider:'apple'});
  for(const [,body] of calls.slice(2))assert.equal(body.p_guard_protocol,APPLE_STORE_GUARD);
});
