import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {androidPublicBillingApplication} from '../../server/android-public-billing/application.mjs';
import {androidSupabaseTransport} from '../../server/android-public-billing/supabaseTransport.mjs';
import {androidWebsiteBillingProjection,androidPublicReadOnlyStatus} from '../../server/android-public-billing/accountStatus.mjs';
import {verifiedAndroidDeploymentIdentity} from '../../server/android-public-billing/deploymentIdentity.mjs';
import {androidPublicBillingIdentity as pin} from '../../server/android-public-billing/configuration.mjs';

const id='10000000-0000-4000-8000-000000000001',other='10000000-0000-4000-8000-000000000002';
const now=Date.parse('2026-10-12T12:00:00Z');
const source={url:pin.supabaseUrl,publishableKey:'sb_publishable_fixture',secretKey:'sb_secret_fixture'};
const environment=()=>({ANDROID_GOOGLE_BILLING_ACTIVE:'true',ANDROID_GOOGLE_RECEIPTS_ACTIVE:'false',ANDROID_GOOGLE_EVENTS_ACTIVE:'false',
  NATIVE_PURCHASES_ENABLED:'false',BILLING_ENABLED:'false',ANDROID_DIRECT_FCM_ENABLED:'false',ANDROID_REVIEW_ACCESS_ENABLED:'false',
  VERCEL_PROJECT_ID:pin.projectId,VERCEL_ENV:'production',VERCEL_TARGET_ENV:'production',VERCEL_URL:'baristamatch-android-fixture-baristamatch.vercel.app',
  SUPABASE_URL:source.url,SUPABASE_PUBLISHABLE_KEY:source.publishableKey,SUPABASE_SECRET_KEY:source.secretKey,
  NATIVE_BILLING_ENVIRONMENT:'Production',GOOGLE_PLAY_AUTH_MODE:'vercel_oidc',GOOGLE_PLAY_PRODUCT_ID:pin.productId,GOOGLE_PLAY_BASE_PLAN_ID:pin.basePlanId,
  GOOGLE_PLAY_WIF_PROJECT_NUMBER:'397053773139',GOOGLE_PLAY_WIF_SERVICE_ACCOUNT_EMAIL:'baristamatch-play-public@baristamatch.iam.gserviceaccount.com',
  GOOGLE_PLAY_WIF_PROVIDER_RESOURCE:'projects/397053773139/locations/global/workloadIdentityPools/baristamatch-android-public/providers/vercel-android-production',
  GOOGLE_PLAY_WIF_VERCEL_ISSUER:pin.issuer,GOOGLE_PLAY_WIF_VERCEL_AUDIENCE:pin.audience});
const claims=()=>({iss:pin.issuer,aud:pin.audience,sub:pin.subject,owner_id:pin.ownerId,project_id:pin.projectId,
  environment:'production',iat:now/1000-30,nbf:now/1000-30,exp:now/1000+300});
const row=(changes={})=>({user_id:id,status:'free',current_period_end:null,cancel_at_period_end:false,complimentary_access:false,
  stripe_customer_id:null,stripe_subscription_id:null,stripe_checkout_attempt_id:null,...changes});
const cafe=()=>({id,profile:{id,role:'cafe_owner_manager',suspended_at:null}});
const native=(subscriptions=[])=>({accountId:id,environment:'Production',subscriptions});
const account={id,role:'cafe_owner_manager',suspendedAt:null};
const res=()=>({headers:{},setHeader(k,v){this.headers[k]=v;},status(n){this.code=n;return this;},json(v){this.body=v;return this;}});
const req=(action='status')=>({method:action==='status'?'GET':'POST',headers:{host:pin.apiHost,authorization:'Bearer a.b.c'},query:{action},
  body:action==='verify'?{provider:'google',proof:'synthetic-proof'}:action==='google-events'?{message:{data:'fixture',messageId:'event'}}:{}});
const response=(body,status=200)=>({ok:status>=200&&status<300,status,text:async()=>JSON.stringify(body)});

test('actual composition is inert while maintenance, receipts or events are disabled',async()=>{
  for(const action of ['status','prepare','start','cancel','verify','google-events']) {
    const route=['verify','google-events'].includes(action)?'purchases':'billing';
    for(const active of [false,true]) {
      if(active && !['verify','google-events'].includes(action))continue;
      const env={...environment(),ANDROID_GOOGLE_BILLING_ACTIVE:active?'true':'false'};
      const unavailable=()=>assert.fail('disabled composition performed work');
      const handler=androidPublicBillingApplication(route,{env,verifyDeploymentIdentity:unavailable,createTransport:unavailable,
        createRuntime:unavailable,createRepository:unavailable,reconciler:unavailable,now:()=>now});
      const output=res();await handler(req(action),output);assert.equal(output.code,503);
    }
  }
});
test('actual composition cannot enable checkout or cancellation while receipt gate remains off',async()=>{
  for(const action of ['prepare','start','cancel']) {
    const unavailable=()=>assert.fail('new sales/cancel performed work');
    const output=res();await androidPublicBillingApplication('billing',{env:{...environment(),BILLING_ENABLED:'true',NATIVE_PURCHASES_ENABLED:'true'},
      verifyDeploymentIdentity:unavailable,createTransport:unavailable,createRuntime:unavailable,now:()=>now})(req(action),output);
    assert.equal(output.code,503);
  }
});
test('unprotected legacy project alias cannot authenticate accounts or reach database/provider dependencies',async()=>{
  const noWork=()=>assert.fail('legacy alias performed upstream work');
  const output=res();await androidPublicBillingApplication('billing',{env:environment(),now:()=>now,
    verifyDeploymentIdentity:noWork,createTransport:noWork,createRuntime:noWork})({...req(),headers:{...req().headers,host:'project-8n2yp.vercel.app'}},output);
  assert.equal(output.code,503);
});
test('Supabase user verification and private profile lookup use separate fixed credentials and forbid redirects',async()=>{
  const calls=[];const transport=androidSupabaseTransport({supabase:source},{fetchImpl:async(url,options)=>{
    calls.push({url,options});return response(calls.length===1?{id,user_metadata:{role:'owner'}}:[cafe().profile]);
  }});
  assert.deepEqual(await transport.authenticateCafe(req()),{...cafe(),email:null,emailConfirmed:false});assert.equal(calls.length,2);
  assert.equal(calls[0].url,`${pin.supabaseUrl}/auth/v1/user`);assert.equal(calls[0].options.headers.apikey,source.publishableKey);
  assert.equal(calls[0].options.headers.Authorization,'Bearer a.b.c');
  assert.equal(calls[1].options.headers.apikey,source.secretKey);assert.equal(calls[1].options.headers.Authorization,undefined);
  for(const call of calls){assert.equal(call.options.redirect,'error');assert.ok(call.options.signal instanceof AbortSignal);}
});
test('missing/malformed token never invokes Auth or admin data',async()=>{
  const transport=androidSupabaseTransport({supabase:source},{fetchImpl:()=>assert.fail('invalid token caused fetch')});
  for(const value of [undefined,'','Bearer token','Basic a.b.c','Bearer a.b.c\n','Bearer '+ 'x'.repeat(40000)])assert.equal(await transport.authenticateCafe({headers:{authorization:value}}),null);
});
test('invalid login differs from Auth outage, unexpected response and malformed identity',async()=>{
  for(const status of [400,401,403]) {
    const transport=androidSupabaseTransport({supabase:source},{fetchImpl:async()=>response({},status)});
    assert.equal(await transport.authenticateCafe(req()),null);
  }
  for(const status of [404,429,500,503]) {
    const transport=androidSupabaseTransport({supabase:source},{fetchImpl:async()=>response({},status)});
    await assert.rejects(transport.authenticateCafe(req()));
  }
  const malformed=androidSupabaseTransport({supabase:source},{fetchImpl:async()=>response({id:'bad'})});
  await assert.rejects(malformed.authenticateCafe(req()));
});
test('wrong/malformed private profile and duplicate or missing billing rows fail closed',async()=>{
  for(const rows of [[{...cafe().profile,id:other}],[{id,role:'cafe_owner_manager'}],[cafe().profile,cafe().profile]]) {
    let step=0;const transport=androidSupabaseTransport({supabase:source},{fetchImpl:async()=>response(++step===1?{id}:rows)});
    await assert.rejects(transport.authenticateCafe(req()));
  }
  for(const rows of [[],[row({user_id:other})],[row(),row()],{}]) {
    const transport=androidSupabaseTransport({supabase:source},{fetchImpl:async()=>response(rows)});
    await assert.rejects(transport.subscriptionFor(id));
  }
});
test('private transport denies arbitrary URLs, caller headers, unrelated RPCs, Apple recovery and wrong environment',async()=>{
  const transport=androidSupabaseTransport({supabase:source},{fetchImpl:()=>assert.fail('unapproved path caused fetch')});
  for(const path of ['https://attacker.invalid','profiles','rpc/android_reviewer_access','rpc/native_checkout_recover_apple','rpc/native_checkout_claim','rpc/native_checkout_cancel','rpc/native_billing_summary?x=1']) {
    await assert.rejects(transport.adminRows(path,{method:'POST',body:'{}'}));
  }
  await assert.rejects(transport.adminRows('rpc/native_billing_summary',{method:'POST',body:'{}',headers:{apikey:'other'}}));
  await assert.rejects(transport.adminRows('rpc/native_billing_summary',{method:'POST',body:JSON.stringify({p_environment:'Sandbox'})}));
  await assert.rejects(transport.adminRows('rpc/native_billing_apply',{method:'POST',body:JSON.stringify({p_environment:'Production',p_provider:'apple'})}));
  for(const mutation of [{url:'https://other.supabase.co'},{publishableKey:'secret'},{secretKey:'legacy-key'}])assert.throws(()=>androidSupabaseTransport({supabase:{...source,...mutation}}));
});
test('modern private RPC requests use only fixed server authentication and preserve Production arguments',async()=>{
  const calls=[];const transport=androidSupabaseTransport({supabase:source},{fetchImpl:async(url,options)=>{calls.push({url,options});return response(native());}});
  assert.deepEqual(await transport.adminRows('rpc/native_billing_summary',{method:'POST',body:JSON.stringify({p_user_id:id,p_environment:'Production'})}),native());
  assert.equal(calls[0].url,`${pin.supabaseUrl}/rest/v1/rpc/native_billing_summary`);assert.equal(calls[0].options.headers.apikey,source.secretKey);
  assert.equal(calls[0].options.headers.Authorization,undefined);assert.equal(JSON.parse(calls[0].options.body).p_user_id,id);
});
test('read-only status preserves expired Stripe and active Apple/Google history without settlement or recovery',async()=>{
  for(const provider of ['apple','google']) {
    const record=row({status:'expired',stripe_customer_id:'cus_fixture',stripe_subscription_id:'sub_fixture',current_period_end:'2026-10-01T00:00:00Z'});
    const calls=[];const repository={summary:async(user,environment)=>{calls.push('summary');assert.equal(user,id);assert.equal(environment,'Production');return native([{provider,status:'active',currentPeriodEnd:'2026-11-01T00:00:00Z',gracePeriodEnd:null,autoRenews:true}]);},
      checkoutPending:async()=>{calls.push('pending');return false;},settleVerifiedCheckout:()=>assert.fail('status settled a reservation'),recoverAppleCheckout:()=>assert.fail('status recovered Apple')};
    const result=await androidPublicReadOnlyStatus({account,transport:{subscriptionFor:async()=>record},repository,now:()=>now});
    assert.equal(result.access,'pro');assert.equal(result.provider,provider);assert.equal(result.canPurchase,false);assert.equal(result.canResumeAppleCheckout,false);
    assert.equal(result.subscriptions.find(v=>v.provider==='stripe').status,'expired');assert.deepEqual(calls.sort(),['pending','summary']);
  }
});
test('read failures and malformed native/website rows never manufacture Free or enable purchases',async()=>{
  for(const changes of [{status:'unknown'},{current_period_end:'bad'},{stripe_customer_id:undefined},{cancel_at_period_end:undefined},{complimentary_access:undefined},{user_id:other}])assert.throws(()=>androidWebsiteBillingProjection(row(changes),id));
  for(const value of [null,undefined,[],{}])assert.throws(()=>androidWebsiteBillingProjection(value,id));
  for(const broken of ['subscription','summary','pending']) {
    const failure=async()=>{throw Error('private fixture error');};
    await assert.rejects(androidPublicReadOnlyStatus({account,transport:{subscriptionFor:broken==='subscription'?failure:async()=>row()},
      repository:{summary:broken==='summary'?failure:async()=>native(),checkoutPending:broken==='pending'?failure:async()=>false},now:()=>now}));
  }
});
test('DB projection agrees with the actual legacy status handler for valid Stripe status history',async()=>{
  const billingSource=readFileSync(new URL('../../api/billing.js',import.meta.url),'utf8');
  const helpers=readFileSync(new URL('../../api/_billing.js',import.meta.url),'utf8');
  const statusBody=billingSource.slice(billingSource.indexOf('async function billingStatus('),billingSource.indexOf('async function createCheckout('));
  assert.ok(statusBody.startsWith('async function billingStatus('));
  const helperBodies=['subscriptionHasPaidAccess','subscriptionCanBeManaged','subscriptionIsConnected'].map(name=>{
    const start=helpers.indexOf(`export function ${name}(`),end=helpers.indexOf('\n}\n',start)+3;assert.ok(start>=0&&end>start);return helpers.slice(start,end).replace('export ','');
  }).join('\n');
  for(const status of ['free','active','trialing','past_due','unpaid','incomplete','incomplete_expired','paused','canceled','expired'])for(const connected of [false,true]) {
    const subscription=row({status,stripe_customer_id:connected?'cus_fixture':null,stripe_subscription_id:connected?'sub_fixture':null,complimentary_access:true});
    const context=vm.createContext({PAID_STATUSES:new Set(['active','trialing']),MANAGEABLE_STATUSES:new Set(['active','trialing','past_due','unpaid','incomplete','paused']),
      authenticatedCafe:async()=>cafe(),subscriptionFor:async()=>subscription,billingPaused:()=>true,
      BILLING_PAUSED_MESSAGE:'Billing is not active. Café accounts will not be charged during the plan preview.',json:output=>output.setHeader('Cache-Control','no-store'),console});
    vm.runInContext(`${helperBodies}\n${statusBody}\nglobalThis.legacy=billingStatus;`,context);
    const output=res();await context.legacy(req(),output);assert.equal(output.code,200);
    assert.deepEqual(androidWebsiteBillingProjection(subscription,id),JSON.parse(JSON.stringify(output.body)));
  }
});
test('request-context SDK verification has exact Production options and no raw token in its result',async()=>{
  let checked=false;const payload=claims();
  const result=await verifiedAndroidDeploymentIdentity({now:()=>now,loadOidc:async()=>({getContext:()=>({headers:{'x-vercel-oidc-token':'synthetic-platform-token'}}),
    verifyVercelOidcToken:async(token,options)=>{checked=true;assert.equal(token,'synthetic-platform-token');assert.equal(options.projectId,pin.projectId);assert.equal(options.ownerId,pin.ownerId);assert.equal(options.subject,pin.subject);assert.deepEqual(options.algorithms,['RS256']);return {payload};}})});
  assert.equal(checked,true);assert.equal(result,payload);assert.equal(JSON.stringify(result).includes('synthetic-platform-token'),false);
});
test('missing context, failed signature and wrong signed claims reject before account access',async()=>{
  await assert.rejects(verifiedAndroidDeploymentIdentity({loadOidc:async()=>({getContext:()=>null,verifyVercelOidcToken:()=>assert.fail('missing context verified')})}));
  for(const mutation of [{owner_id:'other'},{project_id:'other'},{aud:[pin.audience]},{environment:'preview'},{custom_environment_id:'forbidden'},{exp:now/1000-1}]) {
    await assert.rejects(verifiedAndroidDeploymentIdentity({now:()=>now,loadOidc:async()=>({getContext:()=>({headers:{'x-vercel-oidc-token':'token'}}),verifyVercelOidcToken:async()=>({payload:{...claims(),...mutation}})})}));
  }
});
test('actual active status uses account-bound read-only composition and no runtime/reconciler',async()=>{
  const output=res(),calls=[];
  await androidPublicBillingApplication('billing',{env:environment(),now:()=>now,verifyDeploymentIdentity:async()=>claims(),
    createTransport:()=>({authenticateCafe:async()=>cafe(),subscriptionFor:async user=>{assert.equal(user,id);calls.push('subscription');return row();},adminRows:()=>assert.fail('unexpected direct DB')}),
    createRepository:()=>({summary:async()=>{calls.push('summary');return native();},checkoutPending:async()=>{calls.push('pending');return false;}}),
    createRuntime:()=>assert.fail('status constructed Google'),reconciler:()=>assert.fail('status reconciled')})(req(),output);
  assert.equal(output.code,200);assert.equal(output.body.accountId,id);assert.equal(output.body.verified,true);assert.equal(output.body.canPurchase,false);assert.equal(output.headers['Cache-Control'],'no-store');assert.equal(calls.length,3);
});
test('separately active Google verification keeps authenticated account, provider and sanitized response',async()=>{
  const output=res(),calls=[];
  await androidPublicBillingApplication('purchases',{env:{...environment(),ANDROID_GOOGLE_RECEIPTS_ACTIVE:'true'},now:()=>now,verifyDeploymentIdentity:async()=>claims(),
    createTransport:()=>({authenticateCafe:async()=>cafe(),adminRows(){}}),createRepository:()=>({fixture:true}),createRuntime:async()=>({provider:{google:true}}),
    reconciler:options=>{assert.deepEqual(Object.keys(options.providers),['google']);assert.equal(options.environment,'Production');return {reconcile:async args=>{calls.push(args);return {provider:'google',access:'pro',status:'active',currentPeriodEnd:'2026-11-01T00:00:00Z',autoRenews:true,canManage:true,privateToken:'not-returned'};}};}})(req('verify'),output);
  assert.equal(output.code,200);assert.deepEqual(calls,[{provider:'google',proof:'synthetic-proof',accountId:id}]);assert.equal(JSON.stringify(output.body).includes('not-returned'),false);
});
test('unauthorized Google event never constructs database transport or claims a ledger event',async()=>{
  const output=res();await androidPublicBillingApplication('purchases',{env:{...environment(),ANDROID_GOOGLE_RECEIPTS_ACTIVE:'true',ANDROID_GOOGLE_EVENTS_ACTIVE:'true',
    GOOGLE_PLAY_PUSH_AUDIENCE:`https://${pin.apiHost}/api/native-purchases?action=google-events`,GOOGLE_PLAY_PUSH_SERVICE_ACCOUNT_EMAIL:'baristamatch-rtdn-public@baristamatch.iam.gserviceaccount.com'},
    now:()=>now,verifyDeploymentIdentity:async()=>claims(),createTransport:()=>assert.fail('unauthorized event touched DB'),
    createRuntime:async()=>({notification:async()=>{throw Error('private provider error');}}),reconciler:()=>assert.fail('unauthorized event reconciled')})(req('google-events'),output);
  assert.equal(output.code,503);assert.equal(JSON.stringify(output.body).includes('private provider error'),false);
});
