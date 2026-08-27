from pathlib import Path
p=Path('index.html');s=p.read_text()
# Remove public pricing navigation; pricing stays post-signup/dashboard.
s=s.replace('<a href="/pricing.html">Pricing</a>','')
# Mission-first copy.
s=s.replace('<span class="eyebrow">Built for specialty coffee</span><h1>Great baristas and great cafés belong together.</h1><p>A simple, focused hiring marketplace with clear pay, real profiles, coffee showcase videos, and one-tap interest.</p><div class="hero-actions"><button class="btn dark" data-signup-role="barista">Find barista jobs</button><button class="btn" data-signup-role="cafe_owner_manager">Hire a barista</button></div>', '<span class="eyebrow">Made for the coffee community</span><h1>Great cafés and great baristas <em>belong together.</em></h1><p>BaristaMatch makes it easier for cafés and baristas to find each other, connect locally, and move from discovery to conversation.</p><div class="hero-actions role-actions"><button class="role-cta" data-signup-role="barista"><strong>I’m a Barista</strong><small>Find café opportunities that fit you.</small><b>Join for free →</b></button><button class="role-cta hiring" data-signup-role="cafe_owner_manager"><strong>I’m Hiring</strong><small>Find and connect with great baristas.</small><b>Start hiring →</b></button></div><div class="home-trust"><span>⌖ Local matches</span><span>◯ Private messaging</span><span>♢ Complete profiles</span><span>☕ Built for the coffee community</span></div>')
# Remove giant blueprint mockup and demo controls from public home: sell the product rather than show a prototype collage.
start=s.find('    <div class="mockup">')
end=s.find('  </section>',start)
if start!=-1 and end!=-1:
    block=s[start:end]
    s=s.replace(block,'',1)
# Update how-it-works wording.
s=s.replace('Swipe. Match. Chat. Get hired.','Simple steps. Better matches.')
s=s.replace('1. Create a profile','1. Discover').replace('Baristas add experience, availability, skills, and expected pay. Coffee shops add their open role, schedule, and culture.','Find cafés or baristas near you based on location and the details that matter.')
s=s.replace('2. Show interest','2. Match').replace('Each side reviews focused cards instead of searching through a crowded general job board.','Connect when there’s genuine interest and a potential fit.')
s=s.replace('3. Match and interview','3. Chat').replace('Mutual interest opens chat and interview scheduling.','Message directly after matching and move the conversation forward.')
# Softer industry-solution copy.
s=s.replace('Find the right local coffee shop.','Find a café where you belong.')
s=s.replace('Hire baristas without the job-board noise.','Hire great baristas. Faster.')
s=s.replace('A hiring service made for the coffee industry.','Why cafés and baristas choose BaristaMatch.')
# Never expose café subscription pricing on homepage/footer.
s=s.replace('<a href="/pricing.html">Pricing</a>','')
# Visual upgrade while preserving auth behavior.
css='''
/* Solution-first public homepage */
.hero{padding:70px 0 56px}.hero-copy{text-align:left;max-width:1180px;margin:0}.hero-copy h1{max-width:760px;font-family:Arial,sans-serif;font-weight:850;letter-spacing:-.045em}.hero-copy h1 em{font-style:normal;color:var(--caramel)}.hero-copy p{margin:0 0 28px;max-width:660px}.role-actions{justify-content:flex-start;display:grid;grid-template-columns:repeat(2,minmax(220px,320px));gap:14px}.role-cta{border:1px solid var(--line);border-radius:18px;background:#fff;padding:20px;text-align:left;display:grid;gap:7px;color:var(--brown);box-shadow:0 10px 28px #3217080a}.role-cta:hover{transform:translateY(-2px);box-shadow:0 15px 35px #32170813}.role-cta strong{font-size:19px}.role-cta small{font-size:13px;color:var(--muted);line-height:1.45}.role-cta b{font-size:13px;color:var(--caramel);margin-top:8px}.role-cta.hiring{background:#f5faf5}.role-cta.hiring b{color:var(--green)}.home-trust{display:flex;gap:22px;flex-wrap:wrap;margin-top:25px;font-size:12px;font-weight:800;color:var(--brown)}.section{border-top:1px solid #eee4da}.card{box-shadow:0 10px 30px #32170808;transition:.18s ease}.card:hover{transform:translateY(-2px)}#baristas .card:first-of-type,#cafes .card:first-of-type{border-top:3px solid var(--caramel)}#cafes .card:first-of-type{border-top-color:var(--green)}@media(max-width:700px){.hero{padding-top:42px}.hero-copy h1{font-size:44px}.role-actions{grid-template-columns:1fr}.home-trust{gap:12px}.section{padding:52px 0}}
'''
s=s.replace('</style>',css+'</style>',1)
p.write_text(s)
