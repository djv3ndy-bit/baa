import test from 'node:test';
import assert from 'node:assert/strict';
import {nativeBillingRepository} from '../../server/native-billing/repository.mjs';

test('checkout provider lookup uses only the trusted account, environment and exact reservation',async()=>{
 const calls=[];
 const repository=nativeBillingRepository(async(...args)=>{calls.push(args);return 'google';});
 assert.equal(await repository.checkoutProvider('saved-cafe','Production','saved-attempt'),'google');
 assert.deepEqual(calls,[['rpc/native_checkout_provider',{method:'POST',body:JSON.stringify({p_user_id:'saved-cafe',p_environment:'Production',p_attempt_id:'saved-attempt'})}]]);
});
