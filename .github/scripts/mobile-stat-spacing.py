from pathlib import Path
p=Path('dashboard.html')
s=p.read_text()
css='''\n/* Mobile stat-card spacing hardening */\n@media (max-width:760px){\n  .wow-stat{overflow:hidden!important;}\n  .wow-stat .wow-bars{position:static!important;margin-top:24px!important;padding-top:0!important;}\n  .wow-stat .wow-bars i{display:block;}\n  .wow-stat strong{margin-bottom:10px!important;}\n  .wow-stat [class*="trend"],.wow-stat [class*="status"]{display:block!important;line-height:1.3!important;margin-top:4px!important;margin-bottom:0!important;}\n}\n'''
if '/* Mobile stat-card spacing hardening */' not in s:
    s=s.replace('</style>',css+'</style>',1)
p.write_text(s)
