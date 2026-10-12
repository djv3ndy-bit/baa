import test from 'node:test';
import assert from 'node:assert/strict';
import {androidBillingConnectionCheck} from '../../server/android-public-billing/connectionCheck.mjs';
import {androidSupabaseTransport} from '../../server/android-public-billing/supabaseTransport.mjs';
import {androidPublicBillingIdentity as pin} from '../../server/android-public-billing/configuration.mjs';
const bearer=Buffer.alloc(32,7).toString('base64url');
const env=()=>({ANDROID_GOOGLE_BILLING_ACTIVE:'true',ANDROID_GOOGLE_RECEIPTS_ACTIVE:'false',ANDROID_GOOGLE_EVENTS_ACTIVE:'false',
  NATIVE_PURCHASES_ENABLED:'false',BILLING_ENABLED:'false',ANDROID_DIRECT_FCM_ENABLED:'false',ANDROID_PUBLIC_NOTIFICATIONS_ACTIVE:'false',ANDROID_REVIEW_ACCESS_ENABLED:'false',
  ANDROID_BILLING_CONNECTION_SECRET:bearer,VERCEL_PROJECT_ID:pin.projectId,VERCEL_ENV:'production',VERCEL_TARGET_ENV:'production',
  VERCEL_URL:'baristamatch-android-fixture-baristamatch.vercel.app',SUPABASE_URL:pin.supabaseUrl,SUPABASE_PUBLISHABLE_KEY:'sb_publishable_fixture',SUPABASE_SECRET_KEY:'sb_secret_fixture',
  NATIVE_BILLING_ENVIRONMENT:'Production',GOOGLE_PLAY_AUTH_MODE:'vercel_oidc',GOOGLE_PLAY_PRODUCT_ID:pin.productId,GOOGLE_PLAY_BASE_PLAN_ID:pin.basePlanId,
  GOOGLE_PLAY_WIF_PROJECT_NUMBER:'397053773139',GOOGLE_PLAY_WIF_SERVICE_ACCOUNT_EMAIL:'baristamatch-play-public@baristamatch.iam.gserviceaccount.com',
  GOOGLE_PLAY_WIF_PROVIDER_RESOURCE:'projects/397053773139/locations/global/workloadIdentityPools/baristamatch-android-public/providers/vercel-android-production',
  GOOGLE_PLAY_WIF_VERCEL_ISSUER:pin.issuer,GOOGLE_PLAY_WIF_VERCEL_AUDIENCE:pin.audience});
const output=()=>({headers:{},setHeader(k,v){this.headers[k]=v;},status(code){this.code=code;return this;},json(value){this.body=value;return this;}});
const request=()=>({method:'GET',url:'/api/android-billing-connection-check',query:{},headers:{host:env().VERCEL_URL,authorization:`Bearer ${bearer}`}});
test('valid private probe verifies identity before constructing its fixed DB-only transport',async()=>{
  const calls=[],res=output();await androidBillingConnectionCheck({env:env(),verifyIdentity:async()=>calls.push('identity'),
    createTransport:configuration=>{assert.equal(Object.isFrozen(configuration.supabase),true);calls.push('transport');return {connectionCheck:async()=>calls.push('read')};}})(request(),res);
  assert.equal(res.code,200);assert.deepEqual(calls,['identity','transport','read']);assert.equal(res.body.databaseConnectionChecked,true);
  assert.equal(res.body.existingAccountDataReturned,false);assert.equal(res.headers['Cache-Control'],'no-store');
});
test('wrong key/method/query/alias/config/activated mutation flags stop before identity or DB reads',async()=>{
  const noWork=()=>assert.fail('guard performed upstream work');
  for(const changes of [{method:'POST'},{url:'/api/android-billing-connection-check?'},{query:{accountId:'other'}},{headers:{...request().headers,host:pin.apiHost}},
    {headers:{...request().headers,authorization:undefined}},{headers:{...request().headers,authorization:`Bearer ${Buffer.alloc(32,8).toString('base64url')}`}}]) {
    const res=output();await androidBillingConnectionCheck({env:env(),verifyIdentity:noWork,createTransport:noWork})({...request(),...changes},res);
    assert.ok([401,404].includes(res.code));
  }
  for(const key of ['ANDROID_GOOGLE_RECEIPTS_ACTIVE','ANDROID_GOOGLE_EVENTS_ACTIVE','NATIVE_PURCHASES_ENABLED','BILLING_ENABLED','ANDROID_DIRECT_FCM_ENABLED','ANDROID_PUBLIC_NOTIFICATIONS_ACTIVE','ANDROID_REVIEW_ACCESS_ENABLED']) {
    const res=output();await androidBillingConnectionCheck({env:{...env(),[key]:'true'},verifyIdentity:noWork,createTransport:noWork})(request(),res);assert.equal(res.code,404);
  }
});
test('probe errors disclose no credentials or upstream messages',async()=>{
  for(const failing of ['identity','db']) {
    const res=output();await androidBillingConnectionCheck({env:env(),verifyIdentity:async()=>{if(failing==='identity')throw Error('private credentials');},
      createTransport:()=>({connectionCheck:async()=>{throw Error('private credentials');}})})(request(),res);
    assert.equal(res.code,503);assert.equal(JSON.stringify(res.body).includes('private credentials'),false);
  }
});
test('probe makes only the two fixed sentinel reads, never forwards its bearer and expects exact []/null shapes',async()=>{
  const calls=[];const transport=androidSupabaseTransport({supabase:{url:pin.supabaseUrl,publishableKey:'sb_publishable_fixture',secretKey:'sb_secret_fixture'}},
    {fetchImpl:async(url,options)=>{calls.push({url,options});return {ok:true,text:async()=>calls.length===1?'[]':'null'};}});
  await transport.connectionCheck();assert.equal(calls.length,2);
  assert.equal(calls[0].url,`${pin.supabaseUrl}/rest/v1/profiles?id=eq.00000000-0000-4000-8000-000000000000&select=id&limit=2`);
  assert.equal(calls[1].url,`${pin.supabaseUrl}/rest/v1/rpc/native_checkout_provider`);
  assert.deepEqual(JSON.parse(calls[1].options.body),{p_user_id:'00000000-0000-4000-8000-000000000000',p_environment:'Production',p_attempt_id:'00000000-0000-4000-8000-000000000001'});
  for(const {options} of calls){assert.equal(options.headers.Authorization,undefined);assert.equal(options.headers.apikey,'sb_secret_fixture');assert.equal(options.redirect,'error');}
});
test('a sentinel collision or malformed lookup stops without returning account information or treating it as success',async()=>{
  for(const first of [[{id:'00000000-0000-4000-8000-000000000000'}],{},null]) {
    let calls=0;const transport=androidSupabaseTransport({supabase:{url:pin.supabaseUrl,publishableKey:'sb_publishable_fixture',secretKey:'sb_secret_fixture'}},
      {fetchImpl:async()=>{calls++;return {ok:true,text:async()=>JSON.stringify(first)};}});
    await assert.rejects(transport.connectionCheck());assert.equal(calls,1);
  }
  for(const second of [[],{},'google',false,0]) {
    let calls=0;const transport=androidSupabaseTransport({supabase:{url:pin.supabaseUrl,publishableKey:'sb_publishable_fixture',secretKey:'sb_secret_fixture'}},
      {fetchImpl:async()=>({ok:true,text:async()=>JSON.stringify(++calls===1?[]:second)})});await assert.rejects(transport.connectionCheck());
  }
});
