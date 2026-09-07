import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const html=readFileSync(new URL('../signup.html',import.meta.url),'utf8');
const script=[...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(m=>m[1]).find(s=>s.includes('function signupDetails'));
function element(value=''){return {value,checked:true,disabled:false,required:true,hidden:false,textContent:'',placeholder:'',firstChild:{textContent:''},classList:{toggle(){}},listeners:{},addEventListener(event,fn){this.listeners[event]=fn},closest(){return this.label||(this.label={hidden:false})}}}
async function harness({role='barista',session=null,existing=null,pending=null,authOverrides={},insertError=null}={}){
 const ids={},inputs={};for(const key of ['name','location','email','password','confirmPassword','terms'])inputs[key]=element();
 Object.assign(inputs.name,{value:'Test Person'});inputs.location.value='Miami, FL';inputs.email.value='test@example.invalid';inputs.password.value=inputs.confirmPassword.value='local-test-password';
 const submit=element(),form=element();form.elements=inputs;form.querySelector=selector=>selector==='[type="submit"]'?submit:selector==='[name="role"]:checked'?role?{value:role}:null:element();form.querySelectorAll=()=>[];form.reset=()=>{};
 for(const id of ['status','google-signup','apple-signup','name-label','signup-headline','signup-intro','signup-title','signup-copy','signup-divider','social-options'])ids[id]=element();ids['signup-form']=form;
 const redirects=[],writes=[],storage=new Map(pending?[['baristamatch_pending_signup',JSON.stringify(pending)]]:[]);let handler;
 const auth={getSession:async()=>({data:{session}}),onAuthStateChange:fn=>{handler=fn},signInWithOAuth:async()=>({}),signUp:async()=>({data:{user:{id:'new'}}}),...authOverrides};
 const client={auth,from:()=>({select:()=>({eq:()=>({maybeSingle:async()=>({data:existing})})}),insert:payload=>({select:()=>({single:async()=>{writes.push(payload);return {data:insertError?null:payload,error:insertError}}})})})};
 const context={document:{getElementById:id=>ids[id]},location:{search:'',replace:url=>redirects.push(url),assign:url=>redirects.push(url)},URLSearchParams,Date,setTimeout,localStorage:{getItem:key=>storage.get(key)||null,setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)},window:{supabase:{createClient:()=>client}},fetch:async()=>({ok:true,json:async()=>({supabaseUrl:'https://example.invalid',supabasePublishableKey:'test'})})};
 vm.createContext(context);vm.runInContext(script,context);await new Promise(resolve=>setImmediate(resolve));
 return {context,ids,inputs,submit,writes,redirects,storage,client,form,authEvent:()=>handler,send:()=>form.listeners.submit({preventDefault(){}})};
}
const signupSession={user:{id:'social-test',user_metadata:{name:'Social Person'}}};
test('new social member without pending details chooses a role instead of becoming a barista automatically',async()=>{
 const h=await harness({session:signupSession,role:null});assert.equal(h.writes.length,0);assert.equal(h.redirects.length,0);assert.match(h.ids['signup-title'].textContent,/Finish/);assert.equal(h.inputs.password.disabled,true);assert.equal(h.inputs.password.closest().hidden,true);
 await h.send();assert.equal(h.writes.length,0);assert.match(h.ids.status.textContent,/choose Barista or Café/);
});
test('social completion saves the selected cafe role and opens cafe access',async()=>{
 const h=await harness({session:signupSession,role:'cafe_owner_manager'});await h.send();assert.equal(h.writes.length,1);assert.equal(h.writes[0].role,'cafe_owner_manager');assert.deepEqual(h.redirects,['/cafe-trial.html']);
});
test('existing profile is never overwritten by pending OAuth role or name',async()=>{
 const h=await harness({session:signupSession,existing:{id:'social-test',role:'cafe_owner_manager'},pending:{role:'barista',name:'Wrong name',location:'Miami, FL',termsAccepted:true,createdAt:Date.now()}});
 assert.equal(h.writes.length,0);assert.deepEqual(h.redirects,['/dashboard.html']);assert.equal(h.storage.size,0);
});
test('fresh OAuth state can finish either role after authentication',async()=>{
 for(const role of ['barista','cafe_owner_manager']){const h=await harness({session:signupSession,pending:{role,name:'Test Cafe',location:'Miami, FL',termsAccepted:true,createdAt:Date.now()}});assert.equal(h.writes[0].role,role);assert.equal(h.storage.size,0);assert.equal(h.redirects.length,1)}
});
test('expired pending signup cannot silently assign an account type',async()=>{
 const h=await harness({session:signupSession,pending:{role:'cafe_owner_manager',name:'Expired',location:'Miami, FL',termsAccepted:true,createdAt:Date.now()-3600000}});assert.equal(h.writes.length,0);assert.equal(h.redirects.length,0);
});
test('failed email signup re-enables submit and supports retry',async()=>{
 let calls=0;const h=await harness({authOverrides:{signUp:async()=>{calls++;throw new Error('Failed to fetch')}}});await h.send();assert.equal(h.submit.disabled,false);assert.match(h.ids.status.textContent,/connection/);await h.send();assert.equal(calls,2);
});
test('duplicate pending email submissions make one request',async()=>{
 let resolve,calls=0;const h=await harness({authOverrides:{signUp:()=>{calls++;return new Promise(r=>resolve=r)}}});const first=h.send();await h.send();assert.equal(calls,1);resolve({data:{user:{id:'new'}}});await first;assert.deepEqual(h.redirects,['/verify-email.html']);
});
test('terms are required before starting either social provider',async()=>{
 let calls=0;const h=await harness({authOverrides:{signInWithOAuth:async()=>{calls++;return {}}}});h.inputs.terms.checked=false;await h.ids['google-signup'].listeners.click();await h.ids['apple-signup'].listeners.click();assert.equal(calls,0);assert.equal(h.storage.size,0);
});
test('OAuth failure clears pending details and enables retry',async()=>{
 const h=await harness({authOverrides:{signInWithOAuth:async()=>{throw new Error('offline')}}});await h.ids['google-signup'].listeners.click();assert.equal(h.storage.size,0);assert.equal(h.ids['google-signup'].disabled,false);assert.ok(h.ids.status.textContent);
});
test('profile insert failure keeps the signed-in member on setup with an actionable error',async()=>{
 const h=await harness({session:signupSession,insertError:{code:'42501'}});await h.send();assert.deepEqual(h.redirects,[]);assert.match(h.ids.status.textContent,/setup could not be saved/);assert.equal(h.submit.disabled,false);
});
