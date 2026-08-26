from pathlib import Path

# --- dashboard.html ---
p=Path('dashboard.html')
s=p.read_text()

# Fix accidental global label color bleed on wow stat cards.
s=s.replace('.wow-stat:nth-child(4) .profile-info{font-size:12px;color:#a95820;vertical-align:1px}.wow-stat-label{color:#dbcbbc}',
            '.wow-stat:nth-child(4) .profile-info{font-size:12px;color:#a95820;vertical-align:1px}.wow-stat:nth-child(4) .wow-stat-label{color:#dbcbbc}')

# Make selects match the profile form controls.
s=s.replace('.profile-form input,.profile-form textarea{width:100%;', '.profile-form input,.profile-form textarea,.profile-form select{width:100%;', 1)

# Required-profile strength should reflect required profile details, not optional video.
s=s.replace("const profileFields={barista:['display_name','location','bio','skills','availability','experience','pay_expectation','video_path'],cafe_owner_manager:['cafe_name','avatar_url','location','bio','skills','experience','video_path']};",
            "const profileFields={barista:['display_name','avatar_url','location','bio','skills','availability','experience','pay_expectation'],cafe_owner_manager:['cafe_name','avatar_url','location','bio','skills','experience']};")

# Add barista photo + preferred work area fields to the shared profile editor.
name_field='<label id="profile-name-label">Display name<input name="name" maxlength="80" required></label>'
if 'id="barista-image-field"' not in s:
    s=s.replace(name_field, name_field+'<label id="barista-image-field" hidden>Profile photo<input name="barista_image" type="file" accept="image/jpeg,image/png,image/webp"><small>Use a clear photo · up to 5 MB</small></label>', 1)
loc_field='<label>Location<input name="location" maxlength="120" placeholder="Brooklyn, NY" required></label>'
if 'id="preferred-city-field"' not in s:
    s=s.replace(loc_field, loc_field+'<label id="preferred-city-field" hidden>Preferred work city<input name="preferred_city" maxlength="80" placeholder="Miami"></label><label id="preferred-state-field" hidden>Preferred state<input name="preferred_state" maxlength="2" placeholder="FL"></label><label id="preferred-zip-field" hidden>Preferred ZIP code<input name="preferred_postal_code" inputmode="numeric" maxlength="10" placeholder="33101"></label><label id="preferred-radius-field" hidden>Search area<select name="preferred_radius_miles"><option value="10">Within about 10 miles</option><option value="25">Within about 25 miles</option><option value="50">Within about 50 miles</option><option value="100">Within about 100 miles</option></select></label>', 1)

# Replace single free-text job location with a complete structured address.
old_job_loc='<label>Location<input name="location" required placeholder="Brooklyn, NY"></label>'
new_job_loc='<label class="form-wide">Street address<input name="address_line1" required autocomplete="street-address" placeholder="123 Main Street"></label><label class="form-wide">Suite / unit (optional)<input name="address_line2" autocomplete="address-line2" placeholder="Suite 200"></label><label>City<input name="city" required autocomplete="address-level2" placeholder="Miami"></label><label>State<input name="state" required autocomplete="address-level1" maxlength="2" placeholder="FL"></label><label>ZIP code<input name="postal_code" required autocomplete="postal-code" inputmode="numeric" maxlength="10" placeholder="33101"></label>'
if old_job_loc in s:
    s=s.replace(old_job_loc,new_job_loc,1)

# Toggle/fill new profile fields in the editor.
needle="document.getElementById('cafe-image-field').hidden=isBarista;"
if needle in s and "barista-image-field').hidden" not in s:
    s=s.replace(needle, needle+"document.getElementById('barista-image-field').hidden=!isBarista;['preferred-city-field','preferred-state-field','preferred-zip-field','preferred-radius-field'].forEach(id=>document.getElementById(id).hidden=!isBarista);",1)
needle2="form.location.value=currentProfile.location||'';"
if needle2 in s and "form.preferred_city.value" not in s:
    s=s.replace(needle2, needle2+"if(isBarista){form.preferred_city.value=currentProfile.preferred_city||'';form.preferred_state.value=currentProfile.preferred_state||'';form.preferred_postal_code.value=currentProfile.preferred_postal_code||'';form.preferred_radius_miles.value=String(currentProfile.preferred_radius_miles||25)}",1)

# Add barista avatar upload using the existing public profile-image bucket.
needle3="const cafeImage=data.get('cafe_image');"
if needle3 in s and "const baristaImage=data.get('barista_image')" not in s:
    barista_upload="const baristaImage=data.get('barista_image');if(isBarista&&baristaImage&&baristaImage.size){if(baristaImage.size>5242880)throw new Error('Profile photo must be smaller than 5 MB.');const ext=(baristaImage.name.split('.').pop()||'jpg').toLowerCase(),path=`${currentUser.id}/avatar.${ext}`;const {error:baristaImageError}=await activeClient.storage.from('cafe-images').upload(path,baristaImage,{upsert:true,contentType:baristaImage.type});if(baristaImageError)throw baristaImageError;avatarUrl=activeClient.storage.from('cafe-images').getPublicUrl(path).data.publicUrl}"
    s=s.replace(needle3,barista_upload+needle3,1)

# Save preferred work area with barista profile.
payload_old="pay_expectation:isBarista?String(data.get('pay_expectation')).trim():null,video_path:videoPath,avatar_url:avatarUrl,updated_at:new Date().toISOString()"
payload_new="pay_expectation:isBarista?String(data.get('pay_expectation')).trim():null,preferred_city:isBarista?String(data.get('preferred_city')||'').trim()||null:null,preferred_state:isBarista?String(data.get('preferred_state')||'').trim().toUpperCase()||null:null,preferred_postal_code:isBarista?String(data.get('preferred_postal_code')||'').trim()||null:null,preferred_radius_miles:isBarista?Number(data.get('preferred_radius_miles')||25):null,video_path:videoPath,avatar_url:avatarUrl,updated_at:new Date().toISOString()"
if payload_old in s:
    s=s.replace(payload_old,payload_new,1)

# Add robust location matching helper (supports legacy free-text job locations too).
marker='function jobsHtml(){'
if 'function jobMatchesBaristaLocation(job)' not in s:
    helper="""function normalizePlace(value){return String(value||'').trim().toLowerCase()}\nfunction legacyJobState(location){const m=String(location||'').match(/,\\s*([A-Za-z]{2})(?:\\s+\\d{5}(?:-\\d{4})?)?\\s*$/);return m?m[1]:''}\nfunction legacyJobCity(location){return String(location||'').split(',')[0].trim()}\nfunction jobMatchesBaristaLocation(job){if(currentRole!=='barista')return true;const pc=normalizePlace(currentProfile.preferred_city),ps=normalizePlace(currentProfile.preferred_state),pz=normalizePlace(currentProfile.preferred_postal_code);if(!pc&&!ps&&!pz)return true;const jc=normalizePlace(job.city||legacyJobCity(job.location)),js=normalizePlace(job.state||legacyJobState(job.location)),jz=normalizePlace(job.postal_code);if(ps&&js&&ps!==js)return false;if(pc&&jc&&pc!==jc)return false;if(pc)return jc===pc&&(!ps||!js||js===ps);if(pz&&jz)return pz===jz;if(ps)return js===ps;return pz?jz===pz:true}\n"""
    s=s.replace(marker,helper+marker,1)

# Load structured job address fields and filter barista results to their selected area.
s=s.replace("select('id,owner_id,title,location,pay_min,pay_max,schedule,description,required_skills,active,created_at,owner:profiles!jobs_owner_id_fkey(cafe_name,location,avatar_url)')",
            "select('id,owner_id,title,location,address_line1,address_line2,city,state,postal_code,pay_min,pay_max,schedule,description,required_skills,active,created_at,owner:profiles!jobs_owner_id_fkey(cafe_name,location,avatar_url)')",1)
s=s.replace("profileViews=viewsResult.data||[];marketJobs=jobsResult.data||[];applications=appsResult.data||[]",
            "profileViews=viewsResult.data||[];marketJobs=(jobsResult.data||[]).filter(jobMatchesBaristaLocation);applications=appsResult.data||[]",1)

# Friendly client-side gates before network calls; database RLS also enforces these rules.
apply_sig="async function applyToJob(jobId,button){button.disabled=true;"
if apply_sig in s:
    s=s.replace(apply_sig,"async function applyToJob(jobId,button){if(!profileVisibilityReady()){alert('Complete your profile before showing interest so cafés can review a real, complete profile.');openSection('My Profile',currentView,currentRole);return}button.disabled=true;",1)

# Require a complete saved café profile before publishing a job and store the structured location.
s=s.replace("if(!currentProfile.cafe_name)throw new Error('Add your café name in Café Profile before posting a job.');",
            "if(!profileVisibilityReady())throw new Error('Complete and save your Café Profile before posting a job.');",1)
old_payload="const payload={owner_id:currentUser.id,title:String(data.get('title')).trim(),location:String(data.get('location')).trim(),pay_min:hourlyPay,pay_max:null,schedule:schedules.join(' · '),required_skills:String(data.get('skills')).split(',').map(value=>value.trim()).filter(Boolean),description:String(data.get('description')).trim(),active:true};"
new_payload="const city=String(data.get('city')).trim(),state=String(data.get('state')).trim().toUpperCase(),postalCode=String(data.get('postal_code')).trim();const payload={owner_id:currentUser.id,title:String(data.get('title')).trim(),location:[city,state,postalCode].filter(Boolean).join(', '),address_line1:String(data.get('address_line1')).trim(),address_line2:String(data.get('address_line2')||'').trim()||null,city,state,postal_code:postalCode,pay_min:hourlyPay,pay_max:null,schedule:schedules.join(' · '),required_skills:String(data.get('skills')).split(',').map(value=>value.trim()).filter(Boolean),description:String(data.get('description')).trim(),active:true};"
if old_payload in s:
    s=s.replace(old_payload,new_payload,1)

p.write_text(s)

# --- index.html ---
p=Path('index.html')
s=p.read_text()
s=s.replace('<a href="mailto:privacy@baristajobmatch.com">Support</a>','<a href="/support.html">Support</a>')
p.write_text(s)

# --- launch-check.js ---
p=Path('launch-check.js')
s=p.read_text()
extra="""\n// Marketplace trust, location, and responsive regression checks.\nfor(const token of ['barista-image-field','preferred_city','preferred_state','preferred_postal_code','address_line1','postal_code','jobMatchesBaristaLocation','profileVisibilityReady']){\n  if(!dashboard.includes(token)) throw new Error(`dashboard missing trust/location token ${token}`);\n}\nif(dashboard.includes(".wow-stat:nth-child(4) .profile-info{font-size:12px;color:#a95820;vertical-align:1px}.wow-stat-label{color:#dbcbbc}")) throw new Error('Dashboard has global wow-stat label color bleed');\nif(!fs.readFileSync('index.html','utf8').includes('href=\"/support.html\">Support</a>')) throw new Error('Homepage Support link is not routed to support page');\n"""
if 'Marketplace trust, location, and responsive regression checks.' not in s:
    s=s.replace("console.log('BaristaMatch launch readiness static checks passed');",extra+"\nconsole.log('BaristaMatch launch readiness static checks passed');")
p.write_text(s)
