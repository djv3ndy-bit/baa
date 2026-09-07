import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';
import { normalizeOptionalGender, needsMediaLibraryPermission } from '../mobile/lib/profilePrivacy.ts';
const read = name => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');
const native = read('mobile/app/profile.tsx');
const web = read('dashboard.html');

test('unprovided gender is NULL, not a required field or fabricated category', () => {
  for (const value of [undefined, null, '']) assert.equal(normalizeOptionalGender(value), null);
  for (const value of ['female', 'male']) assert.equal(normalizeOptionalGender(value), value);
  for (const value of ['other', 'prefer_not_to_say', {}, [], 0, 'Female']) assert.throws(() => normalizeOptionalGender(value));
});

test('the only library permission case is original iOS video', () => {
  for (const platform of ['android', 'ios', 'web']) for (const kind of ['photo', 'bar', 'video']) {
    assert.equal(needsMediaLibraryPermission(platform, kind), platform === 'ios' && kind === 'video');
  }
});

const pickerCode = native.slice(native.indexOf('  async function pickMedia('), native.indexOf('  async function uploadAsset('));
function pickerHarness(platform, options = {}) {
  const calls = [], selected = [], alerts = [];
  const context = {
    Platform: { OS: platform }, needsMediaLibraryPermission,
    ImagePicker: {
      requestMediaLibraryPermissionsAsync: async () => { calls.push('permission'); return options.permission || { granted: true }; },
      launchImageLibraryAsync: async config => { calls.push(config); if (options.throw) throw new Error('picker unavailable'); return options.result || { canceled: false, assets: [{ uri: 'file:///selected.jpg', fileName: 'selected.jpg', mimeType: 'image/jpeg', fileSize: 120 }] }; },
      UIImagePickerPreferredAssetRepresentationMode: { Current: 'current', Compatible: 'compatible' },
    },
    Alert: { alert: (...args) => alerts.push(args) }, Linking: { openSettings() {} },
    setProfilePhoto: asset => selected.push(asset), setBarPicture: asset => selected.push(asset), setCoffeeVideo: asset => selected.push(asset),
    Date,
  };
  vm.createContext(context);vm.runInContext(stripTypeScriptTypes(pickerCode), context);
  return { calls, selected, alerts, run: kind => context.pickMedia(kind) };
}
for (const platform of ['android', 'ios']) for (const kind of ['photo', 'bar', 'video']) {
  test(`${platform} ${kind} uses minimum-scope picker and only needed permissions`, async () => {
    const h = pickerHarness(platform);await h.run(kind);
    assert.equal(h.calls.includes('permission'), platform === 'ios' && kind === 'video');
    const config = h.calls.find(c => typeof c === 'object');
    assert.equal(config.legacy, false);assert.equal(config.exif, false);assert.equal(h.selected.length, 1);
  });
}
test('denying optional iOS video permission neither launches picker nor prevents other actions', async () => {
  const h = pickerHarness('ios', { permission: { granted: false, canAskAgain: false } });await h.run('video');
  assert.deepEqual(h.calls, ['permission']);assert.equal(h.selected.length, 0);
  assert.match(h.alerts[0][1], /skip this optional upload/);
});
for (const result of [{ canceled: true, assets: null }, { canceled: false, assets: [] }]) {
  test(`picker handles ${result.canceled ? 'cancel' : 'empty result'} without saving media`, async () => {
    const h = pickerHarness('android', { result });await h.run('photo');assert.equal(h.selected.length, 0);
  });
}
test('picker failure is recoverable and oversized files are rejected', async () => {
  const h = pickerHarness('android', { throw: true });await h.run('photo');assert.equal(h.alerts.length, 1);assert.equal(h.selected.length, 0);
  const big = pickerHarness('android', { result: { canceled: false, assets: [{ uri: 'file:///large', fileSize: 6 * 1024 * 1024 }] } });
  await big.run('photo');assert.equal(big.selected.length, 0);assert.match(big.alerts[0][0], /too large/);
});

const visibilityCode = web.match(/const profileFields=[^\n]+/)[0]+'\n'+web.slice(web.indexOf('function validBaristaBirthDate'),web.indexOf('function trustBanner'));
const saveCode = web.slice(web.indexOf("document.getElementById('profile-form').onsubmit"), web.indexOf("document.getElementById('job-cancel')"));
function webHarness(gender, previousGender = null) {
  const rows = [], status = { textContent: '' }, button = {}, dialog={close(){}}, form = { querySelector: () => button,querySelectorAll:()=>[button],setAttribute(){},removeAttribute(){} };
  const values = { location:'Miami, FL', date_of_birth:'2000-01-01', gender_identity:gender, name:'Test barista', bio:'Coffee experience', skills:'Espresso', experience:'2 years', pay_expectation:'20' };
  const profile = { display_name:'Test', avatar_url:'https://example.invalid/a.png', location:'Miami, FL', bio:'Coffee', availability:'Full-time', experience:'2 years', pay_expectation:'20', skills:['Espresso'] };
  const context = {
    document:{getElementById:id => id==='profile-form' ? form : id==='profile-dialog'?dialog:status},
    profileSaveInProgress:false,currentSection:'My Profile',currentView:{},openSection(){},
    currentRole:'barista', currentUser:{id:'test-user'}, currentProfile:profile,
    currentDemographics:{ date_of_birth:'2000-01-01', gender_identity:previousGender },
    FormData:class { get(key) {return values[key] ?? null} set(key,value){values[key]=value} getAll(){return []} },
    isFloridaPlace:() => true, maximumBaristaBirthDate:() => '2010-01-01',
    collectAvailability:() => 'Full-time', refreshMarketplaceAfterProfileSave:async()=>{}, setTimeout:() => {}, Date,
    activeClient:{from:table=>({ update:payload=>({eq:()=>({select:()=>({single:async()=>{rows.push([table,payload]);Object.assign(profile,payload);return{data:{...profile},error:null}}})})}),upsert:payload=>({select:()=>({single:async()=>{rows.push([table,payload]);return{data:payload,error:null}}})}) })},
  };
  vm.createContext(context);vm.runInContext(visibilityCode+'\n'+saveCode,context);
  return { rows, status, context, run:()=>form.onsubmit({preventDefault(){},currentTarget:form}) };
}
for (const gender of ['', 'female', 'male']) test(`web saves profile with ${gender || 'unprovided'} gender without exposing it`, async () => {
  const h=webHarness(gender);await h.run();
  assert.equal(h.rows.find(([table])=>table==='profile_demographics')[1].gender_identity, gender || null);
  assert.ok(h.rows.filter(([table])=>table==='profiles').every(([,row])=>!Object.hasOwn(row,'gender_identity')&&!Object.hasOwn(row,'date_of_birth')));
  assert.equal(h.context.profileVisibilityReady(), true);
});
test('web can remove an existing gender selection without hiding the profile', async () => {
  const h=webHarness('', 'female');await h.run();
  assert.equal(h.context.currentDemographics.gender_identity, null);assert.equal(h.context.profileVisibilityReady(), true);
});
test('web still rejects invalid optional gender values before writes', async () => {
  const h=webHarness('invalid');await h.run();assert.equal(h.rows.length, 0);assert.match(h.status.textContent,/Prefer not to say/);
});
test('native and web keep DOB required but never require gender', () => {
  assert.match(native,/normalizeOptionalGender\(profile.gender_identity\)/);assert.match(native,/gender_identity: genderIdentity/);
  assert.match(native,/Gender \(optional\)/);assert.doesNotMatch(native,/Gender required/);
  assert.match(web,/form.gender_identity.required=false/);assert.match(web,/form.date_of_birth.required=isBarista/);
  assert.match(native,/Date of birth required/);assert.doesNotMatch(visibilityCode,/gender_identity/);
});
test('privacy notice matches optional demographics and offers external deletion', () => {
  const policy=read('privacy.html');assert.match(policy,/Gender is optional/);assert.match(policy,/href="\/delete-account.html"/);
  assert.doesNotMatch(policy,/require a date of birth and a selection/);
});
test('Android configuration blocks broad media access and unused recording permissions', () => {
  const blocked=JSON.parse(read('mobile/app.json')).expo.android.blockedPermissions;
  for(const permission of ['READ_MEDIA_IMAGES','READ_MEDIA_VIDEO','READ_MEDIA_AUDIO','READ_EXTERNAL_STORAGE','WRITE_EXTERNAL_STORAGE','CAMERA','RECORD_AUDIO']) {
    assert.ok(blocked.includes(`android.permission.${permission}`));
  }
});
