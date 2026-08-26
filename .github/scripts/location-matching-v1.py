from pathlib import Path
p=Path('dashboard.html');s=p.read_text()
# Expand profile load/save fields.
s=s.replace("pay_expectation,video_path,avatar_url,updated_at", "pay_expectation,video_path,avatar_url,preferred_city,preferred_state,preferred_postal_code,preferred_radius_miles,updated_at")
s=s.replace("pay_expectation,video_path,avatar_url').eq('role','barista')", "pay_expectation,video_path,avatar_url,preferred_city,preferred_state,preferred_postal_code,preferred_radius_miles').eq('role','barista')")
# Expand jobs selects.
s=s.replace("title,location,pay_min,pay_max,schedule,description,required_skills,active,created_at", "title,location,address_line1,address_line2,city,state,postal_code,pay_min,pay_max,schedule,description,required_skills,active,created_at")
# Job form: replace old location field with structured address.
s=s.replace('<label>Location<input name="location" required placeholder="Miami, FL"></label>', '<label class="form-wide">Street address<input name="address_line1" required autocomplete="street-address" placeholder="123 Main Street"></label><label class="form-wide">Apt / Suite / Unit (optional)<input name="address_line2" placeholder="Suite 200"></label><label>City<input name="city" required autocomplete="address-level2" placeholder="Miami"></label><label>State<input name="state" required autocomplete="address-level1" maxlength="2" placeholder="FL"></label><label>ZIP code<input name="postal_code" required autocomplete="postal-code" inputmode="numeric" placeholder="33101"></label>')
# Job submission payload: derive display location and save structured address.
s=s.replace("location:form.location.value.trim(),pay_min", "location:[form.city.value.trim(),form.state.value.trim(),form.postal_code.value.trim()].filter(Boolean).join(', '),address_line1:form.address_line1.value.trim(),address_line2:form.address_line2.value.trim(),city:form.city.value.trim(),state:form.state.value.trim().toUpperCase(),postal_code:form.postal_code.value.trim(),pay_min")
# Add barista preferred work location to profile form before bio.
s=s.replace('<label class="form-wide">Bio<textarea name="bio"', '<label>Preferred work city<input name="preferred_city" value="${escapeHtml(profile.preferred_city||\'\')}" placeholder="Miami"></label><label>Preferred state<input name="preferred_state" maxlength="2" value="${escapeHtml(profile.preferred_state||\'\')}" placeholder="FL"></label><label>Preferred ZIP code<input name="preferred_postal_code" inputmode="numeric" value="${escapeHtml(profile.preferred_postal_code||\'\')}" placeholder="33101"></label><label>Search radius<select name="preferred_radius_miles"><option value="10" ${Number(profile.preferred_radius_miles)===10?\'selected\':\'\'}>10 miles</option><option value="25" ${!profile.preferred_radius_miles||Number(profile.preferred_radius_miles)===25?\'selected\':\'\'}>25 miles</option><option value="50" ${Number(profile.preferred_radius_miles)===50?\'selected\':\'\'}>50 miles</option><option value="100" ${Number(profile.preferred_radius_miles)===100?\'selected\':\'\'}>100 miles</option></select></label><label class="form-wide">Bio<textarea name="bio"')
# Ensure selects style like inputs.
s=s.replace('.profile-form input,.profile-form textarea{', '.profile-form input,.profile-form textarea,.profile-form select{')
# Save barista preference fields.
s=s.replace("pay_expectation:form.pay_expectation.value.trim(),updated_at", "pay_expectation:form.pay_expectation.value.trim(),preferred_city:form.preferred_city?.value.trim()||null,preferred_state:form.preferred_state?.value.trim().toUpperCase()||null,preferred_postal_code:form.preferred_postal_code?.value.trim()||null,preferred_radius_miles:Number(form.preferred_radius_miles?.value||25),updated_at")
# Add helpers and strict state/city/zip relevance filtering for barista Find Jobs.
marker='function findJobsHtml(){'
helper="""function normalizePlace(v){return String(v||'').trim().toLowerCase()}\nfunction jobMatchesBaristaLocation(job){if(currentRole!=='barista')return true;const pc=normalizePlace(currentProfile.preferred_city),ps=normalizePlace(currentProfile.preferred_state),pz=normalizePlace(currentProfile.preferred_postal_code);if(!pc&&!ps&&!pz)return true;if(pz&&normalizePlace(job.postal_code)===pz)return true;if(pc&&ps&&normalizePlace(job.city)===pc&&normalizePlace(job.state)===ps)return true;if(ps&&!pc&&!pz&&normalizePlace(job.state)===ps)return true;return false}\n"""
if marker in s and helper not in s:s=s.replace(marker,helper+marker,1)
# In findJobsHtml, filter marketJobs before rendering when exact expression exists.
s=s.replace('const available=marketJobs.filter(job=>job.active);', 'const available=marketJobs.filter(job=>job.active&&jobMatchesBaristaLocation(job));')
# Add location preference hint in Find Jobs.
s=s.replace('<div class="section-intro"><p>Browse open café opportunities', '<div class="section-intro"><p>Browse open café opportunities near the location you selected in your profile. Jobs outside your selected city/state/ZIP are filtered out to prevent irrelevant long-distance matches.</p><p>')
p.write_text(s)
