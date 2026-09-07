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
test('profile save displays the database visibility and refreshes the saved search area',async()=>{
 const source=html.slice(html.indexOf("document.getElementById('profile-form').onsubmit"),html.indexOf("document.getElementById('job-cancel')"));
 const profile={cafe_name:'Cafe',avatar_url:'/photo.png',location:'Miami, FL',bio:'Coffee',cafe_address:'123 Street',open_hours:'Monday 7-5',shop_type:'Cafe',barista_preferences:['Espresso'],is_discoverable:false};
 const c=completionContext(profile,null,'cafe_owner_manager'),status={textContent:''},button={},form={querySelector:()=>button};
 const fields={name:'Cafe',location:'Miami, FL',bio:'Coffee',cafe_address:'123 Street',shop_type:'Cafe'};let refreshes=0,writes=0;
 Object.assign(c,{currentUser:{id:'test'},document:{getElementById:id=>id==='profile-form'?form:status},FormData:class{get(k){return fields[k]||''}getAll(){return ['Espresso']}},isFloridaPlace:()=>true,collectOpeningHours:()=> 'Monday 7-5',refreshMarketplaceAfterProfileSave:async()=>{refreshes++},setTimeout:()=>{},activeClient:{from:()=>({update:payload=>({eq:()=>({select:()=>({single:async()=>{writes++;return {data:{...profile,...payload,is_discoverable:false}}}})})})})}});
 vm.runInContext(source,c);await form.onsubmit({preventDefault(){},currentTarget:form});
 assert.equal(writes,2);assert.equal(refreshes,1);assert.equal(c.currentProfile.is_discoverable,false);assert.match(status.textContent,/discovery is not available/);assert.doesNotMatch(status.textContent,/ready for discovery/);assert.equal(button.disabled,false);
});
