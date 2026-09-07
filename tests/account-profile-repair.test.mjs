import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const html=readFileSync(new URL('../dashboard.html',import.meta.url),'utf8');
const completion=html.match(/const profileFields=[^\n]+/)[0]+'\n'+html.slice(html.indexOf('function validBaristaBirthDate'),html.indexOf('function trustBanner'));
const base={display_name:'Barista',avatar_url:'/photo.png',location:'Miami, FL',bio:'Coffee professional',skills:['Espresso'],availability:'Weekdays',experience:'Two years',pay_expectation:'$20/hour'};
function completionContext(profile=base,date='2000-01-01',role='barista'){
 const context={currentRole:role,currentProfile:{...profile},currentDemographics:{date_of_birth:date},Date,maximumBaristaBirthDate:()=> '2010-09-07'};
 vm.createContext(context);vm.runInContext(completion,context);return context;
}
test('completion explains the missing private age requirement without exposing its value',()=>{
 const c=completionContext(base,'');assert.ok(c.profileStrength()<100);assert.equal(c.profileVisibilityReady(),false);assert.match(c.checklist(),/private date of birth/);
 c.currentDemographics.date_of_birth='2000-01-01';assert.equal(c.profileStrength(),100);assert.equal(c.profileVisibilityReady(),true);assert.doesNotMatch(c.checklist(),/2000-01-01/);
});
test('invalid dates, underage dates and blank required values cannot show ready',()=>{
 for(const date of ['bad-date','2000-02-31','2011-01-01','1919-12-31'])assert.equal(completionContext(base,date).profileVisibilityReady(),false);
 assert.equal(completionContext({...base,bio:'   '}).profileVisibilityReady(),false);
 assert.equal(completionContext({...base,skills:['   ']}).profileVisibilityReady(),false);
});
test('cafe readiness requires cafe information instead of obsolete barista fields',()=>{
 const c=completionContext({cafe_name:'Cafe',avatar_url:'/cafe.png',location:'Miami, FL',bio:'Coffee',cafe_address:'123 Street',open_hours:'Mon 7-5',shop_type:'Cafe',barista_preferences:['Espresso'],skills:[],experience:null},null,'cafe_owner_manager');
 assert.equal(c.profileStrength(),100);assert.equal(c.profileVisibilityReady(),true);
});
test('an unknown signup role is never silently assigned to barista',async()=>{
 const code=html.slice(html.indexOf('function normalizeRole'),html.indexOf('function validBaristaBirthDate'));
 const redirects=[],c={location:{replace:url=>redirects.push(url)}};vm.createContext(c);vm.runInContext(code,c);
 assert.equal(await c.ensureProfileFromMetadata({id:'test',user_metadata:{}},{}),null);
 assert.deepEqual(redirects,['/signup.html?complete=1']);assert.equal(c.normalizeRole('owner_admin'),null);
});
test('visibility banner respects persisted availability while preserving opt-out control',()=>{
 const c=completionContext({...base,visible_to_cafes:true,is_discoverable:false,suspended_at:'2026-09-07'});
 vm.runInContext(html.slice(html.indexOf('function trustBanner'),html.indexOf('function overviewHtml')),c);
 assert.match(c.trustBanner(),/Hidden from café-owner discovery/);assert.match(c.trustBanner(),/Contact support/);assert.match(c.trustBanner(),/data-toggle-profile-visibility="false"/);assert.doesNotMatch(c.trustBanner(),/Visible to café owners/);
 c.currentProfile.suspended_at=null;c.currentProfile.is_discoverable=true;assert.match(c.trustBanner(),/Visible to café owners/);
});
function deferred(){let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve}}
function profileSaveHarness(options={}){
 const source=html.slice(html.indexOf('let profileSaveInProgress='),html.indexOf("document.getElementById('job-cancel')"));
 const profile={cafe_name:'Cafe',avatar_url:'/photo.png',location:'Miami, FL',bio:'Coffee',cafe_address:'123 Street',open_hours:'Monday 7-5',shop_type:'Cafe',barista_preferences:['Espresso'],is_discoverable:false};
 const c=completionContext(profile,null,'cafe_owner_manager'),status={textContent:''},button={disabled:false,textContent:'Save profile'},cancel={disabled:false},nameInput={disabled:false,name:'name'},alreadyDisabled={disabled:true};
 const fields={name:'Cafe',location:'Miami, FL',bio:'Coffee',cafe_address:'123 Street',shop_type:'Cafe',...options.fields},hours={value:'Monday 7-5'},attributes=new Map(),writes=[],timers=[],renders=[];
 let closes=0,refreshes=0;
 const dialog={open:true,close(){this.open=false;closes++},showModal(){this.open=true}};
 const controls=[nameInput,cancel,button,alreadyDisabled],form={querySelector:()=>button,querySelectorAll:()=>controls,setAttribute:(key,value)=>attributes.set(key,value),removeAttribute:key=>attributes.delete(key)};
 const elements={'profile-form':form,'profile-status':status,'profile-cancel':cancel,'profile-dialog':dialog};
 Object.assign(c,{currentUser:{id:'test'},currentSection:options.section||'Café Profile',currentView:{},document:{getElementById:id=>elements[id]},FormData:class{
  constructor(){this.snapshot={...fields};if(nameInput.disabled)delete this.snapshot.name}
  get(key){return this.snapshot[key]||''}getAll(){return ['Espresso']}
 },isFloridaPlace:()=>true,collectOpeningHours:()=>hours.value,refreshMarketplaceAfterProfileSave:async()=>{refreshes++;await options.refresh?.()},setTimeout:callback=>timers.push(callback),openSection:section=>renders.push(section),activeClient:{
  storage:{from:()=>({upload:async()=>options.upload?options.upload():{error:null},getPublicUrl:()=>({data:{publicUrl:'/uploaded.png'}})})},
  from:()=>({update:payload=>({eq:()=>({select:()=>({single:async()=>{writes.push(payload);const result=await options.write?.(writes.length,payload);return result||{data:{...profile,...payload,is_discoverable:Boolean(options.discoverable)}}}})})})})
 }});
 vm.runInContext(source,c);
 return {c,form,fields,hours,status,button,cancel,dialog,controls,attributes,writes,timers,renders,get closes(){return closes},get refreshes(){return refreshes},submit:()=>form.onsubmit({preventDefault(){},currentTarget:form})};
}
test('profile save displays the database visibility and refreshes the saved search area',async()=>{
 const h=profileSaveHarness();await h.submit();
 assert.equal(h.writes.length,2);assert.equal(h.refreshes,1);assert.equal(h.c.currentProfile.is_discoverable,false);assert.match(h.status.textContent,/discovery is not available/);assert.doesNotMatch(h.status.textContent,/ready for discovery/);assert.equal(h.button.disabled,false);assert.equal(h.dialog.open,true);
});
test('pending save locks Cancel, Escape and reopening and never closes a later draft',async()=>{
 const gate=deferred(),h=profileSaveHarness({discoverable:true,write:async index=>{if(index===1)await gate.promise}});
 const saving=h.submit();assert.equal(h.writes.length,1);assert.equal(h.attributes.get('aria-busy'),'true');assert.ok(h.controls.every(control=>control.disabled));
 await h.submit();assert.equal(h.writes.length,1);
 h.cancel.onclick();let prevented=false;h.dialog.oncancel({preventDefault(){prevented=true}});h.c.openProfileEditor();
 assert.equal(prevented,true);assert.equal(h.closes,0);assert.equal(h.dialog.open,true);
 gate.resolve();await saving;
 assert.equal(h.writes.length,2);assert.equal(h.writes[0].cafe_name,'Cafe');assert.equal(h.closes,1);assert.equal(h.timers.length,0);
 assert.deepEqual(h.controls.map(control=>control.disabled),[false,false,false,true]);assert.equal(h.attributes.has('aria-busy'),false);
 h.dialog.showModal();h.fields.name='New draft';h.timers.forEach(callback=>callback());
 assert.equal(h.dialog.open,true);assert.equal(h.fields.name,'New draft');assert.equal(h.closes,1);
});
test('café opening hours and fields are captured before asynchronous upload begins',async()=>{
 const gate=deferred(),h=profileSaveHarness({discoverable:true,fields:{cafe_image:{size:10,name:'cafe.png',type:'image/png'}},upload:async()=>{await gate.promise;return {error:null}}});
 const saving=h.submit();assert.equal(h.writes.length,0);h.hours.value='Tuesday 10-2';h.fields.name='Changed after upload started';
 gate.resolve();await saving;
 assert.equal(h.writes[0].open_hours,'Monday 7-5');assert.equal(h.writes[0].cafe_name,'Cafe');assert.equal(h.writes[0].avatar_url,'/uploaded.png');
});
test('failed save preserves the draft and restores controls for a successful retry',async()=>{
 const h=profileSaveHarness({discoverable:true,write:async index=>index===1?{error:new Error('Connection lost')}:null});
 await h.submit();assert.equal(h.closes,0);assert.equal(h.fields.name,'Cafe');assert.match(h.status.textContent,/Connection lost/);
 assert.deepEqual(h.controls.map(control=>control.disabled),[false,false,false,true]);assert.equal(h.button.textContent,'Save profile');
 await h.submit();assert.equal(h.writes.length,3);assert.equal(h.closes,1);assert.match(h.status.textContent,/ready for discovery/);
});
test('profile completion does not replace a subsequently opened Messages conversation',async()=>{
 const gate=deferred(),started=deferred(),h=profileSaveHarness({discoverable:true,refresh:async()=>{started.resolve();await gate.promise}});
 const saving=h.submit();await started.promise;h.c.currentSection='Messages';h.c.activeDiscoveryMatchId='new-conversation';gate.resolve();await saving;
 assert.equal(h.c.currentProfile.is_discoverable,true);assert.equal(h.c.activeDiscoveryMatchId,'new-conversation');assert.deepEqual(h.renders,[]);assert.equal(h.timers.length,0);
});
test('profile completion never rebuilds Messages even when it was the originating section',async()=>{
 const h=profileSaveHarness({discoverable:true,section:'Messages'});await h.submit();assert.deepEqual(h.renders,[]);assert.equal(h.closes,1);
});
