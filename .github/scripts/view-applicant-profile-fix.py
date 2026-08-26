from pathlib import Path
p=Path('dashboard.html');s=p.read_text()
old="async function openCandidate(id){const profile=candidateProfiles.find(item=>item.id===id);if(!profile)return;"
new="async function openCandidate(id){let profile=candidateProfiles.find(item=>item.id===id)||applications.find(app=>app.barista_id===id)?.barista;if(!profile){const {data,error}=await activeClient.from('profiles').select('id,display_name,location,bio,skills,availability,experience,pay_expectation,video_path,avatar_url').eq('id',id).maybeSingle();if(error){console.error('Could not load barista profile:',error);alert('We could not load this barista profile right now.');return}profile=data}if(!profile){alert('This barista profile is unavailable.');return;}"
if old not in s: raise SystemExit('openCandidate target not found')
s=s.replace(old,new,1)
# Use actual profile photo in applicant list when available.
s=s.replace('<div class=\"avatar\">👤</div><div class=\"itemtext\"><b>${escapeHtml(app.barista?.display_name||\'Barista\')}</b>', '<div class=\"avatar\">${app.barista?.avatar_url?`<img src=\"${escapeHtml(app.barista.avatar_url)}\" alt=\"\">`:\'👤\'}</div><div class=\"itemtext\"><b>${escapeHtml(app.barista?.display_name||\'Barista\')}</b>',1)
p.write_text(s)
