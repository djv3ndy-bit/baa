from pathlib import Path
p=Path('dashboard.html');s=p.read_text()
# Trust banner styles
s=s.replace('.mobile-nav{display:none}', '.trust-banner{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:18px;padding:16px 18px;border:1px solid #edc7a8;border-radius:16px;background:#fff7ef;color:#5a2d13}.trust-banner strong,.trust-banner small{display:block}.trust-banner strong{font-size:15px}.trust-banner small{margin-top:4px;color:#746a61;line-height:1.45}.trust-banner.ready{border-color:#cde8d2;background:#f1faf3;color:#287443}.trust-badge{display:inline-flex;align-items:center;gap:5px;padding:5px 8px;border-radius:99px;background:#f3e8de;font-size:11px;font-weight:800}.trust-badge.verified{background:#e7f4ea;color:#287443}.mobile-nav{display:none}')
# Helpers before overview
needle='function overviewHtml(view){'
helper="""function profileVisibilityReady(){return currentRole==='barista'?[currentProfile.display_name,currentProfile.location,currentProfile.bio,currentProfile.availability,currentProfile.experience,currentProfile.avatar_url].every(Boolean)&&Array.isArray(currentProfile.skills)&&currentProfile.skills.length>0:[currentProfile.cafe_name,currentProfile.location,currentProfile.bio,currentProfile.avatar_url].every(Boolean)}
function trustBanner(){const ready=profileVisibilityReady(),verified=currentProfile.verification_status==='verified';return `<div class=\"trust-banner ${ready?'ready':''}\"><div><strong>${ready?'✓ Your profile can be visible':'🔒 Complete your profile to become visible'}</strong><small>${ready?(verified?'Your account is complete and verified.':'Your profile is complete. Verification is a separate trust check.'):'Incomplete profiles are hidden from discovery and matching to help keep BaristaMatch safe and reduce fake accounts.'}</small></div><span class=\"trust-badge ${verified?'verified':''}\">${verified?'✓ Verified':'${ready?\"Complete\":\"Hidden\"}'}</span></div>`}
"""
if helper not in s:s=s.replace(needle,helper+needle,1)
# Insert trust banner on every section rendering, after generated html.
old="document.getElementById('content').innerHTML=html;bindContentActions();"
new="document.getElementById('content').innerHTML=(name==='Account Settings'?'':trustBanner())+html;bindContentActions();"
s=s.replace(old,new,1)
# Include trust fields when saving and explicitly enable discoverability only if requirements met after save.
old2="currentProfile={...currentProfile,...payload};status.textContent='Profile saved! Your strength is now '+profileStrength()+'%.';"
new2="currentProfile={...currentProfile,...payload};const ready=profileVisibilityReady();const {error:visibilityError}=await activeClient.from('profiles').update({is_discoverable:ready}).eq('id',currentUser.id);if(visibilityError)throw visibilityError;currentProfile.is_discoverable=ready;status.textContent=ready?'Profile saved! You are now eligible to appear in discovery.':'Profile saved. Complete all required profile details to become visible.';"
s=s.replace(old2,new2,1)
# Filter candidate discovery to discoverable only (data is still available for legitimate application/match flows separately).
s=s.replace(".eq('role','barista')", ".eq('role','barista').eq('is_discoverable',true)")
p.write_text(s)
