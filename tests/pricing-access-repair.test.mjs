import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const read=name=>readFileSync(new URL(`../${name}`,import.meta.url),'utf8');
const gate=read('cafe-account-gate.js'),pricing=read('pricing.html'),welcome=read('cafe-trial.html');
const inline=html=>[...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(m=>m[1]).find(s=>s.includes('BaristaMatchCafeGate.authorize'));
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const session={user:{id:'cafe-test',user_metadata:{role:'cafe_owner_manager'}}};
function gateHarness(options={}){
 const redirects=[],reads=[];let sessionReads=0;
 const client={auth:{getSession:async()=>{sessionReads++;return options.getSession?options.getSession(sessionReads):{data:{session:Object.hasOwn(options,'session')?options.session:session}}}},from:table=>({select:columns=>({eq:(column,id)=>({maybeSingle:async()=>{reads.push({table,columns,column,id});return options.profileResult||{data:{role:'cafe_owner_manager'}}}})})})};
 const context={window:{supabase:{createClient:()=>client}},location:{replace:url=>redirects.push(url)},fetch:async()=>({ok:options.configOK!==false,json:async()=>({supabaseUrl:'https://example.invalid',supabasePublishableKey:'test'})})};
 vm.createContext(context);vm.runInContext(gate,context);return {context,client,redirects,reads,authorize:()=>context.window.BaristaMatchCafeGate.authorize()};
}
test('guests reach café signup without reading a profile or exposing a plan',async()=>{
 const h=gateHarness({session:null});assert.equal(await h.authorize(),null);assert.deepEqual(h.redirects,['/signup.html?role=cafe_owner_manager']);assert.equal(h.reads.length,0);
});
test('only the saved café role grants access, regardless of editable auth metadata',async()=>{
 for(const role of ['barista','owner_admin',null]){const h=gateHarness({profileResult:{data:{role}}});assert.equal(await h.authorize(),null);assert.deepEqual(h.redirects,['/dashboard.html'])}
 const h=gateHarness();assert.equal((await h.authorize()).client,h.client);assert.deepEqual(h.reads,[{table:'profiles',columns:'role',column:'id',id:'cafe-test'}]);
});
test('incomplete signup goes to setup and account failures never authorize',async()=>{
 const missing=gateHarness({profileResult:{data:null}});assert.equal(await missing.authorize(),null);assert.deepEqual(missing.redirects,['/signup.html?complete=1']);
 for(const options of [{configOK:false},{profileResult:{error:{code:'42501'}}},{getSession:async()=>({error:new Error('Expired')})}])await assert.rejects(gateHarness(options).authorize());
});
test('sign-out or switching accounts while checking a role prevents stale authorization',async()=>{
 for(const latest of [null,{user:{id:'another-account'}}]){const h=gateHarness({getSession:async count=>({data:{session:count===1?session:latest}})});assert.equal(await h.authorize(),null);assert.deepEqual(h.redirects,['/login.html'])}
});
function pageHarness(html,authorize){
 const elements={};for(const id of ['status','retry','cafe-plans','start','account-help'])elements[id]={hidden:id==='cafe-plans'||id==='retry',disabled:id==='start',textContent:''};
 const redirects=[],events={};const context={window:{BaristaMatchCafeGate:{authorize},addEventListener:(name,fn)=>events[name]=fn},document:{getElementById:id=>elements[id]},location:{replace:url=>redirects.push(url)}};
 vm.createContext(context);vm.runInContext(inline(html),context);return {elements,redirects,events,context};
}
test('old pricing page contains no prices and opens Subscription only after café authorization',async()=>{
 assert.doesNotMatch(pricing,/\$\d|class="plans"|FOUNDER PRICE/);assert.match(pricing,/<meta name="robots" content="noindex,nofollow">/);
 for(const account of [null,{client:{}}]){const h=pageHarness(pricing,async()=>account);await tick();assert.deepEqual(h.redirects,account?['/dashboard.html?section=subscription']:[])}
 const failed=pageHarness(pricing,async()=>{throw new Error('Offline')});await tick();assert.equal(failed.elements.retry.hidden,false);assert.match(failed.elements.status.textContent,/Offline/);
});
test('welcome prices remain hidden and actions disabled during slow, failed and unauthorized checks',async()=>{
 assert.match(welcome,/id="cafe-plans" hidden/);assert.match(welcome,/\[hidden\]\{display:none!important\}/);assert.match(welcome,/id="start"[^>]*disabled/);
 let finish;const pending=pageHarness(welcome,()=>new Promise(resolve=>finish=resolve));
 assert.equal(pending.elements['cafe-plans'].hidden,true);await pending.elements.start.onclick({currentTarget:pending.elements.start});assert.deepEqual(pending.redirects,[]);
 finish(null);await tick();assert.equal(pending.elements['cafe-plans'].hidden,true);assert.equal(pending.elements.start.disabled,true);
 const failed=pageHarness(welcome,async()=>{throw new Error('Offline')});await tick();assert.equal(failed.elements['cafe-plans'].hidden,true);assert.equal(failed.elements.start.disabled,true);assert.equal(failed.elements.retry.hidden,false);
});
test('verified café can proceed once; sign-out immediately hides the welcome prices',async()=>{
 let authEvent,resolveRpc,rpcCalls=0;const client={auth:{onAuthStateChange:fn=>{authEvent=fn;return {data:{subscription:{unsubscribe(){}}}}}},rpc:()=>{rpcCalls++;return new Promise(resolve=>resolveRpc=resolve)}};
 const h=pageHarness(welcome,async()=>({client,session}));await tick();assert.equal(h.elements['cafe-plans'].hidden,false);assert.equal(h.elements.start.disabled,false);
 const first=h.elements.start.onclick({currentTarget:h.elements.start});await h.elements.start.onclick({currentTarget:h.elements.start});assert.equal(rpcCalls,1);
 authEvent('SIGNED_OUT');assert.equal(h.elements['cafe-plans'].hidden,true);assert.equal(h.elements.start.disabled,true);resolveRpc({});await first;assert.deepEqual(h.redirects,['/login.html']);
});
test('welcome retries restore access after a failed check and reload checks hide cached plans',async()=>{
 let calls=0;const client={auth:{onAuthStateChange:()=>({data:{subscription:{unsubscribe(){}}}})}};
 const h=pageHarness(welcome,async()=>{if(++calls===1)throw new Error('Offline');return {client,session}});await tick();assert.equal(h.elements['cafe-plans'].hidden,true);
 await h.elements.retry.onclick();assert.equal(h.elements['cafe-plans'].hidden,false);
 h.events.pageshow({persisted:true});assert.equal(h.elements['cafe-plans'].hidden,true);await tick();assert.equal(h.elements['cafe-plans'].hidden,false);
});
test('Subscription deep link is allowed only for a café account',()=>{
 const dashboard=read('dashboard.html'),context={URLSearchParams};vm.createContext(context);vm.runInContext(dashboard.slice(dashboard.indexOf('function billingReturnState('),dashboard.indexOf('Object.defineProperty(sectionPages')),context);vm.runInContext(dashboard.slice(dashboard.indexOf('function initialDashboardSection('),dashboard.indexOf('async function start(){')),context);
 assert.equal(context.initialDashboardSection('cafe_owner_manager','?section=subscription'),'Subscription');
 assert.equal(context.initialDashboardSection('cafe_owner_manager','?billing=success&session_id=cs_test_example'),'Subscription');
 assert.equal(context.initialDashboardSection('cafe_owner_manager','?billing=canceled'),'Subscription');
 assert.equal(context.initialDashboardSection('cafe_owner_manager','?billing=portal'),'Account Settings');
 for(const role of ['barista','owner_admin',null])assert.equal(context.initialDashboardSection(role,'?section=subscription'),'Overview');
 assert.equal(context.initialDashboardSection('cafe_owner_manager','?section=Account%20Settings'),'Overview');
 assert.match(dashboard,/\/api\/confirm-checkout-session/);
 const reconciliation=dashboard.slice(dashboard.indexOf('async function reconcileBillingReturn()'),dashboard.indexOf('async function loadAccountSubscription()'));
 assert.match(reconciliation,/response\.status===202\)\{billingReturnReconciled=false/);
 assert.match(reconciliation,/catch\(error\)\{billingReturnReconciled=false/);
 assert.ok(reconciliation.lastIndexOf("history.replaceState(null,'',destination)")>reconciliation.indexOf("result.confirmed!==true"));
 assert.match(dashboard,/billing\.canManageBilling\?'\/api\/create-portal-session':'\/api\/create-checkout-session'/);
 assert.match(dashboard,/openSection\(initialDashboardSection\(role\),view,role\)/);
});
test('switching directly to another account hides café prices and disables its action',async()=>{
 let authEvent;const client={auth:{onAuthStateChange:fn=>{authEvent=fn;return {data:{subscription:{unsubscribe(){}}}}}}};
 const h=pageHarness(welcome,async()=>({client,session}));await tick();assert.equal(h.elements['cafe-plans'].hidden,false);
 authEvent('SIGNED_IN',{user:{id:'barista-account'}});assert.equal(h.elements['cafe-plans'].hidden,true);assert.equal(h.elements.start.disabled,true);assert.deepEqual(h.redirects,['/dashboard.html']);
});
test('an expired initial session cannot reveal pricing during subscription registration',async()=>{
 const client={auth:{onAuthStateChange:fn=>{fn('INITIAL_SESSION',null);return {data:{subscription:{unsubscribe(){}}}}}}};
 const h=pageHarness(welcome,async()=>({client,session}));await tick();assert.equal(h.elements['cafe-plans'].hidden,true);assert.equal(h.elements.start.disabled,true);assert.deepEqual(h.redirects,['/login.html']);
});
