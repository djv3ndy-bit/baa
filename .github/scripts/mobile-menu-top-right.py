from pathlib import Path
p=Path('dashboard.html');s=p.read_text()
css='''
/* Professional mobile menu placement — top right */
@media(max-width:760px){
  .mobile-menu-toggle{left:auto!important;right:14px!important;top:calc(11px + env(safe-area-inset-top))!important}
  .top{padding:12px 72px 12px 16px!important}
  body.mobile-menu-open .mobile-menu-toggle{left:auto!important;right:14px!important}
  .cafe-wow-head{padding-top:14px!important}
}
'''
if 'Professional mobile menu placement' not in s:s=s.replace('</style>',css+'</style>',1)
p.write_text(s)
