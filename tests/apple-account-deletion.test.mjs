import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import handler, { appleDisconnectRequired } from '../api/delete-account.js';
import { clearDeletedSession, finishAccountDeletion, clearDeletionReceipt, getDeletionReceipt } from '../mobile/lib/accountDeletion.ts';

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const response = (value, status=200) => new Response(JSON.stringify(value), { status });

test('Apple detection uses verified identity and app metadata, including linked providers', () => {
  for (const user of [
    { identities: [{ provider: 'apple' }] },
    { identities: [{ provider: 'google' }, { provider: 'apple' }] },
    { app_metadata: { provider: 'apple' } },
    { app_metadata: { providers: ['email', 'apple'] } },
  ]) assert.equal(appleDisconnectRequired(user), true);
});
test('Apple detection ignores editable metadata and malformed values', () => {
  for (const user of [null, {}, { user_metadata: { provider: 'apple', providers: ['apple'] } },
    { identities: {}, app_metadata: { providers: 'apple' } }, { identities: [null, { provider: 'google' }] }]) {
    assert.equal(Boolean(appleDisconnectRequired(user)), false);
  }
});
async function callHandler(t, { user = { id: USER }, profiles = [], subscriptions = [], lockRows = [{ id: USER }], deletionStatus = 200, body = {} } = {}) {
  const keys = ['SUPABASE_URL', 'SUPABASE_PUBLISHABLE_KEY', 'SUPABASE_SECRET_KEY'];
  const previous = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  const old = globalThis.fetch;
  Object.assign(process.env, { SUPABASE_URL: 'https://project.supabase.co', SUPABASE_PUBLISHABLE_KEY: 'public-test', SUPABASE_SECRET_KEY: 'sb_secret_test' });
  t.after(() => { globalThis.fetch = old; for (const key of keys) previous[key] === undefined ? delete process.env[key] : process.env[key] = previous[key]; });
  const calls = [];
  globalThis.fetch = async (url, options={}) => {
    calls.push([url, options]); const parsed = new URL(url); const p = parsed.pathname;
    if (p === '/auth/v1/user') return response(user);
    if (p === '/rest/v1/rpc/claim_stripe_deletion') return response('claimed');
    if (p === '/rest/v1/rpc/release_stripe_checkout') return response(true);
    if (p === '/rest/v1/cafe_subscriptions') return response(subscriptions);
    if (p === '/rest/v1/profiles') {
      if (options.method === 'PATCH') return response(parsed.searchParams.get('suspended_at') === 'is.null' ? lockRows : []);
      return response(profiles);
    }
    if (p.startsWith('/storage/v1/object/list/')) return response([]);
    if (p === `/auth/v1/admin/users/${USER}` && options.method === 'DELETE') return response({}, deletionStatus);
    throw new Error('Unexpected request');
  };
  const res = { statusCode: 0, body: null, setHeader() {}, status(code) { this.statusCode=code; return this; }, json(value) {this.body=value; return this;} };
  await handler({ method: 'POST', headers: { authorization: 'Bearer test-session' }, body: { confirmation: 'DELETE', ...body } }, res);
  return { res, calls };
}
test('Apple account deletion completes and returns explicit manual follow-up, never fake revocation', async t => {
  const {res,calls} = await callHandler(t, {
    user:{id:USER, identities:[{provider:'apple'}]},
    profiles:[{role:'cafe_owner_manager',suspended_at:null}]
  });
  assert.equal(res.statusCode,200); assert.deepEqual(res.body,{success:true,appleRevocation:'manual_required'});
  assert.ok(calls.at(-1)[0].endsWith(USER));
  assert.equal(calls.some(([url])=>url.includes('apple.com')),false,'Supabase tokens must not be sent to Apple');
  const lockIndex=calls.findIndex(([url,options])=>new URL(url).pathname==='/rest/v1/profiles'&&options.method==='PATCH');
  const billingIndex=calls.findIndex(([url])=>new URL(url).pathname==='/rest/v1/cafe_subscriptions');
  assert.ok(lockIndex>=0&&lockIndex<billingIndex,'the cafe must be suspended before current billing is read');
  assert.equal(new URL(calls[lockIndex][0]).searchParams.get('suspended_at'),'is.null');
  assert.equal(Number.isNaN(Date.parse(JSON.parse(calls[lockIndex][1].body).suspended_at)),false);
});
test('ordinary deletion is unaffected by forged Apple flags in the request or editable metadata', async t => {
  const {res} = await callHandler(t, {user:{id:USER,user_metadata:{provider:'apple'}},body:{appleRevocation:'revoked',provider:'apple',user_id:OTHER}});
  assert.deepEqual(res.body,{success:true,appleRevocation:'not_applicable'});
});
test('failed deletion does not return success or an Apple completion result', async t => {
  const {res,calls} = await callHandler(t, {
    user:{id:USER,identities:[{provider:'apple'}]},
    profiles:[{role:'cafe_owner_manager',suspended_at:null}],
    deletionStatus:503
  });
  assert.equal(res.statusCode,502); assert.equal(res.body.success,undefined); assert.equal(res.body.appleRevocation,undefined);
  const patches=calls.filter(([url,options])=>new URL(url).pathname==='/rest/v1/profiles'&&options.method==='PATCH');
  assert.equal(patches.length,2);
  const lock=JSON.parse(patches[0][1].body).suspended_at;
  assert.equal(new URL(patches[1][0]).searchParams.get('suspended_at'),`eq.${lock}`);
  assert.deepEqual(JSON.parse(patches[1][1].body),{suspended_at:null,is_discoverable:false});
});

test('native completion only records a verified successful response and strips all tokens', async () => {
  clearDeletionReceipt(); let clears=0;
  const receipt=await finishAccountDeletion(async()=>({success:true,appleRevocation:'manual_required',access_token:'private-test'}),async()=>{clears++;return true});
  assert.equal(clears,1);assert.equal(receipt.appleDisconnectRequired,true);assert.equal(receipt.localSignOutComplete,true);
  assert.doesNotMatch(JSON.stringify(receipt),/private-test|access_token/);assert.deepEqual(receipt,getDeletionReceipt());
});
test('native failures never clear a session or display a success receipt', async () => {
  for(const value of [{},{success:false},{success:'true'},null]){
    clearDeletionReceipt();let clears=0;
    await assert.rejects(finishAccountDeletion(async()=>value,async()=>{clears++;return true}),/not confirmed/);
    assert.equal(clears,0);assert.equal(getDeletionReceipt(),null);
  }
});
test('native request failure is not converted into a successful receipt', async () => {
  clearDeletionReceipt(); let clears=0;
  await assert.rejects(finishAccountDeletion(async()=>{throw new Error('request failed')},async()=>{clears++;return true}));
  assert.equal(clears,0);assert.equal(getDeletionReceipt(),null);
});
test('native logout failure preserves completed deletion without retrying the destructive request', async () => {
  clearDeletionReceipt();let requests=0;
  const result=await finishAccountDeletion(async()=>{requests++;return{success:true,appleRevocation:'manual_required'}},async()=>{throw new Error('storage unavailable')});
  assert.equal(requests,1);assert.equal(result.localSignOutComplete,false);assert.ok(getDeletionReceipt());
});
test('native receipt expires and cannot be supplied via a deep link',async t=>{
  clearDeletionReceipt();let now=1000000;t.mock.method(Date,'now',()=>now);
  await finishAccountDeletion(async()=>({success:true}),async()=>true);now+=30*60*1000;
  assert.equal(getDeletionReceipt(),null);
  assert.doesNotMatch(read('mobile/app/account-deleted.tsx'),/useLocalSearchParams|useGlobalSearchParams/);
});
test('native cleanup clears only owned auth keys without a mutable-session remote logout',async()=>{
  const removed=[],events=[];
  const result=await clearDeletedSession({getSession:async()=>({data:{session:{user:{id:USER}}}}),stopAutoRefresh:async()=>{events.push('stop')},signOut:async options=>{assert.deepEqual(options,{scope:'local'});events.push('signOut');throw new Error('network')}},{getItem:async()=>JSON.stringify({user:{id:USER}}),multiRemove:async keys=>{events.push('clear');removed.push(...keys)}},'sb-project-auth-token',USER,operation=>operation());
  assert.equal(result,true);assert.deepEqual(events,['stop','clear']);
  assert.deepEqual(removed,['sb-project-auth-token','sb-project-auth-token-code-verifier','sb-project-auth-token-user']);
});
test('native cleanup does not log out a different newly signed-in user',async()=>{
  let calls=0;
  assert.equal(await clearDeletedSession({getSession:async()=>({data:{session:{user:{id:OTHER}}}}),stopAutoRefresh:()=>{calls++},signOut:async()=>{calls++}},{getItem:async()=>JSON.stringify({user:{id:OTHER}}),multiRemove:async()=>{calls++}},'sb-project-auth-token',USER,operation=>operation()),false);
  assert.equal(calls,0);
});
test('native storage failure is not claimed as completed sign-out',async()=>{
  await assert.rejects(clearDeletedSession({getSession:async()=>({data:{session:null}}),stopAutoRefresh:()=>{},signOut:async()=>({error:{message:'offline'}})},{getItem:async()=>null,multiRemove:async()=>{throw new Error('storage')}},'sb-project-auth-token',USER,operation=>operation()),/storage/);
});

const html=read('dashboard.html');
const webHandler=html.match(/document\.getElementById\('delete-form'\)\.onsubmit=async event=>\{[\s\S]*?\n\};/)[0];
function webHarness({result={success:true,appleRevocation:'manual_required'},ok=true,storageError=false,fetchOverride,latestUser=USER,initialUser=USER}={}){
  const redirects=[],alerts=[],removed=[],stored={},calls=[];
  const button={disabled:false,textContent:''},status={textContent:''};
  const form={confirmation:{value:'DELETE'},querySelector:()=>button};
  let reads=0;
  const context={accountDeletionInProgress:false,accountDeletionCompleted:false,authStorageKey:'sb-project-auth-token',currentUser:{id:USER},
    document:{getElementById:id=>id==='delete-form'?form:status},
    localStorage:{removeItem:key=>removed.push(key)},sessionStorage:{setItem:(k,v)=>{if(storageError)throw new Error('storage');stored[k]=v}},
    location:{replace:url=>redirects.push(url)},alert:msg=>alerts.push(msg),Date,JSON,
    fetch:async(...args)=>{calls.push(args);return fetchOverride?fetchOverride():{ok,json:async()=>result}},
  };
  context.activeClient={auth:{getSession:async()=>({data:{session:{access_token:'test-token',user:{id:++reads===1?initialUser:latestUser}}}}),
    stopAutoRefresh:async()=>{},signOut:async()=>{if(!context.accountDeletionCompleted)redirects.push('/');throw new Error('deleted session')}}};
  vm.createContext(context);vm.runInContext(webHandler,context);
  return{context,redirects,alerts,removed,stored,calls,status,button,submit:()=>form.onsubmit({preventDefault(){},currentTarget:form})};
}
test('web confirmation survives SIGNED_OUT and has no tokens or account IDs in redirect/receipt',async()=>{
  const h=webHarness();await h.submit();
  assert.deepEqual(h.redirects,['/account-deleted.html']);
  const receipt=JSON.parse(h.stored['bjm-deletion-receipt-v1']);assert.equal(receipt.appleDisconnectRequired,true);assert.equal(receipt.localSignOutComplete,true);
  assert.doesNotMatch(JSON.stringify(h.stored),/test-token|11111111/);assert.equal(h.removed.length,3);
  assert.match(html,/event==='SIGNED_OUT'&&!accountDeletionCompleted/);
});
test('web requires success true, not just HTTP 200',async()=>{
  for(const result of [{},{success:false},{success:'true'}]){
    const h=webHarness({result});await h.submit();assert.equal(h.redirects.length,0);assert.equal(h.removed.length,0);assert.match(h.status.textContent,/not confirmed/);assert.equal(h.button.disabled,false);
  }
});
test('web errors leave account and session untouched',async()=>{
  const h=webHarness({ok:false,result:{error:'Try again'}});await h.submit();assert.deepEqual(h.redirects,[]);assert.equal(h.removed.length,0);assert.equal(h.status.textContent,'Try again');
});
test('web blocks a switched account before sending a destructive request',async()=>{
  const h=webHarness({initialUser:OTHER});await h.submit();assert.equal(h.calls.length,0);assert.match(h.status.textContent,/account changed/);
});
test('web duplicate submissions send exactly one deletion request',async()=>{
  let finish;const h=webHarness({fetchOverride:()=>new Promise(resolve=>{finish=resolve})});
  const pending=h.submit();await new Promise(resolve=>setImmediate(resolve));await h.submit();assert.equal(h.calls.length,1);
  finish({ok:true,json:async()=>({success:true})});await pending;
});
test('web preserves another account that signed in while deletion was in flight',async()=>{
  const h=webHarness({latestUser:OTHER});await h.submit();assert.equal(h.removed.length,0);assert.equal(JSON.parse(h.stored['bjm-deletion-receipt-v1']).localSignOutComplete,false);
});
test('blocked browser receipt storage still tells user deletion completed and Apple needs follow-up',async()=>{
  const h=webHarness({storageError:true});await h.submit();assert.equal(h.alerts.length,1);assert.match(h.alerts[0],/not automatically disconnected/);assert.deepEqual(h.redirects,['/account-deleted.html']);assert.equal(h.calls.length,1);
});
function resultPage(value){
  const elements=Object.fromEntries(['result-title','result-message','local-warning','apple-guidance','apple-message'].map(id=>[id,{textContent:'generic',hidden:false}]));let consumed=false;
  vm.runInNewContext(read('account-deleted.js'),{Date,JSON,Number,document:{getElementById:id=>elements[id]},sessionStorage:{getItem:()=>value,removeItem:()=>{consumed=true}},location:{search:'?success=true&apple=revoked'}});
  return{elements,consumed};
}
test('completion page rejects missing, corrupt, expired, future and query-only receipts',()=>{
  for(const value of [null,'{','{}',JSON.stringify({createdAt:Date.now()-1800001,appleDisconnectRequired:true,localSignOutComplete:true}),JSON.stringify({createdAt:Date.now()+999999,appleDisconnectRequired:true,localSignOutComplete:true})]){
    const h=resultPage(value);assert.equal(h.elements['result-title'].textContent,'generic');assert.equal(h.consumed,false);
  }
});
test('completion page shows manual Apple guidance only for confirmed Apple deletion',()=>{
  const h=resultPage(JSON.stringify({createdAt:Date.now(),appleDisconnectRequired:true,localSignOutComplete:true}));
  assert.equal(h.elements['result-title'].textContent,'Account deleted');assert.equal(h.elements['apple-guidance'].hidden,false);assert.match(h.elements['apple-message'].textContent,/not automatically revoked/);assert.equal(h.consumed,true);
});
test('completion page separates sign-out warning and does not confuse non-Apple accounts',()=>{
  const h=resultPage(JSON.stringify({createdAt:Date.now(),appleDisconnectRequired:false,localSignOutComplete:false}));
  assert.equal(h.elements['local-warning'].hidden,false);assert.equal(h.elements['apple-guidance'].hidden,true);
});
test('native request is bound to reviewed account and duplicate taps are guarded',()=>{
  assert.match(read('mobile/lib/api.ts'),/expectedUserId && session\.user\.id !== expectedUserId/);
  assert.match(read('mobile/app/settings.tsx'),/if \(actionBusy\.current\) return/);
  assert.match(read('mobile/app/settings.tsx'),/confirmAccountDeletion\(expectedUserId\)/);
});
