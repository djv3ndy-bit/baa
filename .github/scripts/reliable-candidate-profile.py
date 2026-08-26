from pathlib import Path
p=Path('dashboard.html');s=p.read_text()
old="content.querySelectorAll('[data-view-barista]').forEach(button=>button.onclick=()=>openCandidate(button.dataset.viewBarista));"
new="content.querySelectorAll('[data-view-barista]').forEach(button=>button.onclick=()=>openCandidateReliable(button.dataset.viewBarista));"
if old not in s: raise SystemExit('view handler target not found')
s=s.replace(old,new,1)
anchor='function bindContentActions(){'
helper=r'''async function openCandidateReliable(id){
  let profile=candidateProfiles.find(item=>item.id===id)||applications.map(app=>app.barista).find(item=>item&&item.id===id);
  if(!profile){
    const {data,error}=await activeClient.from('profiles').select('id,display_name,location,bio,skills,availability,experience,pay_expectation,video_path,avatar_url').eq('id',id).maybeSingle();
    if(error){alert('We could not load this barista profile. Please try again.');console.error('Candidate profile lookup failed',error);return}
    profile=data;
  }
  if(!profile){alert('This barista profile is no longer available.');return}
  if(!candidateProfiles.some(item=>item.id===profile.id))candidateProfiles.push(profile);
  return openCandidate(profile.id);
}
'''
if helper not in s:s=s.replace(anchor,helper+anchor,1)
p.write_text(s)
