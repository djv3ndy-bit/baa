import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as tick } from 'node:timers/promises';
import { ownedAppleRefresh } from '../server/native-billing/ownedAppleRefresh.mjs';
import { nativeBillingRepository } from '../server/native-billing/repository.mjs';
import { nativeCheckoutService } from '../server/native-billing/checkoutService.mjs';

const USER = '10000000-0000-4000-8000-000000000001';
const OTHER = '10000000-0000-4000-8000-000000000002';
const BINDING = '20000000-0000-4000-8000-000000000001';
const PRODUCT = 'example.cafe.pro.monthly';
const NOW = Date.parse('2026-11-04T14:00:00.000Z');
const account = {id:USER, role:'cafe_owner_manager'};
const mapped = {environment:'Sandbox', appleSandboxTester:true};
const ordinary = {environment:'Production', appleSandboxTester:false};
const website = {plan:'free', connectedToBilling:false, canManageBilling:false, billingPaused:false};
const secret = 'synthetic-unit-test-budget-secret-32-characters';
const snapshot = () => ({userId:USER, provider:'apple', environment:'Sandbox',
  subscriptionId:'400000000001', binding:BINDING, productId:PRODUCT, status:'active', autoRenews:true,
  revision:1, generation:2, verifiedAt:'2026-11-04T13:50:00.000Z', currentPeriodEnd:'2026-11-04T13:57:00.000Z', gracePeriodEnd:null,
  authorizedAt:'2026-11-04T12:00:00.123456+00:00', expiresAt:'2026-12-04T12:00:00.123456+00:00',
  windowStartsAt:'2026-11-04T12:00:00.123456+00:00', windowEndsAt:'2026-12-04T12:00:00.123456+00:00'});
const verified = () => ({provider:'apple', environment:'Sandbox', providerSubscriptionId:'400000000001', binding:BINDING,
  productId:PRODUCT, transactionId:'400000000002', status:'expired', access:'free', autoRenews:false,
  currentPeriodEnd:'2026-11-04T13:57:00.000Z', gracePeriodEnd:null});

function harness(overrides={}) {
  const calls=[];
  const repo={
    async ownedAppleRefresh(id,options) {calls.push(['snapshot',id,options]);return snapshot();},
    async consumeOwnedAppleRefreshBudget(buckets,options) {calls.push(['budget',buckets,options]);return {allowed:true,retry_after_seconds:0};},
    async applyOwnedAppleRefresh(before,after,options) {calls.push(['apply',before,after,options]);return 'applied';},
    ...overrides.repository,
  };
  const provider={async verifyExisting(chain,binding,options) {calls.push(['verify',chain,binding,options]);return verified();},...overrides.provider};
  const args={repository:repo,environment:'Production',productId:PRODUCT,budgetSecret:()=>secret,now:()=>NOW,
    contextFor:async(id,providerName,options)=>{calls.push(['context',id,providerName,options]);return mapped;},
    providerFor:async(context,options)=>{calls.push(['provider',context,options]);return provider;},
    ...overrides.args,
  };
  return {calls,repo,provider,args,refresh:ownedAppleRefresh(args)};
}

test('one eligible owned chain is verified after durable budget and applied once with exact original authority',async()=>{
  const h=harness();
  assert.equal(await h.refresh(account,mapped),true);
  assert.deepEqual(h.calls.map(row=>row[0]),['snapshot','budget','provider','verify','context','apply']);
  assert.deepEqual(h.calls.find(row=>row[0]==='verify').slice(1,3),['400000000001',BINDING]);
  const applied=h.calls.find(row=>row[0]==='apply');
  assert.deepEqual(applied[1],snapshot());assert.deepEqual(applied[2],verified());
  assert.equal(applied[1].authorizedAt,'2026-11-04T12:00:00.123456+00:00');
  const signals=h.calls.map(row=>row.at(-1)?.signal).filter(Boolean);
  assert.equal(signals.length,6);assert(signals.every(signal=>signal===signals[0]));
});

test('ordinary Production, isolated Sandbox QA and nonproduction hosts perform no snapshot, secret or Apple work',async()=>{
  for(const [environment,context] of [['Production',ordinary],['Sandbox',mapped],['Sandbox',{environment:'Sandbox',appleSandboxTester:false}],['Preview',mapped]]) {
    const h=harness({args:{environment,budgetSecret:()=>{throw Error('must not read secret');}}});
    assert.equal(await h.refresh(account,context),false);assert.deepEqual(h.calls,[]);
  }
});

test('wrong role, suspended account and malformed supplied context cannot start a refresh',async()=>{
  for(const candidate of [{...account,role:'barista'},{...account,suspendedAt:'2026-11-01T00:00:00Z'},{...account,id:'bad'},null]) {
    const h=harness();assert.equal(await h.refresh(candidate,mapped),false);assert.deepEqual(h.calls,[]);
  }
  for(const context of [null,[],{environment:'Sandbox',appleSandboxTester:'true'},{environment:'Production',appleSandboxTester:true}]) {
    const h=harness();assert.equal(await h.refresh(account,context),false);assert.deepEqual(h.calls,[]);
  }
});

for(const [name,change] of Object.entries({
  absent:()=>null,wrongOwner:s=>({...s,userId:OTHER}),google:s=>({...s,provider:'google'}),production:s=>({...s,environment:'Production'}),
  sku:s=>({...s,productId:'wrong.product'}),binding:s=>({...s,binding:'not-uuid'}),emptyChain:s=>({...s,subscriptionId:''}),
  sentinel:s=>({...s,revision:0}),unsafeRevision:s=>({...s,revision:2**53}),generation:s=>({...s,generation:0}),
  terminal:s=>({...s,status:'expired'}),pending:s=>({...s,status:'pending'}),renewalType:s=>({...s,autoRenews:'true'}),
  futurePeriod:s=>({...s,currentPeriodEnd:'2026-11-05T00:00:00Z'}),recent:s=>({...s,verifiedAt:'2026-11-04T13:59:30Z'}),
  futureAuthority:s=>({...s,authorizedAt:'2026-11-05T00:00:00Z'}),authorityExpired:s=>({...s,expiresAt:'2026-11-04T13:00:00Z'}),
  futureWindow:s=>({...s,windowStartsAt:'2026-11-05T00:00:00Z'}),windowExpired:s=>({...s,windowEndsAt:'2026-11-04T13:00:00Z'}),
  malformedTimestamp:s=>({...s,verifiedAt:'yesterday'}),noGraceField:s=>{const x={...s};delete x.gracePeriodEnd;return x;},
  activeGrace:s=>({...s,status:'grace',gracePeriodEnd:'2026-11-04T15:00:00Z'}),
})) test(`ineligible snapshot ${name} consumes no budget and makes no Apple request`,async()=>{
  const h=harness({repository:{async ownedAppleRefresh(){return change(snapshot());}}});
  assert.equal(await h.refresh(account,mapped),false);assert.deepEqual(h.calls,[]);
});

test('elapsed grace is eligible and a newly renewed verified active state may be applied',async()=>{
  const h=harness({repository:{async ownedAppleRefresh(){return {...snapshot(),status:'grace',gracePeriodEnd:'2026-11-04T13:59:00Z'};}},
    provider:{async verifyExisting(){return {...verified(),status:'active',access:'pro',autoRenews:true,currentPeriodEnd:'2026-11-04T14:10:00Z'};}}});
  assert.equal(await h.refresh(account,mapped),true);
});

test('budgets contain only keyed digests, one per chain/generation and a common global cap',async()=>{
  const get=async(value)=>{const h=harness({repository:{async ownedAppleRefresh(){return value;}}});await h.refresh({...account,id:value.userId},mapped);return h.calls.find(row=>row[0]==='budget')[1];};
  const original=await get(snapshot());
  assert.deepEqual(original.map(({max_requests,window_seconds})=>({max_requests,window_seconds})),[{max_requests:1,window_seconds:300},{max_requests:30,window_seconds:300}]);
  assert(original.every(row=>/^[a-f0-9]{64}$/.test(row.bucket_key)));
  assert(!JSON.stringify(original).includes(USER));assert(!JSON.stringify(original).includes('400000000001'));
  for(const update of [{userId:OTHER},{subscriptionId:'400000000003'},{generation:3}]) {
    const changed=await get({...snapshot(),...update});
    assert.notEqual(changed[0].bucket_key,original[0].bucket_key);assert.equal(changed[1].bucket_key,original[1].bucket_key);
  }
  assert.notEqual(original[0].bucket_key,original[1].bucket_key);
});

test('atomic budget denial/malformed response/failure never reaches Apple and is not retried',async()=>{
  for(const result of [{allowed:false,retry_after_seconds:25},{allowed:'true',retry_after_seconds:0},{allowed:true,retry_after_seconds:1},null]) {
    let calls=0;const h=harness({repository:{async consumeOwnedAppleRefreshBudget(){calls++;return result;}}});
    assert.equal(await h.refresh(account,mapped),false);assert.equal(calls,1);assert(!h.calls.some(row=>['provider','verify','apply'].includes(row[0])));
  }
  let calls=0;const h=harness({repository:{async consumeOwnedAppleRefreshBudget(){calls++;throw Error('temporary database failure');}}});
  assert.equal(await h.refresh(account,mapped),false);assert.equal(calls,1);assert(!h.calls.some(row=>row[0]==='provider'));
});

test('separate service instances share the durable budget rather than a process-local lock',async()=>{
  const claimed=new Set();let reads=0;
  const repository={async consumeOwnedAppleRefreshBudget(buckets){const k=buckets[0].bucket_key;if(claimed.has(k))return {allowed:false,retry_after_seconds:300};claimed.add(k);return {allowed:true,retry_after_seconds:0};}};
  const provider={async verifyExisting(){reads++;return verified();}};
  const first=harness({repository,provider}),second=harness({repository,provider});
  assert.deepEqual((await Promise.all([first.refresh(account,mapped),second.refresh(account,mapped)])).sort(),[false,true]);
  assert.equal(reads,1);
});

test('missing key and missing provider fail closed without applying or exposing private values',async()=>{
  for(const budgetSecret of [undefined,'short',()=>undefined,()=>{throw Error('private secret failure');}]) {
    const h=harness({args:{budgetSecret}});assert.equal(await h.refresh(account,mapped),false);assert(!h.calls.some(row=>row[0]==='budget'));
  }
  const h=harness({args:{providerFor:async()=>null}});assert.equal(await h.refresh(account,mapped),false);assert(!h.calls.some(row=>row[0]==='apply'));
});

for(const [name,change] of Object.entries({provider:s=>({...s,provider:'google'}),environment:s=>({...s,environment:'Production'}),
  original:s=>({...s,providerSubscriptionId:'foreign-chain'}),binding:s=>({...s,binding:OTHER}),product:s=>({...s,productId:'another.product'}),
  transaction:s=>({...s,transactionId:''}),state:s=>({...s,status:'unknown'}),renewal:s=>({...s,autoRenews:undefined}),
  period:s=>({...s,currentPeriodEnd:null}),grace:s=>({...s,gracePeriodEnd:'invalid'}),empty:()=>null,
})) test(`verified response ${name} mismatch cannot be applied`,async()=>{
  const h=harness({provider:{async verifyExisting(){return change(verified());}}});
  assert.equal(await h.refresh(account,mapped),false);assert(!h.calls.some(row=>row[0]==='context'||row[0]==='apply'));
});

test('provider failures and post-network mapping revocation preserve stored state',async()=>{
  const providerFailure=harness({provider:{async verifyExisting(){throw Error('private provider response');}}});
  assert.equal(await providerFailure.refresh(account,mapped),false);assert(!providerFailure.calls.some(row=>row[0]==='apply'));
  const revoked=harness({args:{contextFor:async()=>ordinary}});
  assert.equal(await revoked.refresh(account,mapped),false);assert(!revoked.calls.some(row=>row[0]==='apply'));
  const invalid=harness({args:{contextFor:async()=>({environment:'Sandbox',appleSandboxTester:'true'})}});
  assert.equal(await invalid.refresh(account,mapped),false);assert(!invalid.calls.some(row=>row[0]==='apply'));
});

test('atomic apply stale/retry/unknown/failure does not cause any retry or new checkout',async()=>{
  for(const result of ['stale','retry','unexpected',null]) {
    let count=0;const h=harness({repository:{async applyOwnedAppleRefresh(){count++;return result;}}});
    assert.equal(await h.refresh(account,mapped),false);assert.equal(count,1);assert.equal(h.calls.filter(row=>row[0]==='verify').length,1);
  }
  let count=0;const h=harness({repository:{async applyOwnedAppleRefresh(){count++;throw Error('response lost after CAS');}}});
  assert.equal(await h.refresh(account,mapped),false);assert.equal(count,1);
});

test('deadline checks after each await prevent a later provider result or context from starting apply',async()=>{
  for(const stage of ['snapshot','budget','provider','verify','context']) {
    let clock=0;const h=harness({args:{monotonicNow:()=>clock}});
    const expire=()=>{clock=4001;};
    if(stage==='snapshot')h.repo.ownedAppleRefresh=async()=>{expire();return snapshot();};
    if(stage==='budget')h.repo.consumeOwnedAppleRefreshBudget=async()=>{expire();return {allowed:true,retry_after_seconds:0};};
    if(stage==='provider')h.args.providerFor=async()=>{expire();return h.provider;};
    if(stage==='verify')h.provider.verifyExisting=async()=>{expire();return verified();};
    if(stage==='context')h.args.contextFor=async()=>{expire();return mapped;};
    const refresh=ownedAppleRefresh(h.args);
    assert.equal(await refresh(account,mapped),false,stage);assert(!h.calls.some(row=>row[0]==='apply'),stage);
  }
});

test('timeout returns stored-path fallback promptly and an uncancellable late Apple result cannot apply',async()=>{
  let resolve;let signal;
  const h=harness({args:{timeoutMs:15,monotonicNow:()=>0},provider:{verifyExisting(chain,binding,options){signal=options.signal;return new Promise(done=>{resolve=done;});}}});
  assert.equal(await h.refresh(account,mapped),false);assert.equal(signal.aborted,true);
  resolve(verified());await tick();
  assert(!h.calls.some(row=>row[0]==='context'||row[0]==='apply'));
});

test('a CAS already submitted before timeout is never repeated even if its acknowledgement arrives late',async()=>{
  let resolve;let writes=0;
  const h=harness({args:{timeoutMs:15,monotonicNow:()=>0},repository:{applyOwnedAppleRefresh(){writes++;return new Promise(done=>{resolve=done;});}}});
  assert.equal(await h.refresh(account,mapped),false);assert.equal(writes,1);
  resolve('applied');await tick();assert.equal(writes,1);
});

test('repository emits only the exact service snapshot/budget/guarded-apply arguments and abort signal',async()=>{
  const calls=[];const controller=new AbortController();const options={signal:controller.signal};
  const repository=nativeBillingRepository(async(path,request)=>{calls.push({path,request});return null;});
  await repository.ownedAppleRefresh(USER,options);
  const buckets=[{bucket_key:'a'.repeat(64),max_requests:1,window_seconds:300}];
  await repository.consumeOwnedAppleRefreshBudget(buckets,options);
  await repository.applyOwnedAppleRefresh(snapshot(),verified(),options);
  assert.deepEqual(calls.map(row=>row.path),['rpc/native_billing_owned_apple_refresh','rpc/consume_public_form_budget','rpc/native_billing_apply_owned_apple_refresh']);
  assert(calls.every(row=>row.request.method==='POST'&&row.request.signal===controller.signal));
  assert.deepEqual(JSON.parse(calls[0].request.body),{p_user_id:USER});assert.deepEqual(JSON.parse(calls[1].request.body),{p_buckets:buckets});
  assert.deepEqual(JSON.parse(calls[2].request.body),{p_user_id:USER,p_binding:BINDING,p_subscription_id:'400000000001',p_expected_revision:1,p_expected_generation:2,
    p_expected_authorized_at:snapshot().authorizedAt,p_expected_expires_at:snapshot().expiresAt,p_expected_window_start:snapshot().windowStartsAt,p_expected_window_end:snapshot().windowEndsAt,
    p_product_id:PRODUCT,p_transaction_id:'400000000002',p_status:'expired',p_period_end:'2026-11-04T13:57:00.000Z',p_grace_end:null,p_auto_renews:false});
  controller.abort();assert.throws(()=>repository.ownedAppleRefresh(USER,options),{name:'AbortError'});assert.equal(calls.length,3);
});

test('repository never retries a rate-limit consumption or uncertain guarded write',async()=>{
  for(const operation of [repo=>repo.consumeOwnedAppleRefreshBudget([]),repo=>repo.applyOwnedAppleRefresh(snapshot(),verified())]) {
    let calls=0;const repo=nativeBillingRepository(async()=>{calls++;throw new Error('Database request failed (503).');});
    await assert.rejects(operation(repo));assert.equal(calls,1);
  }
});

function serviceHarness({environment='Production',context=mapped,refreshExisting}={}) {
  let row={provider:'apple',status:'active',currentPeriodEnd:'2001-01-01T00:00:00Z',gracePeriodEnd:null,autoRenews:true,canManage:true};
  const calls=[];
  const repository={async settleVerifiedCheckout(...args){calls.push(['settle',...args]);},
    async summary(id,env){calls.push(['summary',id,env]);return {accountId:id,environment:env,subscriptions:[row]};},async checkoutPending(){return false;}};
  const refresh=refreshExisting??(async()=>{calls.push(['refresh']);row={...row,status:'expired',autoRenews:false};});
  const service=nativeCheckoutService({repository,environment,contextFor:async()=>context,enabled:false,productId:PRODUCT,refreshExisting:refresh});
  return {service,calls};
}

test('status reads the fresh ordinary summary after refresh without exposing chains, generations or proof fields',async()=>{
  const h=serviceHarness();const result=await h.service.status(account,website);
  assert.equal(result.status,'expired');assert.equal(result.access,'free');assert.equal(result.canPurchase,false);
  assert.deepEqual(h.calls.map(row=>row[0]),['settle','settle','refresh','summary']);
  for(const field of ['binding','subscriptionId','generation','revision','refreshExisting','refreshStatus','proof'])assert.equal(Object.hasOwn(result,field),false);
});

test('status hook failure falls back to stored summary and all ordinary customer contexts skip it',async()=>{
  const failed=serviceHarness({refreshExisting:async()=>{throw Error('private failure');}});
  const result=await failed.service.status(account,website);assert.equal(result.access,'free');assert.equal(result.status,'payment_required');
  for(const options of [{environment:'Production',context:ordinary},{environment:'Sandbox',context:{environment:'Sandbox',appleSandboxTester:false}},{environment:'Sandbox',context:mapped}]) {
    let calls=0;const h=serviceHarness({...options,refreshExisting:async()=>{calls++;}});
    await h.service.status(account,website);assert.equal(calls,0);
  }
});

test('a global website billing pause skips refresh without discarding readable stored status',async()=>{
  let calls=0;const h=serviceHarness({refreshExisting:async()=>{calls++;}});
  const result=await h.service.status(account,{...website,billingPaused:true});
  assert.equal(calls,0);assert.equal(result.access,'free');assert.equal(result.canPurchase,false);
});
