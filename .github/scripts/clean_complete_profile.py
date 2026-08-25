from pathlib import Path
import re

p = Path('dashboard.html')
s = p.read_text()
pattern = r"function profileHtml\(\)\{.*?\}\nfunction money\(job\)"
replacement = '''function profileHtml(){
  const score=profileStrength();
  const complete=score===100;
  const name=escapeHtml(profileName());
  const bio=escapeHtml(currentProfile.bio||'Add a short introduction to bring your profile to life.');
  const location=escapeHtml(currentProfile.location||'Location not added');
  const skills=escapeHtml((currentProfile.skills||[]).join(' · ')||'Skills not added');
  const experience=escapeHtml(currentProfile.experience||'Experience not added');
  const video=currentProfile.video_path?'<p class="empty">Your coffee showcase video is saved and visible to cafés on BaristaMatch.</p>':'<p class="empty">Add a 15–60 second coffee showcase video to help your profile stand out.</p>';
  if(complete){
    const roleDetails=currentRole==='barista'?`<div class="profile-detail"><strong>Availability</strong><span>${escapeHtml(currentProfile.availability||'Not added')}</span></div><div class="profile-detail"><strong>Desired pay</strong><span>${escapeHtml(currentProfile.pay_expectation||'Open to discussion')}</span></div>`:'';
    return `<div class="section-head"><div><p>Keep your profile current so the right matches can find you.</p></div><button class="primary" data-edit-profile>Edit profile</button></div><div class="grid completed-profile-grid"><article class="card completed-profile-card"><div class="completed-profile-head"><div class="avatar completed-profile-avatar">${currentRole==='barista'?'☕':'🏪'}</div><div><h2>${name}</h2><p>${bio}</p></div></div><div class="profile-details"><div class="profile-detail"><strong>Location</strong><span>${location}</span></div><div class="profile-detail"><strong>Specialties</strong><span>${skills}</span></div><div class="profile-detail"><strong>Experience</strong><span>${experience}</span></div>${roleDetails}</div></article><article class="card"><h3>☕ Coffee showcase</h3>${video}<button class="secondary" data-edit-profile>${currentProfile.video_path?'Replace video':'Add video'}</button></article></div>`;
  }
  return `<div class="section-head"><div>${currentRole==='barista'?'<h2>My Profile</h2>':''}<p>Complete your profile to make a memorable first impression.</p></div><button class="primary" data-edit-profile>Edit profile</button></div><div class="grid"><article class="card"><div class="profile-hero"><div class="strength-score" style="--score:${score}%"><strong>${score}%</strong></div><div><h3>${name}</h3><p class="empty">${bio}</p></div></div><div class="checklist">${checklist()}</div></article><article class="card"><h3>☕ Coffee showcase</h3>${video}<button class="secondary" data-edit-profile>${currentProfile.video_path?'Replace video':'Add optional video'}</button><div class="item"><div class="avatar">✨</div><div class="itemtext"><b>Profile boost</b><small>Finish the remaining profile details to improve your matches.</small></div></div></article></div>`;
}
function money(job)'''
ns, count = re.subn(pattern, replacement, s, count=1, flags=re.S)
if count != 1:
    raise SystemExit(f'profileHtml replacement count: {count}')
css_marker = '.profile-hero{display:flex;gap:18px;align-items:center}'
css_add = '.completed-profile-grid{align-items:start}.completed-profile-card{padding:24px}.completed-profile-head{display:flex;gap:16px;align-items:flex-start;margin-bottom:22px}.completed-profile-head h2{font-family:Georgia,serif;margin:0 0 7px;font-size:27px}.completed-profile-head p{margin:0;color:var(--muted);line-height:1.55}.completed-profile-avatar{width:58px;height:58px;font-size:26px}.profile-details{display:grid;gap:0;border-top:1px solid var(--line)}.profile-detail{display:grid;grid-template-columns:130px minmax(0,1fr);gap:16px;padding:14px 0;border-bottom:1px solid #f0e7df}.profile-detail strong{font-size:13px}.profile-detail span{color:var(--muted);line-height:1.45}'
if css_add not in ns:
    if css_marker not in ns:
        raise SystemExit('profile css marker missing')
    ns = ns.replace(css_marker, css_add + css_marker, 1)
mobile_marker = '.profile-hero{align-items:flex-start}'
mobile_add = '.profile-detail{grid-template-columns:1fr;gap:5px}.completed-profile-head{align-items:flex-start}.completed-profile-avatar{width:50px;height:50px}'
if mobile_marker in ns and mobile_add not in ns:
    ns = ns.replace(mobile_marker, mobile_marker + mobile_add, 1)
p.write_text(ns)
