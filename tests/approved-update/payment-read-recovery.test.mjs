import test from 'node:test';
import assert from 'node:assert/strict';
import { APIException } from '@apple/app-store-server-library';
import { retryBillingRead, temporaryReadFailure } from '../../server/native-billing/retryRead.mjs';
import { nativeBillingRepository } from '../../server/native-billing/repository.mjs';
import { appleProvider } from '../../server/native-billing/providers.mjs';
import { accountBillingHandler } from '../../server/native-billing/accountBillingHandler.mjs';

test('temporary reads retry with bounded backoff, then use only the fresh result', async () => {
  for (const error of [new APIException(500, 5000001), new Error('Database request failed (503).'),
    new TypeError('fetch failed'), Object.assign(new Error(), {name: 'FetchError', type: 'system', code: 'ECONNRESET'})]) {
    const waits = []; let calls = 0;
    const result = await retryBillingRead(async () => { if (++calls < 3) throw error; return {status:'expired'}; }, {wait: async ms => waits.push(ms)});
    assert.deepEqual(result, {status:'expired'}); assert.equal(calls, 3); assert.deepEqual(waits, [200, 600]);
  }
});

test('persistent failures stop after three attempts and preserve the failure', async () => {
  const error = new Error('Database request failed (504).'); let calls = 0;
  await assert.rejects(retryBillingRead(async () => { calls++; throw error; }, {wait: async () => {}}), e => e === error);
  assert.equal(calls, 3);
});

test('invalid proofs, permission failures, rate limits and malformed responses never retry', async () => {
  for (const error of [new APIException(401), new APIException(429), new APIException(404),
    new Error('Database request failed (403).'), new Error('Database request failed (429).'),
    new SyntaxError('Invalid JSON'), Object.assign(new Error(), {code:'ACCOUNT_MISMATCH'}),
    new Error('Database request failed (503). extra text')]) {
    let calls = 0;
    assert.equal(temporaryReadFailure(error), false);
    await assert.rejects(retryBillingRead(async () => { calls++; throw error; }, {wait: async () => assert.fail('Must not wait')}), e => e === error);
    assert.equal(calls, 1);
  }
});

test('repository recovers a failed ownership read without changing the bound account', async () => {
  let calls = 0;
  const repo = nativeBillingRepository(async (path, options) => {
    assert.equal(path, 'rpc/native_billing_owner');
    assert.deepEqual(JSON.parse(options.body), {p_binding:'same-binding'});
    if (++calls === 1) throw new Error('Database request failed (502).');
    return 'bound-cafe';
  });
  assert.deepEqual(await repo.owner('same-binding'), {userId:'bound-cafe'}); assert.equal(calls, 2);
});

test('event leases, checkout creation and uncertain entitlement writes never auto-retry', async () => {
  for (const operation of [r => r.claimCheckout('cafe','apple','Sandbox','attempt'),
    r => r.startCheckout('cafe','Sandbox','attempt'), r => r.apply({}),
    r => r.claimEvent({}), r => r.finishEvent({})]) {
    let calls = 0;
    const repo = nativeBillingRepository(async () => { calls++; throw new Error('Database request failed (503).'); });
    await assert.rejects(operation(repo)); assert.equal(calls, 1);
  }
});

test('Apple retry still verifies current signed revocation and cannot grant old receipt access', async () => {
  let calls = 0; const proofs = [];
  const expected = {bundleId:'com.baristajobmatch.app', productId:'monthly', environment:'Sandbox', binding:'bound-cafe'};
  const transaction = {...expected, appAccountToken:expected.binding, originalTransactionId:'original', transactionId:'latest',
    type:'Auto-Renewable Subscription', inAppOwnershipType:'PURCHASED', expiresDate:Date.now()+100000};
  const provider = appleProvider({...expected,
    verifier:{verifyAndDecodeTransaction:async proof => {proofs.push(proof);return proof==='old-proof'?transaction:{...transaction,revocationDate:Date.now()-1};}},
    client:{getAllSubscriptionStatuses:async id => {
      assert.equal(id,'original'); if (++calls === 1) throw new APIException(503);
      return {bundleId:expected.bundleId,environment:'Sandbox',data:[{lastTransactions:[{originalTransactionId:id,status:5,signedTransactionInfo:'current-revoked-proof'}]}]};
    }},
  });
  const result = await provider.verify('old-proof',expected.binding);
  assert.equal(result.access,'free'); assert.equal(result.status,'revoked'); assert.equal(calls,2);
  assert.deepEqual(proofs,['old-proof','current-revoked-proof']);
});

test('shared-status failure is classified without granting access or leaking provider material', async () => {
  const reports=[];
  const handler=accountBillingHandler({configured:()=>true,
    existingBilling:async(req,res)=>res.status(200).json({plan:'pro'}),
    authenticateCafe:async()=>({id:'cafe',profile:{role:'cafe_owner_manager'}}),
    statusFor:async()=>{throw new Error('Database request failed (503).');},
    logFailure:report=>{reports.push(report);throw Error('logger unavailable');},
  });
  const res={setHeader(){},status(code){this.code=code;return this;},json(body){this.body=body;return this;}};
  await handler({method:'GET',headers:{authorization:'private-token'},query:{}},res);
  assert.equal(res.code,503);assert.equal(res.body.plan,undefined);
  assert.equal(reports[0].event,'native_billing_status_failed');assert.equal(reports[0].reason,'DATABASE_REQUEST_FAILED');
  assert.equal(reports[0].upstreamStatus,503);assert.doesNotMatch(JSON.stringify(reports),/private-token|cafe/);
});
