from pathlib import Path
p=Path('dashboard.html');s=p.read_text()
old='<article class="wow-stat"><span class="wow-stat-label">New Candidates</span><strong>${newCandidates}</strong><span class="wow-stat-trend">Ready to review</span>${chart([18,44,16,35,76,40,62,48])}</article>'
new='<article class="wow-stat wow-stat-link" data-go="Candidates" role="button" tabindex="0" aria-label="Review new candidates"><span class="wow-stat-label">New Candidates</span><strong>${newCandidates}</strong><span class="wow-stat-trend">Ready to review →</span>${chart([18,44,16,35,76,40,62,48])}</article>'
if old not in s: raise SystemExit('candidate stat target not found')
s=s.replace(old,new,1)
css='''.wow-stat-link{cursor:pointer;transition:transform .16s ease,box-shadow .16s ease,border-color .16s ease}.wow-stat-link:hover{transform:translateY(-2px);box-shadow:0 18px 42px #32170816;border-color:#dfc8b8}.wow-stat-link:focus-visible{outline:3px solid #a9582030;outline-offset:3px}@media(max-width:760px){.wow-stat-link:active{transform:scale(.985)}}\n'''
if '.wow-stat-link{' not in s:s=s.replace('/* BARISTAMATCH CREATIVE CARD DASHBOARD */',css+'/* BARISTAMATCH CREATIVE CARD DASHBOARD */',1)
# Add keyboard activation for data-go cards, keeping existing button navigation unchanged.
needle="function bindContentActions(){const content=document.getElementById('content');content.querySelectorAll('[data-go]').forEach(button=>button.onclick=()=>openSection(button.dataset.go,currentView,currentRole));"
repl="function bindContentActions(){const content=document.getElementById('content');content.querySelectorAll('[data-go]').forEach(button=>{button.onclick=()=>openSection(button.dataset.go,currentView,currentRole);if(button.getAttribute('role')==='button')button.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();openSection(button.dataset.go,currentView,currentRole)}}});"
if needle not in s: raise SystemExit('bindContentActions target not found')
s=s.replace(needle,repl,1)
p.write_text(s)
