import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const locationWindow = {};
vm.runInNewContext(readFileSync(new URL('../us-location.js', import.meta.url), 'utf8'), { window: locationWindow });

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
 const role=options.role||'cafe_owner_manager';
 const profile={...(role==='barista'?base:{}),cafe_name:'Cafe',avatar_url:'/photo.png',location:'Miami, FL',bio:'Coffee',cafe_address:'123 Street',open_hours:'Monday 7-5',shop_type:'Cafe',barista_preferences:['Espresso'],is_discoverable:false};
 const c=completionContext(profile,role==='barista'?'2000-01-01':null,role),status={textContent:''},button={disabled:false,textContent:'Save profile'},cancel={disabled:false},nameInput={disabled:false,name:'name'},alreadyDisabled={disabled:true};
 const fields={name:'Cafe',location:'Miami, FL',bio:'Coffee',cafe_address:'123 Street',shop_type:'Cafe',...(role==='barista'?{date_of_birth:'2000-01-01',skills:'Espresso',experience:'Two years',pay_expectation:'$20/hour'}:{}),...options.fields},hours={value:'Monday 7-5'},attributes=new Map(),writes=[],timers=[],renders=[];
 let closes=0,refreshes=0;
 const dialog={open:true,close(){this.open=false;closes++},showModal(){this.open=true}};
 const controls=[nameInput,cancel,button,alreadyDisabled],form={querySelector:()=>button,querySelectorAll:()=>controls,setAttribute:(key,value)=>attributes.set(key,value),removeAttribute:key=>attributes.delete(key)};
 const elements={'profile-form':form,'profile-status':status,'profile-cancel':cancel,'profile-dialog':dialog};
 Object.assign(c,{window:locationWindow,currentUser:{id:'test'},currentSection:options.section||'Café Profile',currentView:{},document:{getElementById:id=>elements[id]},FormData:class{
  constructor(){this.snapshot={...fields};if(nameInput.disabled)delete this.snapshot.name}
  get(key){return this.snapshot[key]||''}set(key,value){this.snapshot[key]=value}getAll(){return ['Espresso']}
 },isFloridaPlace:value=>Boolean(locationWindow.BaristaMatchLocation.normalizeUSLocation(value)),collectAvailability:()=> 'Weekdays',collectOpeningHours:()=>hours.value,refreshMarketplaceAfterProfileSave:async()=>{refreshes++;return await options.refresh?.()},setTimeout:callback=>timers.push(callback),openSection:section=>renders.push(section),activeClient:{
  storage:{from:()=>({upload:async()=>options.upload?options.upload():{error:null},getPublicUrl:()=>({data:{publicUrl:'/uploaded.png'}})})},
  from:()=>({upsert:payload=>({select:()=>({single:async()=>({data:payload})})}),update:payload=>({eq:()=>({select:()=>({single:async()=>{writes.push(payload);const result=await options.write?.(writes.length,payload);return result||{data:{...profile,...payload,is_discoverable:Boolean(options.discoverable)}}}})})})})
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
test('a saved profile with failed marketplace refresh retains its confirmation and retry guidance',async()=>{
 const h=profileSaveHarness({discoverable:true,refresh:async()=>false});await h.submit();
 assert.equal(h.c.currentProfile.is_discoverable,true);assert.match(h.status.textContent,/profile saved/i);assert.match(h.status.textContent,/results could not refresh/);assert.equal(h.dialog.open,true);assert.equal(h.button.disabled,false);
});

const nationwideStates='AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY'.split(' ');
for(const role of ['barista','cafe_owner_manager'])test(`${role}: profile saves all 50 states and DC with no Florida override`,async()=>{
 for(const state of nationwideStates){
  const h=profileSaveHarness({role,fields:{location:`Example City, ${state.toLowerCase()}`}});await h.submit();
  assert.equal(h.writes.length,2,`${state}: ${h.status.textContent}`);assert.equal(h.writes[0].location,`Example City, ${state}`);
  assert.equal(h.writes[0][role==='barista'?'display_name':'cafe_name'],'Cafe');
  assert.equal(h.writes[0].preferred_state,role==='barista'?state:null);assert.equal(h.writes[0].preferred_city,role==='barista'?'Example City':null);
  assert.equal(h.refreshes,1);
 }
});

test('barista profile preserves a work city, state and ZIP different from the home state',async()=>{
 const h=profileSaveHarness({role:'barista',fields:{location:'Portland, OR',preferred_city:'Portland',preferred_state:'me',preferred_postal_code:'04101'}});await h.submit();
 assert.equal(h.writes.length,2);assert.equal(h.writes[0].location,'Portland, OR');assert.equal(h.writes[0].preferred_city,'Portland');assert.equal(h.writes[0].preferred_state,'ME');assert.equal(h.writes[0].preferred_postal_code,'04101');
});

test('invalid profile or preferred geography never starts a profile write',async()=>{
 for(const role of ['barista','cafe_owner_manager'])for(const location of ['City, ZZ','Toronto, ON','San Juan, PR','FL']){
  const h=profileSaveHarness({role,fields:{location}});await h.submit();assert.equal(h.writes.length,0,`${role}: ${location}`);assert.equal(h.button.disabled,false);
 }
 for(const fields of [{preferred_state:'ZZ'},{preferred_city:'Miami, FL',preferred_state:'NY'},{preferred_postal_code:'1234'}]){
  const h=profileSaveHarness({role:'barista',fields});await h.submit();assert.equal(h.writes.length,0,JSON.stringify(fields));assert.equal(h.button.disabled,false);
 }
});

test('unrelated profile saves preserve a legacy ZIP suffix and normalize a preferred ZIP+4',async()=>{
 for(const role of ['barista','cafe_owner_manager']){
  const h=profileSaveHarness({role,fields:{location:'Brooklyn, NY 11201-1234',preferred_postal_code:'11201-5678'}});await h.submit();
  assert.equal(h.writes.length,2,h.status.textContent);assert.equal(h.writes[0].location,'Brooklyn, NY 11201-1234');
  if(role==='barista')assert.equal(h.writes[0].preferred_postal_code,'11201');
 }
});

function profileEditorHarness(role,profile){
 const fieldNames=['name','location','bio','date_of_birth','gender_identity','preferred_city','preferred_state','preferred_postal_code','preferred_radius_miles','skills','availability_notes','experience','pay_expectation','cafe_address','shop_type'];
 const form=Object.fromEntries(fieldNames.map(name=>[name,{value:'',disabled:false,required:false}]));
 const dayInput={checked:false};form.elements={...form,open_hours_Monday:{value:''}};form.querySelector=()=>dayInput;form.querySelectorAll=()=>[];
 const ids=new Proxy({'profile-form':form},{get(target,id){return target[id]||(target[id]={hidden:false,textContent:'',firstChild:{textContent:''},dataset:{},showModal(){this.open=true}})}});
 const code=html.match(/^function openProfileEditor\(\)[^\n]+/m)[0];
 const context={currentRole:role,currentProfile:profile,currentDemographics:{date_of_birth:'2000-01-01'},profileSaveInProgress:false,document:{getElementById:id=>ids[id]},maximumBaristaBirthDate:()=> '2010-01-01',parseAvailability:()=>({selected:new Set(),notes:''}),parseOpeningHours:()=>({Monday:'7-5'}),OPEN_DAYS:['Monday']};
 vm.createContext(context);vm.runInContext(code,context);context.openProfileEditor();return {form,ids,context};
}

test('profile editor restores home location and independent preferred work state without modifying records',()=>{
 for(const role of ['barista','cafe_owner_manager'])for(const state of ['NY','WA','DC','AK','HI','FL']){
  const profile={...base,location:`Example City, ${state} 12345`,preferred_city:'Portland',preferred_state:'ME',preferred_postal_code:'04101',cafe_name:'Synthetic Cafe'},before=JSON.stringify(profile);
  const h=profileEditorHarness(role,profile);assert.equal(h.form.location.value,`Example City, ${state} 12345`);assert.equal(h.ids['profile-dialog'].open,true);assert.equal(JSON.stringify(profile),before);
  if(role==='barista'){assert.equal(h.form.preferred_city.value,'Portland');assert.equal(h.form.preferred_state.value,'ME');assert.equal(h.form.preferred_postal_code.value,'04101');assert.equal(h.ids['preferred-state-field'].hidden,false)}else assert.equal(h.ids['preferred-state-field'].hidden,true);
 }
});
