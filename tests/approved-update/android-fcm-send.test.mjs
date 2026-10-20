import test from 'node:test';
import assert from 'node:assert/strict';
import {readAndroidPushConfiguration,usesAndroidDirectFcm} from '../../server/android-push/configuration.mjs';
import {androidFcmMessage,androidNotificationData,sendAndroidPushToUsers,validFcmToken} from '../../server/android-push/send.mjs';
import {sendPushToUsers} from '../../api/_push.js';

export const env={ANDROID_DIRECT_FCM_ENABLED:'true',ANDROID_FCM_API_BASE_URL:'https://android-testing.baristajobmatch.com/api',
  ANDROID_FCM_SERVICE_ACCOUNT_EMAIL:'baristamatch-fcm-test@baristamatch.iam.gserviceaccount.com',
  SUPABASE_URL:'https://ojvjlvojvozvhktbclcg.supabase.co',SUPABASE_PUBLISHABLE_KEY:'sb_publishable_fixture',SUPABASE_SECRET_KEY:'sb_secret_fixture',
  NATIVE_BILLING_ENVIRONMENT:'Sandbox',VERCEL_ENV:'preview',VERCEL_TARGET_ENV:'android-testing',
  GOOGLE_PLAY_WIF_PROJECT_NUMBER:'397053773139',
  GOOGLE_PLAY_WIF_PROVIDER_RESOURCE:'projects/397053773139/locations/global/workloadIdentityPools/baristamatch-android-test/providers/vercel-android-testing',
  GOOGLE_PLAY_WIF_VERCEL_ISSUER:'https://oidc.vercel.com/baristamatch',GOOGLE_PLAY_WIF_VERCEL_AUDIENCE:'https://vercel.com/baristamatch',
  GOOGLE_PLAY_WIF_VERCEL_CUSTOM_ENVIRONMENT_ID:'env_fixtureAndroidOnly'};
const user='a0000000-0000-4000-8000-000000000001',other='00000000-0000-4000-8000-000000000002';
const row={fcm_token:'opaque:fcm/token+=',user_id:user,updated_at:'2026-10-11T10:00:00+00:00'};
const notice={title:'Private sender',body:'Private conversation contents',data:{route:`/chat/${other}?kind=discovery`,type:'message'}};
const response=data=>({ok:true,status:200,json:async()=>data});
function fixture({rows=[row],current,provider,cleanupFailure=false}={}) {
  const calls=[];
  const fetchImpl=async(url,options)=>{
    assert.ok(url.startsWith(`${env.SUPABASE_URL}/rest/v1/android_device_push_tokens?`));
    assert.equal(options.redirect,'error');assert.ok(options.signal instanceof AbortSignal);
    assert.equal(options.headers.apikey,'sb_secret_fixture');assert.equal(options.headers.Authorization,undefined);
    const query=new URL(url).searchParams;calls.push({kind:options.method==='PATCH'?'cleanup':'database',query,options});
    assert.equal(query.get('enabled'),'eq.true');assert.equal(query.get('platform'),'eq.android');
    assert.equal(query.get('firebase_project_id'),'eq.baristamatch');assert.equal(query.get('package_name'),'eq.com.baristajobmatch.app');
    if(options.method==='PATCH'){if(cleanupFailure)throw Error('private token must never escape');return response(null);}
    return response(query.has('fcm_token')?(current===undefined?[rows.find(r=>r.fcm_token===query.get('fcm_token').slice(3))]:current):rows);
  };
  const createAuth=async config=>{
    assert.deepEqual(config,readAndroidPushConfiguration(env));calls.push({kind:'auth'});
    return {getAccessToken:async()=>{calls.push({kind:'federation'});return {token:'synthetic-access'};},request:async options=>{
      calls.push({kind:'send',options});assert.equal(options.url,'https://fcm.googleapis.com/v1/projects/baristamatch/messages:send');
      assert.equal(options.method,'POST');assert.equal(options.timeout,10000);assert.equal(options.retry,false);assert.equal(options.maxRedirects,0);
      return provider?provider(options):{status:200,data:{name:'projects/baristamatch/messages/accepted-fixture'}};
    }};
  };
  return {calls,dependencies:{env,fetchImpl,createAuth}};
}

test('direct Android push is explicit, disabled by default and never falls back to Expo',async()=>{
  const never=()=>{throw Error('No database/auth/network expected');};
  for(const flag of [undefined,'false'])assert.deepEqual(await sendAndroidPushToUsers([user],notice,
    {env:{...env,ANDROID_DIRECT_FCM_ENABLED:flag},fetchImpl:never,createAuth:never}),{sent:0,accepted:0,failed:0,disabled:true});
  assert.equal(usesAndroidDirectFcm({VERCEL_TARGET_ENV:'android-testing'}),true);
  assert.equal(usesAndroidDirectFcm({ANDROID_DIRECT_FCM_ENABLED:'true',VERCEL_ENV:'production'}),true);
  assert.equal(usesAndroidDirectFcm({VERCEL_ENV:'production'}),false);
  await assert.rejects(sendAndroidPushToUsers([user],notice,{env:{...env,VERCEL_ENV:'production'},fetchImpl:never,createAuth:never}),{code:'CONFIGURATION'});
});

test('all deployment, database, API, key and dedicated account pins fail closed; purchase enablement is independent',()=>{
  for(const mutation of [
    {ANDROID_DIRECT_FCM_ENABLED:'1'},{VERCEL_ENV:'production'},{VERCEL_TARGET_ENV:'preview'},
    {NATIVE_BILLING_ENVIRONMENT:'Production'},
    {ANDROID_FCM_API_BASE_URL:'https://www.baristajobmatch.com/api'},{SUPABASE_URL:'https://apple-fixture.supabase.co'},
    {SUPABASE_PUBLISHABLE_KEY:'legacy-key'},{SUPABASE_SECRET_KEY:'legacy-secret'},
    {ANDROID_FCM_SERVICE_ACCOUNT_EMAIL:'baristamatch-play-test@baristamatch.iam.gserviceaccount.com'},
    {ANDROID_FCM_SERVICE_ACCOUNT_JSON:'{}'},{GOOGLE_PLAY_WIF_PROJECT_NUMBER:'other'},
    {GOOGLE_PLAY_WIF_PROVIDER_RESOURCE:env.GOOGLE_PLAY_WIF_PROVIDER_RESOURCE+'-other'},
    {GOOGLE_PLAY_WIF_VERCEL_ISSUER:'https://oidc.vercel.com'},
    {GOOGLE_PLAY_WIF_VERCEL_AUDIENCE:'https://vercel.com/other'},{GOOGLE_PLAY_WIF_VERCEL_CUSTOM_ENVIRONMENT_ID:'REPLACE_ME'},
  ])assert.throws(()=>readAndroidPushConfiguration({...env,...mutation}),{code:'CONFIGURATION'});
  for(const key of Object.keys(env))assert.throws(()=>readAndroidPushConfiguration({...env,[key]:undefined}),{code:'CONFIGURATION'},key);
  for(const enabled of ['true','false'])assert.deepEqual(readAndroidPushConfiguration({...env,
    BILLING_ENABLED:enabled,NATIVE_PURCHASES_ENABLED:enabled}),readAndroidPushConfiguration(env));
});

test('FCM data is string-only Expo54 body JSON, safe routing, recipient binding, package/channel restriction and generic message preview',()=>{
  const payload=androidFcmMessage(row,notice),message=payload.message;
  assert.deepEqual(message.notification,{title:'New message',body:'Open BaristaMatch to read it.'});
  assert.deepEqual(Object.keys(message.data),['body']);assert.equal(typeof message.data.body,'string');
  assert.deepEqual(JSON.parse(message.data.body),{route:notice.data.route,type:'message',recipientUserId:user});
  assert.equal(message.android.restricted_package_name,'com.baristajobmatch.app');
  assert.equal(message.android.notification.channel_id,'baristamatch-alerts');assert.equal(message.android.ttl,'300s');
  assert.equal(JSON.stringify(payload).includes('Private conversation'),false);
  for(const bad of [{route:'https://attacker.invalid',type:'message'},{route:'/chat/not-a-uuid?kind=discovery',type:'message'},
    {route:'/matches',type:'unknown'},{route:'/discover',type:'job',jobId:'bad'}])assert.throws(()=>androidNotificationData(bad,user),{code:'PAYLOAD'});
  const job=androidNotificationData({route:'/discover',type:'job',jobId:other,evil:'ignored'},user);
  assert.deepEqual(job,{route:'/discover',type:'job',jobId:other,recipientUserId:user});
});

test('opaque FCM token validation aligns UTF8 byte, whitespace and control bounds',()=>{
  for(const good of ['a','a'.repeat(2048),'é'.repeat(1024),'opaque/a:+=[]'])assert.equal(validFcmToken(good),true);
  for(const bad of [null,'','a'.repeat(2049),'é'.repeat(1025),'a\u00a0','a\u0085','a\u2007','a\u202f','a\ufeff','a\n','a\u0000'])assert.equal(validFcmToken(bad),false);
});

test('provider acceptance is counted only after exact token ownership/enabled/version recheck',async()=>{
  const f=fixture(),result=await sendAndroidPushToUsers([user,user.toUpperCase()],notice,f.dependencies);
  assert.deepEqual(result,{sent:1,accepted:1,failed:0,invalid:0,skipped:0,cleanupFailed:0});
  assert.deepEqual(f.calls.map(c=>c.kind),['database','auth','federation','database','send']);
  assert.equal(f.calls[3].query.get('user_id'),`eq.${user}`);assert.equal(f.calls[3].query.get('updated_at'),`eq.${row.updated_at}`);
  for(const current of [[],[{...row,user_id:other}],[{...row,updated_at:'2026-10-11T10:01:00+00:00'}]]) {
    const skipped=fixture({current}),r=await sendAndroidPushToUsers([user],notice,skipped.dependencies);
    assert.equal(r.skipped,1);assert.equal(r.accepted,0);assert.equal(skipped.calls.some(c=>c.kind==='send'),false);
  }
  for(const enabled of ['true','false']) {
    const f=fixture(),result=await sendAndroidPushToUsers([user],notice,{...f.dependencies,
      env:{...env,BILLING_ENABLED:enabled,NATIVE_PURCHASES_ENABLED:enabled}});
    assert.equal(result.accepted,1);
  }
});

test('delivery requests are limited to four workers and include a bounded abort signal',async()=>{
  let active=0,maximum=0;
  const rows=Array.from({length:9},(_,index)=>({...row,fcm_token:`synthetic-${index}`}));
  const f=fixture({rows,provider:async options=>{
    assert.ok(options.signal instanceof AbortSignal);active++;maximum=Math.max(maximum,active);
    await new Promise(resolve=>setImmediate(resolve));active--;
    return {status:200,data:{name:'projects/baristamatch/messages/accepted'}};
  }});
  assert.equal((await sendAndroidPushToUsers([user],notice,f.dependencies)).accepted,9);
  assert.equal(maximum,4);
});

test('no rows performs no auth; invalid or excessive rows fail before provider access',async()=>{
  const empty=fixture({rows:[]});assert.deepEqual(await sendAndroidPushToUsers([user],notice,empty.dependencies),{sent:0,accepted:0,failed:0});
  assert.equal(empty.calls.some(c=>c.kind==='auth'),false);
  for(const rows of [[{...row,user_id:other}],[{...row,fcm_token:'bad token'}],[{...row,updated_at:'invalid'}],Array(101).fill(row)]) {
    const f=fixture({rows});await assert.rejects(sendAndroidPushToUsers([user],notice,f.dependencies),error=>['REGISTRATION','RECIPIENT_LIMIT'].includes(error.code));
    assert.equal(f.calls.some(c=>c.kind==='auth'),false);
  }
});

test('only exact UNREGISTERED FCM error disables the same owner/version token; never logs provider secrets',async t=>{
  t.mock.method(console,'error',()=>assert.fail('No provider errors may be logged'));
  const f=fixture({provider:()=>{throw {response:{status:404,data:{error:{message:'SECRET BODY',details:[
    {'@type':'type.googleapis.com/google.firebase.fcm.v1.FcmError',errorCode:'UNREGISTERED'}]}}}};}});
  const result=await sendAndroidPushToUsers([user],notice,f.dependencies);
  assert.equal(result.invalid,1);assert.equal(result.accepted,0);assert.equal(result.failed,0);
  const cleanup=f.calls.find(c=>c.kind==='cleanup');assert.ok(cleanup);
  assert.equal(cleanup.query.get('fcm_token'),`eq.${row.fcm_token}`);assert.equal(cleanup.query.get('user_id'),`eq.${user}`);
  assert.equal(cleanup.query.get('updated_at'),`eq.${row.updated_at}`);assert.equal(JSON.parse(cleanup.options.body).enabled,false);
  const failed=fixture({cleanupFailure:true,provider:()=>{throw {response:{status:404,data:{error:{details:[
    {'@type':'type.googleapis.com/google.firebase.fcm.v1.FcmError',errorCode:'UNREGISTERED'}]}}}};}});
  assert.equal((await sendAndroidPushToUsers([user],notice,failed.dependencies)).cleanupFailed,1);
});

test('permissions, invalid arguments, quotas, malformed errors, timeouts and ambiguous acceptance fail without disabling or retries',async()=>{
  const failures=[{response:{status:400,data:{error:{details:[{'@type':'type.googleapis.com/google.firebase.fcm.v1.FcmError',errorCode:'INVALID_ARGUMENT'}]}}}},
    {response:{status:403,data:{error:{details:[{'@type':'type.googleapis.com/google.firebase.fcm.v1.FcmError',errorCode:'UNREGISTERED'}]}}}},
    {response:{status:429}},{response:{status:503}},
    {response:{status:404,data:{error:{details:{errorCode:'UNREGISTERED'}}}}},Error('SECRET TOKEN REQUEST')];
  for(const error of failures) {
    const f=fixture({provider:()=>{throw error;}}),result=await sendAndroidPushToUsers([user],notice,f.dependencies);
    assert.equal(result.failed,1);assert.equal(result.accepted,0);assert.equal(result.invalid,0);
    assert.equal(f.calls.filter(c=>c.kind==='send').length,1);assert.equal(f.calls.some(c=>c.kind==='cleanup'),false);
    assert.equal(JSON.stringify(result).includes('SECRET'),false);
  }
  for(const answer of [{status:200,data:{}},{status:200,data:{name:'projects/other/messages/accepted'}},{status:202,data:{name:'projects/baristamatch/messages/accepted'}}]) {
    const f=fixture({provider:()=>answer});assert.equal((await sendAndroidPushToUsers([user],notice,f.dependencies)).failed,1);
  }
});

test('database/auth failures expose only safe error without raw requests or keys',async()=>{
  for(const dependencies of [
    {fetchImpl:()=>{throw Error('sb_secret_fixture opaque:fcm/token+= PRIVATE');}},
    {...fixture().dependencies,createAuth:()=>{throw Error('PRIVATE JWT');}},
    {...fixture().dependencies,createAuth:()=>({getAccessToken:()=>{throw Error('PRIVATE OAuth request');},request:()=>assert.fail('No delivery after auth failure')})},
  ])await assert.rejects(sendAndroidPushToUsers([user],notice,{...fixture().dependencies,...dependencies}),error=>
    error.name==='AndroidPushError' && !/PRIVATE|sb_secret|opaque|JWT/.test(error.message));
});

test('unchanged legacy Expo transport remains in production and Apple review even with unrelated FCM config',async t=>{
  const keys=['VERCEL_TARGET_ENV','ANDROID_DIRECT_FCM_ENABLED','SUPABASE_URL','SUPABASE_SECRET_KEY'],saved=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
  try {
    process.env.SUPABASE_URL='https://apple-fixture.supabase.co';process.env.SUPABASE_SECRET_KEY='sb_secret_applefixture';
    delete process.env.ANDROID_DIRECT_FCM_ENABLED;
    for(const target of ['production','preview']) {
      process.env.VERCEL_TARGET_ENV=target;const calls=[];
      t.mock.method(globalThis,'fetch',async(url,options)=>{calls.push({url,options});
        if(url.startsWith('https://apple-fixture.supabase.co/rest/v1/device_push_tokens'))return response([{expo_push_token:'ExpoPushToken[unchanged]',user_id:user}]);
        assert.equal(url,'https://exp.host/--/api/v2/push/send');return response({data:[{status:'ok'}]});});
      assert.deepEqual(await sendPushToUsers([user],notice),{sent:1});
      const payload=JSON.parse(calls[1].options.body)[0];assert.equal(payload.body,notice.body);assert.deepEqual(payload.data,notice.data);
    }
    process.env.VERCEL_TARGET_ENV='android-testing';
    t.mock.method(globalThis,'fetch',()=>assert.fail('Disabled Android must not use Expo or database'));
    assert.equal((await sendPushToUsers([user],notice)).disabled,true);
  } finally {for(const [key,value] of Object.entries(saved)){if(value===undefined)delete process.env[key];else process.env[key]=value;}}
});


test('isolated Android sender supplies a unique recipient-bound native tag without changing the existing payload',()=>{
  const payloads=Array.from({length:12},()=>androidFcmMessage(row,notice).message);
  const tags=payloads.map(message=>message.android.notification.tag);
  assert.equal(new Set(tags).size,tags.length);
  const tag=new RegExp(`^bjm-v1:${user}:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`);
  for(const message of payloads) {
    assert.match(message.android.notification.tag,tag);
    assert.deepEqual({...message.android.notification,tag:undefined},{channel_id:'baristamatch-alerts',sound:'default',visibility:'PRIVATE',tag:undefined});
    assert.deepEqual(JSON.parse(message.data.body),{route:notice.data.route,type:'message',recipientUserId:user});
    assert.deepEqual(message.notification,{title:'New message',body:'Open BaristaMatch to read it.'});
    assert.equal(message.android.ttl,'300s'); assert.equal(message.android.restricted_package_name,'com.baristajobmatch.app');
    assert.ok(!message.android.notification.tag.includes(row.fcm_token));
  }
  assert.ok(androidFcmMessage({...row,user_id:user.toUpperCase()},notice).message.android.notification.tag.startsWith(`bjm-v1:${user}:`));
  assert.ok(androidFcmMessage({...row,user_id:other},notice).message.android.notification.tag.startsWith(`bjm-v1:${other}:`));
});
