from pathlib import Path
p=Path('dashboard.html');s=p.read_text()
# Global font consistency for selects.
s=s.replace('button,input,textarea{font:inherit}', 'button,input,textarea,select{font:inherit}', 1)
# Make avatar checklist copy role-aware.
old="const labels={display_name:'Add your name',cafe_name:'Add your café name',avatar_url:'Add your café logo or photo',location:'Add your location',bio:'Tell your story',skills:'Add skills and specialties',availability:'Set your availability',experience:'Share your experience',pay_expectation:'Add desired pay',video_path:'Add an optional coffee video'};"
new="const labels={display_name:'Add your name',cafe_name:'Add your café name',avatar_url:currentRole==='barista'?'Add your profile photo':'Add your café logo or photo',location:'Add your location',bio:'Tell your story',skills:'Add skills and specialties',availability:'Set your availability',experience:'Share your experience',pay_expectation:'Add desired pay',video_path:'Add an optional coffee video'};"
if old in s:s=s.replace(old,new,1)
# Align frontend discoverability exactly with profileStrength required fields.
old2="function profileVisibilityReady(){return currentRole==='barista'?[currentProfile.display_name,currentProfile.location,currentProfile.bio,currentProfile.availability,currentProfile.experience,currentProfile.avatar_url].every(Boolean)&&Array.isArray(currentProfile.skills)&&currentProfile.skills.length>0:[currentProfile.cafe_name,currentProfile.location,currentProfile.bio,currentProfile.avatar_url].every(Boolean)}"
new2="function profileVisibilityReady(){return currentRole==='barista'?[currentProfile.display_name,currentProfile.avatar_url,currentProfile.location,currentProfile.bio,currentProfile.availability,currentProfile.experience,currentProfile.pay_expectation].every(Boolean)&&Array.isArray(currentProfile.skills)&&currentProfile.skills.length>0:[currentProfile.cafe_name,currentProfile.avatar_url,currentProfile.location,currentProfile.bio,currentProfile.experience].every(Boolean)&&Array.isArray(currentProfile.skills)&&currentProfile.skills.length>0}"
if old2 not in s: raise SystemExit('profileVisibilityReady target not found')
s=s.replace(old2,new2,1)
p.write_text(s)
