from pathlib import Path
p=Path('dashboard.html');s=p.read_text()
# Never render the large trust banner in page content; backend visibility enforcement remains unchanged.
s=s.replace("document.getElementById('content').innerHTML=(name==='Account Settings'?'':trustBanner())+html;bindContentActions();", "document.getElementById('content').innerHTML=html;bindContentActions();")
# Fix malformed literal from previous banner implementation even though banner is no longer rendered.
s=s.replace("'${ready?\"Complete\":\"Hidden\"}'", "ready?'Complete':'Hidden'")
# Use friendly, professional microcopy in profile-strength card.
s=s.replace("score===100?'Ready to be discovered':'Keep building'", "score===100?'Profile ready':'Complete your profile for better matches'")
# Café version may use Keep building text directly; make it positive too.
s=s.replace("score===100?'Ready to be discovered':'Keep building'", "score===100?'Profile ready':'Complete your profile for better matches'")
# Add a tiny info indicator beside Profile Strength label, with accessible title.
s=s.replace('>Profile Strength</span>', '>Profile Strength <span class="profile-info" title="Complete profiles get better visibility and matching">ⓘ</span></span>')
# Compact style for the icon and long microcopy on mobile.
s=s.replace('.wow-stat-label{', '.profile-info{font-size:12px;color:#a95820;vertical-align:1px}.wow-stat-label{') if '.wow-stat-label{' in s and '.profile-info{' not in s else s
p.write_text(s)
