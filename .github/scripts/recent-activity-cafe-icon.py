from pathlib import Path
p=Path('dashboard.html')
s=p.read_text()
old="icon=app.status==='matched'?'♡':'↗'"
new="icon=app.status==='matched'?'<img src=\"/assets/vintage-cafe-mark-small.png\" alt=\"Café\">':'↗'"
if old not in s:
    raise SystemExit('target activity icon expression not found')
s=s.replace(old,new,1)
css='''\n/* Match activity uses the same café storefront icon as the homepage */\n.wow-dot img{width:28px;height:28px;object-fit:contain;display:block}\n@media(max-width:720px){.wow-dot img{width:30px;height:30px}}\n'''
if 'Match activity uses the same café storefront icon as the homepage' not in s:
    s=s.replace('</style>',css+'</style>',1)
p.write_text(s)
