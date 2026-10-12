import test from 'node:test';
import assert from 'node:assert/strict';
import {readPublicPushConfiguration,publicPushIdentity as id} from '../../server/android-public-notifications/configuration.mjs';
import {createPublicNotificationWorker,publicFcmMessage,createPushQueueTransport} from '../../server/android-public-notifications/worker.mjs';
import {createPublicFcmAuth} from '../../server/android-public-notifications/googleFcmAuth.mjs';
const secret=Buffer.alloc(32,7).toString('base64url');
const user='10000000-0000-4000-8000-000000000001',delivery='20000000-0000-4000-8000-000000000001',lease='30000000-0000-4000-8000-000000000001',source='40000000-0000-4000-8000-000000000001';
const fixture=()=>({ANDROID_PUBLIC_NOTIFICATIONS_ACTIVE:'true',VERCEL_PROJECT_ID:id.projectId,VERCEL_ENV:'production',VERCEL_TARGET_ENV:'production',
  VERCEL_URL:'baristamatch-android-fixture-baristamatch.vercel.app',NATIVE_BILLING_ENVIRONMENT:'Production',SUPABASE_URL:id.supabaseUrl,SUPABASE_SECRET_KEY:'sb_secret_fixture',
  ANDROID_PUBLIC_FCM_SERVICE_ACCOUNT_EMAIL:id.serviceAccountEmail,GOOGLE_PLAY_WIF_PROJECT_NUMBER:id.projectNumber,
  GOOGLE_PLAY_WIF_PROVIDER_RESOURCE:id.providerResource,GOOGLE_PLAY_WIF_VERCEL_ISSUER:id.issuer,GOOGLE_PLAY_WIF_VERCEL_AUDIENCE:id.audience,CRON_SECRET:secret});
const row=()=>({fcm_token:'fixture_native_token',recipient_id:user,notification_type:'message',route:`/chat/${source}?kind=application`,source_id:source});
const claims=()=>({iss:id.issuer,aud:id.audience,sub:id.subject,owner_id:id.ownerId,project_id:id.projectId,environment:id.environment,
  iat:Math.floor(Date.now()/1000)-5,nbf:Math.floor(Date.now()/1000)-5,exp:Math.floor(Date.now()/1000)+300});
function harness({env={},request={},responses={},error=null,provider={status:200,data:{name:'projects/baristamatch/messages/fixture'}},identity=async()=>claims()}={}) {
  const calls=[],seen=[];let claimed=false;
  const worker=createPublicNotificationWorker({env:{...fixture(),...env},verifyIdentity:async()=>{calls.push('identity');return identity();},
    createAuth:async()=>{calls.push('auth');return {getAccessToken:async()=>{calls.push('token');},request:async options=>{calls.push('send');seen.push(options);if(error)throw error;return provider;}};},
    transport:(config)=>{calls.push('transport');assert.equal(config.secretKey,'sb_secret_fixture');return async(name,args)=>{calls.push(name);seen.push(args);
      if(Object.hasOwn(responses,name))return responses[name];
      if(name==='android_public_push_poll')return {ready:true};
      if(name==='android_public_push_claim'){if(claimed)return null;claimed=true;return {delivery_id:delivery,lease_id:lease};}
      if(name==='android_public_push_revalidate')return row();
      if(name==='android_public_push_finish')return true;
    };}});
  const req={method:'GET',query:{},url:'/api/android-public-notification-worker',headers:{host:id.apiHost,authorization:`Bearer ${secret}`},...request};
  const res={headers:{},setHeader(k,v){this.headers[k]=v;},status(code){this.code=code;return this;},json(value){this.body=value;return this;}};
  return {calls,seen,res,run:()=>worker(req,res)};
}
test('default disabled performs zero identity, DB or provider access',async()=>{const h=harness({env:{ANDROID_PUBLIC_NOTIFICATIONS_ACTIVE:'false'}});await h.run();assert.equal(h.res.code,503);assert.deepEqual(h.calls,[]);});
test('public config exact project/Production/DB/Firebase identity and no legacy direct transport fallback',()=>{
  for(const change of [{VERCEL_PROJECT_ID:'prj_other'},{VERCEL_ENV:'preview'},{VERCEL_TARGET_ENV:'android-testing'},
    {NATIVE_BILLING_ENVIRONMENT:'Sandbox'},{SUPABASE_URL:'https://ojvjlvojvozvhktbclcg.supabase.co'},
    {SUPABASE_SECRET_KEY:'legacy-key'},{ANDROID_PUBLIC_FCM_SERVICE_ACCOUNT_EMAIL:'publisher@fixture.invalid'},
    {GOOGLE_PLAY_WIF_PROVIDER_RESOURCE:id.providerResource.replace('public','test')},{GOOGLE_PLAY_WIF_VERCEL_CUSTOM_ENVIRONMENT_ID:'env_fixture'},
    {ANDROID_DIRECT_FCM_ENABLED:'true'},{ANDROID_REVIEW_ACCESS_ENABLED:'true'},{CRON_SECRET:'a'.repeat(43)},
    {ANDROID_FCM_SERVICE_ACCOUNT_JSON:'{}'}])assert.throws(()=>readPublicPushConfiguration({...fixture(),...change},id.apiHost));
  for(const host of ['www.baristajobmatch.com','android-testing.baristajobmatch.com','attacker.invalid'])assert.throws(()=>readPublicPushConfiguration(fixture(),host));
  assert.ok(readPublicPushConfiguration({...fixture(),NATIVE_PURCHASES_ENABLED:'true',BILLING_ENABLED:'true'},id.apiHost));
});
test('POST/query/raw query and invalid bearer cannot reach any dependency',async()=>{
  for(const request of [{method:'POST'},{query:{limit:500}},{url:'/api/android-public-notification-worker?'},
    {headers:{host:id.apiHost,authorization:'Bearer wrong'}},{headers:{host:id.apiHost,authorization:[`Bearer ${secret}`]}}]){
    const h=harness({request});await h.run();assert.ok([401,404].includes(h.res.code));assert.deepEqual(h.calls,[]);assert.equal(h.res.headers['Cache-Control'],'no-store');
  }
});
test('signature failure stops before database/provider',async()=>{const h=harness({identity:async()=>{throw Error('synthetic secret must not be returned');}});await h.run();assert.equal(h.res.code,503);assert.deepEqual(h.calls,['identity']);assert.ok(!JSON.stringify(h.res.body).includes('secret'));});
test('uninitialized/dispatch-off queue returns counts only and never loads FCM',async()=>{const h=harness({responses:{android_public_push_poll:{ready:false}}});await h.run();assert.equal(h.res.body.disabled,true);assert.deepEqual(h.calls,['identity','transport','android_public_push_poll']);});
test('provider accepted notification is fenced by source revalidation and durable finish, with generic previews',async()=>{
  const h=harness();await h.run();assert.equal(h.res.code,200);assert.equal(h.res.body.accepted,1);
  assert.ok(h.calls.indexOf('token')<h.calls.indexOf('android_public_push_revalidate'));assert.ok(h.calls.indexOf('android_public_push_revalidate')<h.calls.indexOf('send'));
  assert.deepEqual(h.seen.find(x=>x.p_outcome),{p_delivery_id:delivery,p_lease_id:lease,p_outcome:'accepted'});
  const send=h.seen.find(x=>x.url);assert.equal(send.retry,false);assert.equal(send.maxRedirects,0);assert.equal(send.data.message.notification.body,'Open BaristaMatch to read it.');
  assert.equal(JSON.parse(send.data.message.data.body).recipientUserId,user);assert.equal(send.data.message.android.restricted_package_name,id.packageName);
  assert.ok(!JSON.stringify(h.res.body).includes('fixture_native_token'));assert.equal(h.res.headers['Cache-Control'],'no-store');
});
test('owner/version/source mismatch skips instead of sending',async()=>{const h=harness({responses:{android_public_push_revalidate:null}});await h.run();assert.equal(h.res.body.skipped,1);assert.ok(!h.calls.includes('send'));assert.equal(h.seen.find(x=>x.p_outcome).p_outcome,'skipped');});
for(const [name,error,result] of [['unregistered',{response:{status:404,data:{error:{details:[{'@type':'type.googleapis.com/google.firebase.fcm.v1.FcmError',errorCode:'UNREGISTERED'}]}}}},'invalid'],
  ['transient',{response:{status:429}},'retry'],['uncertain network',Error('private request token never output'),'retry'],['malformed payload',{response:{status:400}},'dead']])
  test(`${name} has bounded durable result, never raw error/token logging`,async()=>{const h=harness({error});await h.run();assert.equal(h.res.code,200);assert.equal(h.seen.find(x=>x.p_outcome).p_outcome,result);assert.ok(!JSON.stringify(h.res.body).includes('private'));});
test('malformed provider success retries; lost finish response leaves lease for recovery and returns generic failure',async()=>{
  const h=harness({provider:{status:200,data:{name:'untrusted'}}});await h.run();assert.equal(h.res.body.retried,1);
  const f=harness({responses:{android_public_push_finish:false}});await f.run();assert.equal(f.res.code,503);assert.ok(!JSON.stringify(f.res.body).includes('token'));
});
test('payload rejects unsafe destinations and arbitrary type; all four allowed routes use only validated routing fields',()=>{
  for(const change of [{route:'https://attacker.invalid'},{route:'/chat/invalid?kind=application'},{notification_type:'job'},
    {recipient_id:'not-a-user'},{fcm_token:'a b'},{source_id:'not-a-source'}])assert.throws(()=>publicFcmMessage({...row(),...change}));
  for(const [type,route] of [['application','/candidates'],['match','/matches'],['message',`/chat/${source}?kind=discovery`]]){
    const payload=publicFcmMessage({...row(),notification_type:type,route,body:'private original body',title:'private source name'});
    assert.ok(!JSON.stringify(payload).includes('private'));assert.equal(typeof payload.message.data.body,'string');
  }
});
test('queue transport pins exact DB/RPC, disallows redirects/extra headers and sanitizes failure',async()=>{
  let request;const transport=createPushQueueTransport({secretKey:'sb_secret_fixture'},{fetchImpl:async(url,options)=>{request={url,options};return {ok:true,text:async()=>'{"ready":false}'};}});
  assert.deepEqual(await transport('android_public_push_poll',{p_limit:200}),{ready:false});assert.equal(request.url,`${id.supabaseUrl}/rest/v1/rpc/android_public_push_poll`);
  assert.equal(request.options.redirect,'error');assert.deepEqual(Object.keys(request.options.headers).sort(),['Content-Type','apikey']);
  await assert.rejects(transport('native_billing_apply',{}));
  const fail=createPushQueueTransport({secretKey:'sb_secret_fixture'},{fetchImpl:async()=>{throw Error('secret request body');}});await assert.rejects(fail('android_public_push_claim',{}),{message:'Android notifications are temporarily unavailable.'});
});
test('messaging-only factory pins public FCM SA/provider and rejects wrong signed claims/fallback source',async()=>{
  let options;let current=claims(),context={'x-vercel-oidc-token':'signed-fixture'};
  await createPublicFcmAuth({loadGoogle:async()=>({IdentityPoolClient:class{constructor(o){options=o;}}}),
    loadOidc:async()=>({getContext:()=>({headers:context}),verifyVercelOidcToken:async()=>({payload:current})})});
  assert.deepEqual(options.scopes,['https://www.googleapis.com/auth/firebase.messaging']);assert.ok(options.service_account_impersonation_url.includes(id.serviceAccountEmail));
  assert.equal(await options.subject_token_supplier.getSubjectToken(),'signed-fixture');
  for(const change of [{project_id:'prj_other'},{owner_id:'team_other'},{environment:'preview'},{sub:'owner:other'},
    {custom_environment_id:'env_fixture'},{aud:[id.audience]},{exp:0},{iat:Math.floor(Date.now()/1000)+100}]){current={...claims(),...change};await assert.rejects(options.subject_token_supplier.getSubjectToken());}
  current=claims();context={};process.env.VERCEL_OIDC_TOKEN='untrusted-fallback';try{await assert.rejects(options.subject_token_supplier.getSubjectToken());}finally{delete process.env.VERCEL_OIDC_TOKEN;}
});
