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
async function boundedWait(promise,label){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Harness never reached '+label)),1000)})])}finally{clearTimeout(timer)}}
const profileActor='11111111-1111-4111-8111-111111111111';
function profileSaveHarness(options={}){
 const source=html.slice(html.indexOf('let profileSaveInProgress='),html.indexOf("document.getElementById('job-cancel')"));
 const role=options.role||'cafe_owner_manager';
 const profile={...(role==='barista'?base:{}),id:profileActor,role,cafe_name:'Cafe',avatar_url:'/photo.png',location:'Miami, FL',bio:'Coffee',cafe_address:'123 Street',open_hours:'Monday 7-5',shop_type:'Cafe',barista_preferences:['Espresso'],is_discoverable:false};
 const c=completionContext(profile,role==='barista'?'2000-01-01':null,role),status={textContent:''},button={disabled:false,textContent:'Save profile'},cancel={disabled:false},nameInput={disabled:false,name:'name'},alreadyDisabled={disabled:true};
 const fields={name:'Cafe',location:'Miami, FL',bio:'Coffee',cafe_address:'123 Street',shop_type:'Cafe',...(role==='barista'?{date_of_birth:'2000-01-01',skills:'Espresso',experience:'Two years',pay_expectation:'$20/hour'}:{}),...options.fields},hours={value:'Monday 7-5'},attributes=new Map(),writes=[],timers=[],renders=[],mediaStages=[],requestHeaders=[],events=[];
 const firstWrite=deferred(),firstMedia=deferred();let closes=0,refreshes=0,mediaBusy=Boolean(options.mediaBusy);
 const dialog={open:true,close(){this.open=false;closes++},showModal(){this.open=true}};
 const mediaInputs=Object.fromEntries(['barista_image','cafe_image','bar_picture','video'].map(name=>[name,{name,value:fields[name]?'selected-file':'',disabled:false}]));
 const controls=[nameInput,cancel,button,alreadyDisabled,...Object.values(mediaInputs)],initialDisabled=controls.map(control=>control.disabled),form={elements:mediaInputs,querySelector:()=>button,querySelectorAll:()=>controls,setAttribute:(key,value)=>attributes.set(key,value),removeAttribute:key=>attributes.delete(key)};
 const elements={'profile-form':form,'profile-status':status,'profile-cancel':cancel,'profile-dialog':dialog};
 function request(table,kind,payload){let executed;const headers={},filters=[];return{
  eq(column,value){filters.push([column,value]);return this},select(){return this},single(){return this},setHeader(name,value){headers[name]=value;return this},
  then(resolve,reject){executed||=(async()=>{
   assert.equal(headers.Authorization,'Bearer synthetic-profile-owner');requestHeaders.push({...headers});
   if(table==='profile_demographics'){assert.equal(kind,'upsert');assert.equal(payload.user_id,profileActor);return {data:payload};}
   assert.equal(table,'profiles');assert.equal(kind,'update');assert.deepEqual(filters,[['id',profileActor]]);
   assert(!Object.hasOwn(payload,'avatar_url'));assert(!Object.hasOwn(payload,'bar_picture_url'));assert(!Object.hasOwn(payload,'video_path'));
   writes.push(payload);events.push('profile-write-'+writes.length);firstWrite.resolve();const result=await options.write?.(writes.length,payload);
   return result||{data:{...profile,...payload,id:profileActor,role,is_discoverable:Boolean(options.discoverable)}};
  })();return executed.then(resolve,reject)}
 }}
 const activeClient={auth:{getSession:async()=>({data:{session:{user:{id:options.sessionUserId||profileActor},access_token:'synthetic-profile-owner',expires_at:Math.floor(Date.now()/1000)+3600}},error:null})},from:table=>({upsert:payload=>request(table,'upsert',payload),update:payload=>request(table,'update',payload)})};
 Object.assign(c,{window:{...locationWindow},currentUser:{id:profileActor},currentSection:options.section||'Café Profile',currentView:{},document:{getElementById:id=>elements[id]},FormData:class{
  constructor(){this.snapshot={...fields};if(nameInput.disabled)delete this.snapshot.name}
  get(key){return this.snapshot[key]||''}set(key,value){this.snapshot[key]=value}getAll(){return ['Espresso']}
 },isFloridaPlace:value=>Boolean(locationWindow.BaristaMatchLocation.normalizeUSLocation(value)),collectAvailability:()=> 'Weekdays',collectOpeningHours:()=>hours.value,refreshMarketplaceAfterProfileSave:async()=>{refreshes++;return await options.refresh?.()},setTimeout:callback=>timers.push(callback),openSection:section=>renders.push(section),activeClient});
 // Reuse the actual actor/session/error contract; only page-level media orchestration is a fixture.
 vm.runInContext(readFileSync(new URL('../profile-media-review.js',import.meta.url),'utf8'),c);
 c.window.BaristaMatchProfileMediaReview={...c.BaristaMatchProfileMediaReview,createController:()=>({
  isCurrent:()=>true,invalidate(){},state:()=>({reviews:[],drafts:[],busy:mediaBusy,error:'',notice:''}),refresh:async()=>{},
  stage:async(field,file)=>{assert.equal(writes.length>=2,true,'Text and visibility must be confirmed before private upload');mediaStages.push({field,file});events.push('private-media');mediaBusy=true;firstMedia.resolve();try{await options.upload?.();return {status:'pending'};}finally{mediaBusy=false;}}
 })};
 vm.runInContext(source,c);
 if(options.mediaBusy)c.ensureProfileMediaController();
 return {c,form,fields,hours,status,button,cancel,dialog,controls,initialDisabled,attributes,writes,timers,renders,mediaStages,requestHeaders,events,waitForWrite:()=>boundedWait(firstWrite.promise,'first profile write'),waitForMedia:()=>boundedWait(firstMedia.promise,'private media stage'),get closes(){return closes},get refreshes(){return refreshes},submit:()=>form.onsubmit({preventDefault(){},currentTarget:form})};
}
test('profile save displays the database visibility and refreshes the saved search area',async()=>{
 const h=profileSaveHarness();await h.submit();
 assert.equal(h.writes.length,2);assert.equal(h.refreshes,1);assert.equal(h.c.currentProfile.is_discoverable,false);assert.match(h.status.textContent,/discovery is not available/);assert.doesNotMatch(h.status.textContent,/ready for discovery/);assert.equal(h.button.disabled,false);assert.equal(h.dialog.open,true);
});
test('pending save locks Cancel, Escape and reopening and never closes a later draft',async()=>{
 const gate=deferred(),h=profileSaveHarness({discoverable:true,write:async index=>{if(index===1)await gate.promise}});
 const saving=h.submit();await h.waitForWrite();assert.equal(h.writes.length,1);assert.equal(h.attributes.get('aria-busy'),'true');assert.ok(h.controls.every(control=>control.disabled));
 await h.submit();assert.equal(h.writes.length,1);
 h.cancel.onclick();let prevented=false;h.dialog.oncancel({preventDefault(){prevented=true}});h.c.openProfileEditor();
 assert.equal(prevented,true);assert.equal(h.closes,0);assert.equal(h.dialog.open,true);
 gate.resolve();await saving;
 assert.equal(h.writes.length,2);assert.equal(h.writes[0].cafe_name,'Cafe');assert.equal(h.closes,1);assert.equal(h.timers.length,0);
 assert.deepEqual(h.controls.map(control=>control.disabled),h.initialDisabled);assert.equal(h.attributes.has('aria-busy'),false);
 h.dialog.showModal();h.fields.name='New draft';h.timers.forEach(callback=>callback());
 assert.equal(h.dialog.open,true);assert.equal(h.fields.name,'New draft');assert.equal(h.closes,1);
});
test('café draft is captured and text is saved before private media review begins',async()=>{
 const gate=deferred(),h=profileSaveHarness({discoverable:true,fields:{cafe_image:{size:10,name:'cafe.png',type:'image/png'}},upload:async()=>{await gate.promise;return {error:null}}});
 const saving=h.submit();await h.waitForMedia();assert.equal(h.writes.length,2);h.hours.value='Tuesday 10-2';h.fields.name='Changed after upload started';
 gate.resolve();await saving;
 assert.equal(h.writes[0].open_hours,'Monday 7-5');assert.equal(h.writes[0].cafe_name,'Cafe');assert.equal(h.c.currentProfile.avatar_url,'/photo.png');assert.equal(h.mediaStages.length,1);assert.equal(h.mediaStages[0].field,'avatar_url');assert.deepEqual(h.events,['profile-write-1','profile-write-2','private-media']);assert.equal(h.dialog.open,true);assert.equal(h.refreshes,0);assert.match(h.status.textContent,/submitted privately for review/);
});
test('failed save preserves the draft and restores controls for a successful retry',async()=>{
 const h=profileSaveHarness({discoverable:true,write:async index=>index===1?{error:new Error('Connection lost')}:null});
 await h.submit();assert.equal(h.closes,0);assert.equal(h.fields.name,'Cafe');assert.match(h.status.textContent,/could not save your profile.*draft is still here/i);assert.doesNotMatch(h.status.textContent,/Connection lost/);
 assert.deepEqual(h.controls.map(control=>control.disabled),h.initialDisabled);assert.equal(h.button.textContent,'Save profile');
 await h.submit();assert.equal(h.writes.length,3);assert.equal(h.closes,1);assert.match(h.status.textContent,/ready for discovery/);
});
test('an account-session mismatch prevents every text and media operation while preserving the draft',async()=>{
 const h=profileSaveHarness({sessionUserId:'22222222-2222-4222-8222-222222222222',fields:{cafe_image:{size:10,name:'cafe.png',type:'image/png'}}});await h.submit();
 assert.equal(h.writes.length,0);assert.equal(h.mediaStages.length,0);assert.equal(h.refreshes,0);assert.equal(h.fields.name,'Cafe');assert.equal(h.dialog.open,true);assert.deepEqual(h.controls.map(control=>control.disabled),h.initialDisabled);assert.match(h.status.textContent,/account changed/i);
});
test('a mismatched saved profile cannot replace this account or proceed to visibility/media writes',async()=>{
 const h=profileSaveHarness({write:async()=>({data:{id:'22222222-2222-4222-8222-222222222222',role:'cafe_owner_manager'}})});await h.submit();
 assert.equal(h.writes.length,1);assert.equal(h.c.currentProfile.id,profileActor);assert.equal(h.mediaStages.length,0);assert.equal(h.refreshes,0);assert.equal(h.dialog.open,true);assert.match(h.status.textContent,/account changed/i);
});
test('an active media check blocks a new text save without resetting or cancelling the draft',async()=>{
 const h=profileSaveHarness({mediaBusy:true});await h.submit();assert.equal(h.writes.length,0);assert.equal(h.mediaStages.length,0);assert.equal(h.fields.name,'Cafe');assert.equal(h.dialog.open,true);assert.equal(h.closes,0);assert.equal(h.attributes.has('aria-busy'),false);assert.deepEqual(h.controls.map(control=>control.disabled),h.initialDisabled);assert.match(h.status.textContent,/Wait for the current media check/);
});
test('profile completion does not replace a subsequently opened Messages conversation',async()=>{
 const gate=deferred(),started=deferred(),h=profileSaveHarness({discoverable:true,refresh:async()=>{started.resolve();await gate.promise}});
 const saving=h.submit();await boundedWait(started.promise,'marketplace refresh');h.c.currentSection='Messages';h.c.activeDiscoveryMatchId='new-conversation';gate.resolve();await saving;
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
 const context={currentRole:role,currentProfile:profile,currentDemographics:{date_of_birth:'2000-01-01'},profileSaveInProgress:false,document:{getElementById:id=>ids[id]},maximumBaristaBirthDate:()=> '2010-01-01',parseAvailability:()=>({selected:new Set(),notes:''}),parseOpeningHours:()=>({Monday:'7-5'}),OPEN_DAYS:['Monday'],ensureProfileMediaController:()=>({state:()=>({}),refresh:async()=>{}}),renderProfileMediaReview:()=>{}};
 vm.createContext(context);vm.runInContext(code,context);context.openProfileEditor();return {form,ids,context};
}

test('profile editor restores home location and independent preferred work state without modifying records',()=>{
 for(const role of ['barista','cafe_owner_manager'])for(const state of ['NY','WA','DC','AK','HI','FL']){
  const profile={...base,location:`Example City, ${state} 12345`,preferred_city:'Portland',preferred_state:'ME',preferred_postal_code:'04101',cafe_name:'Synthetic Cafe'},before=JSON.stringify(profile);
  const h=profileEditorHarness(role,profile);assert.equal(h.form.location.value,`Example City, ${state} 12345`);assert.equal(h.ids['profile-dialog'].open,true);assert.equal(JSON.stringify(profile),before);
  if(role==='barista'){assert.equal(h.form.preferred_city.value,'Portland');assert.equal(h.form.preferred_state.value,'ME');assert.equal(h.form.preferred_postal_code.value,'04101');assert.equal(h.ids['preferred-state-field'].hidden,false)}else assert.equal(h.ids['preferred-state-field'].hidden,true);
 }
});
