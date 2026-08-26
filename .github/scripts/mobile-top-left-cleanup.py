from pathlib import Path
p=Path('dashboard.html');s=p.read_text()
css='''
/* Mobile top-left polish: keep menu clear of dashboard hero */
@media(max-width:760px){
  .top{min-height:68px!important;padding:12px 14px 12px 72px!important;background:rgba(251,247,241,.98)!important}
  .top h1{font-size:22px!important;line-height:1.1!important}
  .mobile-menu-toggle{position:fixed!important;top:calc(11px + env(safe-area-inset-top))!important;left:14px!important;width:46px!important;height:46px!important;border-radius:14px!important;font-size:22px!important;box-shadow:0 6px 18px #3217081c!important}
  .content{padding-top:18px!important}
  .cafe-wow-head{padding-top:14px!important}
  .cafe-wow-greeting{margin-left:0!important;padding-left:0!important;line-height:1.3!important}
  .cafe-wow h2{margin-top:4px!important;line-height:1.02!important}
  .cafe-identity{position:relative!important;top:auto!important;left:auto!important;right:auto!important;margin-top:18px!important;width:min(100%,390px)!important;max-width:100%!important}
  .cafe-wow-head{padding-bottom:24px!important}
  .cafe-wow-head:after,.cafe-wow-head:before{display:none!important}
}
'''
if '/* Mobile top-left polish:' not in s:s=s.replace('</style>',css+'</style>',1)
p.write_text(s)
