import test from 'node:test';
import assert from 'node:assert/strict';
import {androidPublicGoogleBillingHandler} from '../../server/android-public-billing/handler.mjs';
import {androidPublicBillingIdentity as identity,readAndroidPublicBillingConfiguration} from '../../server/android-public-billing/configuration.mjs';

const userId='10000000-0000-4000-8000-000000000001',attemptId='20000000-0000-4000-8000-000000000001';
const timestamp=Date.parse('2026-10-12T12:00:00Z');
const fixture=()=>({ANDROID_GOOGLE_BILLING_ACTIVE:'true',ANDROID_GOOGLE_RECEIPTS_ACTIVE:'false',ANDROID_GOOGLE_EVENTS_ACTIVE:'false',
  NATIVE_PURCHASES_ENABLED:'false',BILLING_ENABLED:'false',ANDROID_DIRECT_FCM_ENABLED:'false',ANDROID_REVIEW_ACCESS_ENABLED:'false',
  VERCEL_ENV:'production',VERCEL_TARGET_ENV:'production',VERCEL_PROJECT_ID:identity.projectId,
  VERCEL_URL:'baristamatch-android-fixture-baristamatch.vercel.app',SUPABASE_URL:identity.supabaseUrl,
  SUPABASE_PUBLISHABLE_KEY:'sb_publishable_fixture',SUPABASE_SECRET_KEY:'sb_secret_fixture',
  NATIVE_BILLING_ENVIRONMENT:'Production',GOOGLE_PLAY_AUTH_MODE:'vercel_oidc',GOOGLE_PLAY_PRODUCT_ID:identity.productId,
  GOOGLE_PLAY_BASE_PLAN_ID:identity.basePlanId,GOOGLE_PLAY_WIF_PROJECT_NUMBER:'397053773139',
  GOOGLE_PLAY_WIF_SERVICE_ACCOUNT_EMAIL:'baristamatch-play-public@baristamatch.iam.gserviceaccount.com',
  GOOGLE_PLAY_WIF_PROVIDER_RESOURCE:'projects/397053773139/locations/global/workloadIdentityPools/baristamatch-android-public/providers/vercel-android-production',
  GOOGLE_PLAY_WIF_VERCEL_ISSUER:identity.issuer,GOOGLE_PLAY_WIF_VERCEL_AUDIENCE:identity.audience});
const claims=()=>({iss:identity.issuer,aud:identity.audience,sub:identity.subject,owner_id:identity.ownerId,
  project_id:identity.projectId,environment:'production',iat:timestamp/1000-30,nbf:timestamp/1000-30,exp:timestamp/1000+300});
const cafe=()=>({id:userId,profile:{id:userId,role:'cafe_owner_manager',suspended_at:null}});
const selection=()=>({provider:'google',productId:identity.productId,basePlanId:identity.basePlanId,storefront:'US'});
const requestFor=(action='status')=>({method:action==='status'?'GET':'POST',query:{action},
  headers:{host:identity.apiHost,authorization:'Bearer synthetic-session'},
  body:action==='prepare'?selection():action==='start'?{...selection(),attemptId}:action==='verify'?{provider:'google',proof:'synthetic-proof'}
    :action==='google-events'?{message:{data:'synthetic-event',messageId:'fixture-event'}}:{attemptId,reason:'user-cancelled'}});
function harness({environment={},request={},action='status',route=['verify','google-events','apple-events'].includes(action)?'purchases':'billing',
  verifiedClaims=claims(),user=cafe(),overrides={}}={}) {
  const env={...fixture(),...environment},calls=[];
  const deps={route,env,now:()=>timestamp,
    verifyDeploymentIdentity:async()=>{calls.push(['identity']);return verifiedClaims;},
    authenticateCafe:async()=>{calls.push(['auth']);return user;},
    ...Object.fromEntries(['status','prepareGoogleCheckout','startGoogleCheckout','cancelGoogleCheckout','verifyGooglePurchase','handleGoogleEvent'].map(name=>[name,async options=>{calls.push([name,options]);return {ok:true};}])),...overrides};
  const req={...requestFor(action),...request};
  const res={headers:{},setHeader(key,value){this.headers[key]=value;},status(code){this.code=code;return this;},json(body){this.body=body;return this;}};
  return {env,req,res,calls,run:async()=>{await androidPublicGoogleBillingHandler(deps)(req,res);return {res,calls};}};
}
async function noWork(options,code=503) {const h=harness(options);await h.run();assert.equal(h.res.code,code);assert.deepEqual(h.calls,[]);return h;}

for(const action of ['status','prepare','resume','start','cancel','verify','google-events','apple-events']) {
  test(`maintenance off: ${action} performs zero auth, DB, provider, settlement or reconciliation work`,async()=>{
    for(const value of [undefined,'','false','FALSE','0',false])await noWork({action,environment:{ANDROID_GOOGLE_BILLING_ACTIVE:value}});
  });
}
test('disabled boundary reads neither credentials, request data nor any lazy dependency',async()=>{
  const env=new Proxy({ANDROID_GOOGLE_BILLING_ACTIVE:'false'},{get(target,key){assert.equal(key,'ANDROID_GOOGLE_BILLING_ACTIVE');return target[key];}});
  const req=new Proxy({},{get(){assert.fail('must not inspect request while off');}}),res={setHeader(){},status(code){assert.equal(code,503);return this;},json(){return this;}};
  await androidPublicGoogleBillingHandler({route:'billing',env})(req,res);
});
test('Google events independently default off before identity/auth/provider/ledger work',async()=>{
  for(const value of [undefined,'','false','FALSE','0',false])await noWork({action:'google-events',environment:{ANDROID_GOOGLE_EVENTS_ACTIVE:value}});
});
test('receipt mutation independently defaults off for verify and events before parsing, identity or lazy work',async()=>{
  for(const action of ['verify','google-events'])for(const value of [undefined,'','false','FALSE','0',false]) {
    await noWork({action,environment:{ANDROID_GOOGLE_RECEIPTS_ACTIVE:value,ANDROID_GOOGLE_EVENTS_ACTIVE:'true'},request:{body:'not-json'}});
  }
});
test('exact built-in production project and shared DB are checked before any work',async()=>{
  for(const environment of [
    {VERCEL_PROJECT_ID:undefined},{VERCEL_PROJECT_ID:'prj_other'},{VERCEL_ENV:'preview'},{VERCEL_ENV:undefined},
    {VERCEL_TARGET_ENV:'android-testing'},{VERCEL_TARGET_ENV:'preview'},{VERCEL_TARGET_ENV:undefined},
    {NATIVE_BILLING_ENVIRONMENT:'Sandbox'},{SUPABASE_URL:'https://ojvjlvojvozvhktbclcg.supabase.co'},
    {SUPABASE_URL:`${identity.supabaseUrl}/`},{SUPABASE_PUBLISHABLE_KEY:undefined},{SUPABASE_SECRET_KEY:'legacy-jwt'},
    {ANDROID_REVIEW_ACCESS_ENABLED:'true'},{ANDROID_DIRECT_FCM_ENABLED:'not-a-flag'},
  ])await noWork({environment});
});
test('only the fixed stable API host or exact generated runtime host is accepted',async()=>{
  const h=harness({request:{headers:{host:fixture().VERCEL_URL}}});await h.run();assert.equal(h.res.code,200);
  for(const host of [undefined,'www.baristajobmatch.com','testing.baristajobmatch.com','android-testing.baristajobmatch.com',
    'baristamatch-android-other-baristamatch.vercel.app',`${identity.apiHost}:443`,`${identity.apiHost}.attacker.invalid`]) {
    await noWork({request:{headers:{host,'x-forwarded-host':identity.apiHost}}});
  }
  for(const VERCEL_URL of [undefined,identity.apiHost,'baa-fixture-baristamatch.vercel.app','baristamatch-android-fixture-other.vercel.app'])await noWork({environment:{VERCEL_URL}});
});
test('public WIF pins must match before identity, DB or provider access',async()=>{
  for(const environment of [
    {GOOGLE_PLAY_AUTH_MODE:'service_account_json'},{GOOGLE_PLAY_SERVICE_ACCOUNT_JSON:'synthetic-json'},
    {GOOGLE_PLAY_WIF_PROJECT_NUMBER:'1'},{GOOGLE_PLAY_WIF_PROVIDER_RESOURCE:'other'},
    {GOOGLE_PLAY_WIF_SERVICE_ACCOUNT_EMAIL:'publisher-fixture@fixture-project.iam.gserviceaccount.com'},
    {GOOGLE_PLAY_WIF_VERCEL_ISSUER:'https://oidc.vercel.com'},{GOOGLE_PLAY_WIF_VERCEL_AUDIENCE:'https://vercel.com/other'},
    {GOOGLE_PLAY_WIF_VERCEL_CUSTOM_ENVIRONMENT_ID:''},{GOOGLE_PLAY_WIF_VERCEL_CUSTOM_ENVIRONMENT_ID:'env_fixture'},
    {GOOGLE_PLAY_PRODUCT_ID:'other'},{GOOGLE_PLAY_BASE_PLAN_ID:'other'},
  ])await noWork({environment});
});
test('signed team/project/subject/environment claims fail closed before account or DB work',async()=>{
  for(const mutation of [
    {iss:'https://oidc.vercel.com/other'},{aud:[identity.audience]},{sub:identity.subject.replace('production','preview')},
    {owner_id:'team_other'},{project_id:'prj_other'},{environment:'preview'},
    {custom_environment_id:null},{custom_environment_id:''},{custom_environment_id:'env_fixture'},
    {exp:timestamp/1000},{iat:timestamp/1000+1},{nbf:timestamp/1000+1},{exp:timestamp/1000+86401},
    {iat:undefined},{nbf:1.5},
  ]) {
    const h=harness({verifiedClaims:{...claims(),...mutation}});await h.run();assert.equal(h.res.code,503);assert.deepEqual(h.calls,[['identity']]);
  }
});
test('a missing or failed real signature verifier never falls back to local env/caller claims',async()=>{
  for(const verifyDeploymentIdentity of [undefined,async()=>{throw Error('synthetic-private-token');}]) {
    const h=harness({overrides:{verifyDeploymentIdentity}});await h.run();assert.equal(h.res.code,503);assert.deepEqual(h.calls,[]);assert.equal(JSON.stringify(h.res.body).includes('synthetic-private-token'),false);
  }
});
test('unsupported Apple/event/resume actions and wrong methods are rejected without work',async()=>{
  for(const action of ['resume','apple-events','acknowledge','other'])await noWork({action},404);
  await noWork({request:{method:'POST'}},405);
  await noWork({request:{query:{action:['status']}}},404);
  await noWork({request:{query:{action:'status',provider:'apple'}}},404);
});
test('cancel independently needs receipt processing but remains available with new sales off',async()=>{
  await noWork({action:'cancel'});
  const h=harness({action:'cancel',environment:{ANDROID_GOOGLE_RECEIPTS_ACTIVE:'true'}});await h.run();
  assert.equal(h.res.code,200);assert.equal(h.calls[2][0],'cancelGoogleCheckout');
  assert.equal(h.calls[2][1].reason,'user-cancelled');assert.equal(h.calls[2][1].configuration.newSalesEnabled,false);
});
test('sales flags alone never enable prepare/start before full conflict readiness',async()=>{
  for(const action of ['prepare','start']) {
    await noWork({action,environment:{BILLING_ENABLED:'true',NATIVE_PURCHASES_ENABLED:'true',ANDROID_GOOGLE_RECEIPTS_ACTIVE:'true',ANDROID_STRIPE_READ_RESTRICTED_KEY:'rk_live_fixture',ANDROID_STRIPE_ACCOUNT_ID:'acct_fixture',ANDROID_STRIPE_MONTHLY_PRICE_ID:'price_fixture'}},409);
    for(const key of ['BILLING_ENABLED','NATIVE_PURCHASES_ENABLED'])await noWork({action,environment:{BILLING_ENABLED:'true',NATIVE_PURCHASES_ENABLED:'true',ANDROID_GOOGLE_RECEIPTS_ACTIVE:'true',ANDROID_STRIPE_READ_RESTRICTED_KEY:'rk_live_fixture',ANDROID_STRIPE_ACCOUNT_ID:'acct_fixture',ANDROID_STRIPE_MONTHLY_PRICE_ID:'price_fixture',[key]:'false'},overrides:{newCheckoutReady:true}},409);
  }
});
test('Google-only product/body gates reject Apple and overrides before identity/account work',async()=>{
  for(const action of ['prepare','start']) {
    for(const body of [{...selection(),provider:'apple'}, {...selection(),productId:'other'}, {...selection(),basePlanId:'other'},
      {...selection(),storefront:'USA'}, {...selection(),extra:'override'}, {...selection(),attemptId:'not-a-uuid'}]) {
      await noWork({action,request:{body},environment:{BILLING_ENABLED:'true',NATIVE_PURCHASES_ENABLED:'true',ANDROID_GOOGLE_RECEIPTS_ACTIVE:'true',ANDROID_STRIPE_READ_RESTRICTED_KEY:'rk_live_fixture',ANDROID_STRIPE_ACCOUNT_ID:'acct_fixture',ANDROID_STRIPE_MONTHLY_PRICE_ID:'price_fixture'},overrides:{newCheckoutReady:true}},400);
    }
  }
  for(const body of [{provider:'apple',proof:'synthetic-proof'},{provider:'google',proof:''},{provider:'google',proof:'x',accountId:userId},[],null,'{'])await noWork({action:'verify',environment:{ANDROID_GOOGLE_RECEIPTS_ACTIVE:'true'},request:{body}},400);
});
test('active status calls one account-bound status adapter after verified platform identity and cafe auth',async()=>{
  const h=harness();await h.run();assert.equal(h.res.code,200);assert.deepEqual(h.calls.map(row=>row[0]),['identity','auth','status']);
  assert.deepEqual(h.calls[2][1].account,{id:userId,role:'cafe_owner_manager',suspendedAt:null,email:null,emailConfirmed:false});
  assert.equal(h.calls[2][1].configuration.environment,'Production');assert.equal(h.calls[2][1].configuration.newSalesEnabled,false);
  assert.equal(h.res.headers['Cache-Control'],'no-store');assert.equal(JSON.stringify(h.res.body).includes('sb_secret'),false);
});
test('missing/wrong/mismatched/suspended account never invokes status or purchase adapters',async()=>{
  for(const [user,code] of [[null,401],[{...cafe(),id:'invalid'},403],[{id:userId,profile:{id:'other',role:'cafe_owner_manager'}},403],
    [{id:userId,profile:{id:userId,role:'barista'}},403],[{id:userId,profile:{id:userId,role:'cafe_owner_manager',suspended_at:'2026-10-12'}},403]]) {
    const h=harness({user});await h.run();assert.equal(h.res.code,code);assert.deepEqual(h.calls.map(row=>row[0]),['identity','auth']);
  }
});
test('existing Google receipt reconciliation remains available with new sales off when separately active',async()=>{
  const h=harness({action:'verify',environment:{ANDROID_GOOGLE_RECEIPTS_ACTIVE:'true'}});await h.run();assert.equal(h.res.code,200);
  assert.deepEqual(h.calls.map(row=>row[0]),['identity','auth','verifyGooglePurchase']);
  assert.equal(h.calls[2][1].proof,'synthetic-proof');assert.equal(h.calls[2][1].configuration.newSalesEnabled,false);
});
test('explicit synthetic ready checkout delegates only Google selection and keeps account/production pins',async()=>{
  for(const action of ['prepare','start']) {
    const h=harness({action,environment:{BILLING_ENABLED:'true',NATIVE_PURCHASES_ENABLED:'true',ANDROID_GOOGLE_RECEIPTS_ACTIVE:'true',ANDROID_STRIPE_READ_RESTRICTED_KEY:'rk_live_fixture',ANDROID_STRIPE_ACCOUNT_ID:'acct_fixture',ANDROID_STRIPE_MONTHLY_PRICE_ID:'price_fixture'},overrides:{newCheckoutReady:true}});await h.run();
    assert.equal(h.res.code,200);assert.equal(h.calls[2][0],action==='prepare'?'prepareGoogleCheckout':'startGoogleCheckout');
    assert.equal(h.calls[2][1].selection.provider,'google');assert.equal(h.calls[2][1].account.id,userId);assert.equal(h.calls[2][1].configuration.environment,'Production');
  }
});
test('explicit event gate requires exact RTDN configuration and routes no user auth or sales work',async()=>{
  const environment={ANDROID_GOOGLE_RECEIPTS_ACTIVE:'true',ANDROID_GOOGLE_EVENTS_ACTIVE:'true',GOOGLE_PLAY_PUSH_AUDIENCE:`https://${identity.apiHost}/api/native-purchases?action=google-events`,
    GOOGLE_PLAY_PUSH_SERVICE_ACCOUNT_EMAIL:'baristamatch-rtdn-public@baristamatch.iam.gserviceaccount.com'};
  for(const mutation of [{GOOGLE_PLAY_PUSH_AUDIENCE:undefined},{GOOGLE_PLAY_PUSH_AUDIENCE:'https://android-testing.baristajobmatch.com/api/native-purchases?action=google-events'},
    {GOOGLE_PLAY_PUSH_SERVICE_ACCOUNT_EMAIL:undefined},{GOOGLE_PLAY_PUSH_SERVICE_ACCOUNT_EMAIL:'other@fixture-project.iam.gserviceaccount.com'}])await noWork({action:'google-events',environment:{...environment,...mutation}});
  const h=harness({action:'google-events',environment});await h.run();assert.equal(h.res.code,200);assert.deepEqual(h.res.body,{received:true});
  assert.deepEqual(h.calls.map(row=>row[0]),['identity','handleGoogleEvent']);assert.equal(h.calls[1][1].configuration.newSalesEnabled,false);
});
test('configuration and request body stay captured through asynchronous identity verification',async()=>{
  const h=harness({action:'verify',environment:{ANDROID_GOOGLE_RECEIPTS_ACTIVE:'true'}});
  h.run=async()=>androidPublicGoogleBillingHandler({route:'purchases',env:h.env,now:()=>timestamp,
    verifyDeploymentIdentity:async()=>{h.env.SUPABASE_URL='https://attacker.invalid';h.env.GOOGLE_PLAY_PRODUCT_ID='other';h.req.body.provider='apple';h.req.body.proof='other';return claims();},
    authenticateCafe:async(req,configuration)=>{assert.equal(configuration.supabase.url,identity.supabaseUrl);assert.equal(Object.isFrozen(configuration.supabase),true);return cafe();},
    verifyGooglePurchase:async options=>{assert.equal(options.proof,'synthetic-proof');assert.equal(options.configuration.productId,identity.productId);return {ok:true};},
  })(h.req,h.res);
  await h.run();assert.equal(h.res.code,200);
});
test('website conflict maps to 409 while provider/internal errors remain generic and unlogged',async t=>{
  for(const method of ['log','warn','error'])t.mock.method(console,method,()=>assert.fail('must not log private error'));
  for(const code of ['WEBSITE_BILLING_EXISTS','PROVIDER_UNAVAILABLE']) {
    const h=harness({overrides:{status:async()=>{throw Object.assign(Error('synthetic-private-data'),{code});}}});await h.run();
    assert.equal(h.res.code,code==='WEBSITE_BILLING_EXISTS'?409:503);assert.equal(JSON.stringify(h.res.body).includes('synthetic-private-data'),false);
  }
});
test('configuration remains pure and inactive settings do not require credentials',()=>{
  assert.equal(readAndroidPublicBillingConfiguration({ANDROID_GOOGLE_BILLING_ACTIVE:'false'},undefined),null);
});
