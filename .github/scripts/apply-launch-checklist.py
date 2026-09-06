from pathlib import Path
import hashlib, json
root=Path.cwd()
expected={
'APP-STORE-SUBMISSION.md':('1af89dc5caa73c81ba54bdfa188129e87add804eee784531d3e092986485a45f','9f47afbb4afda64740af1c9b39a4f0f2196524c1041818cf57a1222c605dc52e'),
'GOOGLE-PLAY-SUBMISSION.md':('629c5055cbbdc0933b6f8b22a4b48b53983b4a962d362b3beaef533ad63354ae','fdd52e2d4182b620206896f612fe01579cf2fe1a5f0e91aa4713a7dd33cef876'),
'dashboard.html':('28fdbf81dc846b3513ec5ea3c56cd1e49105e7dbecb21bc479aaf823fcc7ef01','e58e923d5eb0df958c72d43712847c06c6ab2e300d11af8a2c2075340bc7a3e0'),
'docs/APPLE-DELETION-FOLLOWUP-2026-09-06.md':('b2dd0f27da30da23caad1c04de80dc66cea2f8a456c7b1a10702c2e51bcceb14','cb78075277118df913b873e9d656338760d28f9cb5c5f7211820edc54fda163c'),
'docs/STORE-READINESS-AUDIT-2026-09-06.md':('168a914d20322a40578bd8c38af91ef93ed4d7df44742223a8ff3ed8374a0585','57843fdb057af6cf3562fc24af1ed9af6b230d0f319733b252a1d28209ad5dbc'),
'launch-check.js':('24968c0182e97eb0b190f332cee8b786a8519c129ba60cae832414e274c0576b','27d34530267fc1f6ae1ff016c124fc52d9df759b7d8d9c37fe5bc4f02d0d3070'),
'mobile/app.json':('fc81a53cb32a8ea38572d4a544a95d69294f03add24a8fa791d456563c6b6477','e2a67e8181601017dd09a43b94c451ed160a5d4d52cbe4b4eb14b045458015f8'),
'mobile/app/profile.tsx':('44598048dc8e830873f540d8d5227c36e624c5c9d9eea0107974796714ffd886','c3430b1fdc7e4b66d973b2296c9dea6cea0618c0fecd7e0a7b1283c4c44f6320'),
'privacy.html':('08b219cffa7a73e34434d35542dc6226f481d3ffe762bf308572ece5ca706327','4765f89b039b399ab0cc576276c667347aee5e88f00f5ca9182661e6677bbee7')}
for name,(before,after) in expected.items():
 assert hashlib.sha256((root/name).read_bytes()).hexdigest()==before, 'Unexpected baseline: '+name

def edit(name, replacements):
 p=root/name;s=p.read_text()
 for old,new in replacements:
  assert s.count(old)==1,(name,old,s.count(old))
  s=s.replace(old,new)
 p.write_text(s)
edit('dashboard.html',[
 ('<label id="gender-field" hidden>Gender<select name="gender_identity"><option value="">Choose one</option>', '<label id="gender-field" hidden>Gender (optional)<select name="gender_identity"><option value="">Prefer not to say</option>'),
 ('Your date of birth and gender are never shown to cafés. They are used only for eligibility and anonymous platform totals.', 'Your date of birth and gender are never shown to cafés. Date of birth is used for age eligibility. Gender is optional, used only for aggregate platform reporting, and never affects profile visibility or matching. Choose Prefer not to say to remove a previous selection.'),
 ('currentDemographics.date_of_birth,currentDemographics.gender_identity].every(Boolean)', 'currentDemographics.date_of_birth].every(Boolean)'),
 ('form.gender_identity.required=isBarista;', 'form.gender_identity.required=false;'),
 ("if(isBarista&&!['female','male'].includes(genderIdentity))throw new Error('Choose Female or Male to continue.');", "if(isBarista&&genderIdentity&&!['female','male'].includes(genderIdentity))throw new Error('Choose Female, Male, or Prefer not to say.');"),
 ('date_of_birth:dateOfBirth,gender_identity:genderIdentity,age_range:null', 'date_of_birth:dateOfBirth,gender_identity:genderIdentity||null,age_range:null')])
edit('mobile/app/profile.tsx',[
 ('  Linking,\n  Pressable,', '  Linking,\n  Platform,\n  Pressable,'),
 ('import { supabase } from "@/lib/supabase";', 'import { supabase } from "@/lib/supabase";\nimport { needsMediaLibraryPermission, normalizeOptionalGender } from "@/lib/profilePrivacy";'),
 ('const GENDER_OPTIONS = [', 'const GENDER_OPTIONS = [\n  { value: "", label: "Prefer not to say" },'),
 ('      const permission =\n        await ImagePicker.requestMediaLibraryPermissionsAsync();', '      // Use the system picker without broad library access on Android and for photos.\n      // Original iOS videos require permission with SDK 54 pass-through export.\n      if (needsMediaLibraryPermission(Platform.OS, kind)) {\n      const permission =\n        await ImagePicker.requestMediaLibraryPermissionsAsync();'),
 ('          "Photos access required",\n          "Allow BaristaMatch to access your photos and videos so you can add profile media.",', '          "Video access permission",\n          "Access is needed to add your original video. You can skip this optional upload and keep using BaristaMatch.",'),
 ('      const result = await ImagePicker.launchImageLibraryAsync({', '      }\n      const result = await ImagePicker.launchImageLibraryAsync({\n        legacy: false,\n        exif: false,'),
 ('      const picked = result.assets[0];', '      const picked = result.assets?.[0];\n      if (!picked?.uri) throw new Error("No media was selected. Please try again.");'),
 ('    if (role === "barista" && !["female", "male"].includes(profile.gender_identity))\n      return Alert.alert("Gender required", "Choose Female or Male to continue. This information remains private.");', '    let genderIdentity: "female" | "male" | null = null;\n    if (role === "barista") {\n      try { genderIdentity = normalizeOptionalGender(profile.gender_identity); }\n      catch { return Alert.alert("Check optional gender", "Choose Female, Male, or Prefer not to say."); }\n    }'),
 ('            gender_identity: profile.gender_identity,', '            gender_identity: genderIdentity,'),
 ('<Text style={[s.label, { marginTop: 15 }]}>Gender</Text>', '<Text style={[s.label, { marginTop: 15 }]}>Gender (optional)</Text>'),
 ('Required for age eligibility and private platform reporting. Your date of birth, age, and gender are never shown to cafés or on your marketplace profile.', 'Date of birth is required for age eligibility. Gender is optional and used only for aggregate platform reporting; it never affects visibility or matching. Choose Prefer not to say to remove a previous selection. Your date of birth, age, and gender are never shown to cafés or on your marketplace profile.')])
p=root/'mobile/app/profile.tsx';p.write_text('\n'.join(line.rstrip() for line in p.read_text().splitlines())+'\n')
p=root/'mobile/app.json';d=json.loads(p.read_text());d['expo']['android']['blockedPermissions']=[
 'android.permission.READ_MEDIA_IMAGES','android.permission.READ_MEDIA_VIDEO','android.permission.READ_MEDIA_AUDIO',
 'android.permission.READ_EXTERNAL_STORAGE','android.permission.WRITE_EXTERNAL_STORAGE',
 'android.permission.RECORD_AUDIO','android.permission.CAMERA']
p.write_text(json.dumps(d,ensure_ascii=False,indent=2)+'\n')
edit('privacy.html',[
 ('Effective September 2, 2026', 'Effective September 6, 2026'),
 ('Barista profiles require a date of birth and a selection of Female or Male.', 'Barista profiles require a date of birth for age eligibility. Gender is optional: you may select Female or Male, leave it unprovided, or select Prefer not to say to remove a previous selection. Choosing not to provide gender does not affect profile visibility, matching, or access.'),
 ('We use them only to confirm minimum-age eligibility and produce aggregate owner reporting.', 'We use date of birth to confirm minimum-age eligibility and produce aggregate age reporting; voluntarily provided gender is used only for aggregate reporting.'),
 ('If you choose to upload a coffee showcase video, we store that video for use in your profile.', 'If you choose to upload profile photos, café images, or a coffee showcase video, we store the selected media for your profile. Updated Android builds use a system picker instead of requesting broad access to your media library. Older installed builds may still request library permission; you can update the app or use the website. On iOS, selecting an original video may require photo-library permission; video upload remains optional.'),
 ('We will respond to verified requests as required by applicable law.</p>', 'You can also <a href="/delete-account.html">request account and associated-data deletion without the app installed</a>. We will respond to verified requests as required by applicable law.</p>')])
for name in ['APP-STORE-SUBMISSION.md','GOOGLE-PLAY-SUBMISSION.md','docs/STORE-READINESS-AUDIT-2026-09-06.md','docs/APPLE-DELETION-FOLLOWUP-2026-09-06.md']:
 p=root/name;s=p.read_text();first=s.index('\n');link='LAUNCH-CHECKLIST.md' if name.startswith('docs/') else 'docs/LAUNCH-CHECKLIST.md'
 s=s[:first+1]+f'\n> Current execution status and remaining gates: [Launch checklist]({link}). This preparation/audit record is not itself proof of store approval.\n'+s[first+1:];p.write_text(s)
edit('APP-STORE-SUBMISSION.md',[
 ('Mandatory gender collection for aggregate reporting presents a data-minimization review risk. Do not claim this is optional until the app, website and backend behavior have been changed consistently. Keep private demographics out of employer-visible profiles.', 'Gender is optional in the updated web/native source and is stored as NULL when unprovided. The production database already permits NULL and its visibility rule does not require gender. Profile visibility and saving no longer depend on gender in the updated clients. Keep demographics private; verify this behavior on the signed release build before submitting disclosures. Older installed builds do not receive these changes merely because source was merged.')])
edit('launch-check.js',[("  if(!source.includes('BaristaMatch LLC')||!source.includes('Effective September 2, 2026'))throw new Error(`${file}: LLC operator or effective date is missing`);", "  const effectiveDate=file==='privacy.html'?'Effective September 6, 2026':'Effective September 2, 2026';\n  if(!source.includes('BaristaMatch LLC')||!source.includes(effectiveDate))throw new Error(`${file}: LLC operator or effective date is missing`);")])
for name,(before,after) in expected.items():
 assert hashlib.sha256((root/name).read_bytes()).hexdigest()==after, 'Output differs from locally tested source: '+name
print('Exact source hashes verified; no database, credential or release operation performed.')
