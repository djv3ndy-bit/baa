import test from 'node:test';
import assert from 'node:assert/strict';
import { verificationHandler } from '../../server/native-billing/verificationHandler.mjs';

function fixture() {
  const calls = [];
  const deps = {
    authenticateCafe: async () => ({ id:'saved-account',profile:{ suspended_at:null } }),
    runtimeFor: async provider => ({ provider:{ notification:async () => ({ provider,eventId:'event',proof:'verified-proof' }) },
      notification:async () => ({ provider,eventId:'event',providerSubscriptionId:'verified-token' }) }),
    reconcilerFor: () => ({ reconcile:async input => { calls.push(input); return { provider:input.provider, access:'pro',status:'active',
      currentPeriodEnd:'2099-01-01T00:00:00Z',autoRenews:true,canManage:true,binding:'private-binding',providerSubscriptionId:'private-token' }; },
      notification:async input => { calls.push(input); } }),
  };
  async function request(override = {}) {
    const req = { method:'POST',query:{},headers:{},body:{ provider:'apple',proof:'signed-proof',accountId:'attacker-chosen-account' },...override };
    const response = { code:200,headers:{},setHeader(k,v){this.headers[k]=v;},status(code){this.code=code;return this;},json(body){this.body=body;return this;} };
    await verificationHandler(deps)(req,response); return response;
  }
  return { deps,calls,request };
}
test('verification uses the authenticated account and returns only purchase-scoped safe fields',async()=>{
  const f=fixture(), response=await f.request();assert.equal(response.code,200);assert.equal(f.calls[0].accountId,'saved-account');
  assert.equal(response.body.accountId,'saved-account');assert.equal(response.body.purchase.access,'pro');assert.equal(response.body.access,undefined);
  assert.equal(response.headers['Cache-Control'],'no-store');assert.doesNotMatch(JSON.stringify(response.body),/private-token|private-binding|signed-proof|attacker/);
});
test('missing auth and suspended accounts stop before any receipt verification',async()=>{
  const f=fixture();f.deps.authenticateCafe=async()=>null;assert.equal((await f.request()).code,401);
  f.deps.authenticateCafe=async()=>({id:'saved-account',profile:{suspended_at:'now'}});assert.equal((await f.request()).code,403);assert.equal(f.calls.length,0);
});
test('only known POST actions and bounded well-formed receipt bodies are accepted',async()=>{
  const f=fixture();assert.equal((await f.request({method:'GET'})).code,405);assert.equal((await f.request({query:{action:'buy-now'}})).code,404);
  for(const body of ['{invalid',[],null,{provider:'stripe',proof:'proof'},{provider:'apple',proof:'x'.repeat(32769)}])assert.equal((await f.request({body})).code,400);
  assert.equal((await f.request({body:'x'.repeat(262145)})).code,413);assert.equal(f.calls.length,0);
});
test('forged Apple notifications never reach the billing ledger',async()=>{
  const f=fixture();f.deps.runtimeFor=async()=>({provider:{notification:async()=>{throw Object.assign(Error('private receipt and credential detail'),{code:'INVALID_EVENT'});}}});
  const r=await f.request({query:{action:'apple-events'},body:{signedPayload:'forged'}});assert.equal(r.code,403);assert.equal(f.calls.length,0);assert.doesNotMatch(JSON.stringify(r.body),/credential|forged|private/);
});
test('verified notifications preserve the exact provider payload for idempotency',async()=>{
  const f=fixture();assert.equal((await f.request({query:{action:'apple-events'},body:{signedPayload:'signed-payload'}})).code,200);
  assert.equal(f.calls[0].proof,'verified-proof');assert.equal(f.calls[0].payload,'signed-payload');
  assert.equal((await f.request({query:{action:'google-events'},body:{message:{data:'provider-event-base64'}}})).code,200);
  assert.equal(f.calls[1].proof,'verified-token');assert.equal(f.calls[1].payload,'provider-event-base64');
});
test('database or provider failures request a retry without a false success or secret disclosure',async()=>{
  const f=fixture();f.deps.reconcilerFor=()=>({reconcile:async()=>{throw Error('credential=secret-token');},notification:async()=>{throw Error('uncommitted');}});
  let r=await f.request();assert.equal(r.code,503);assert.match(r.body.error,/do not purchase again/);assert.doesNotMatch(JSON.stringify(r.body),/secret-token/);
  r=await f.request({query:{action:'apple-events'},body:{signedPayload:'signed-payload'}});assert.equal(r.code,503);assert.equal(r.body.received,undefined);
});
