from pathlib import Path
p=Path('dashboard.html');s=p.read_text()
old="async function openCandidate(id){const profile=candidateProfiles.find(item=>item.id===id);if(!profile)return;"
new="async function openCandidate(id){const profile=candidateProfiles.find(item=>item.id===id)||applications.find(app=>app.barista_id===id)?.barista;if(!profile){alert('This barista profile is temporarily unavailable. Please refresh and try again.');return;}"
if old not in s: raise SystemExit('openCandidate target not found')
s=s.replace(old,new,1)
# Use uploaded avatar in applicant rows when available, otherwise keep simple person fallback.
old2='<div class="avatar">👤</div><div class="itemtext"><b>${escapeHtml(app.barista?.display_name||\'Barista\')}</b>'
new2='<div class="avatar">${app.barista?.avatar_url?`<img src="${escapeHtml(app.barista.avatar_url)}" alt="${escapeHtml(app.barista?.display_name||\'Barista\')} profile photo">`:\'👤\'}</div><div class="itemtext"><b>${escapeHtml(app.barista?.display_name||\'Barista\')}</b>'
if old2 in s:s=s.replace(old2,new2,1)
# Add stronger affordance to view button without changing overall design.
s=s.replace('data-view-barista="${app.barista_id}">View</button>', 'data-view-barista="${app.barista_id}" aria-label="View ${escapeHtml(app.barista?.display_name||\'barista\')} profile">View profile</button>')
p.write_text(s)
