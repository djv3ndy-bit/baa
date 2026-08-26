from pathlib import Path
p=Path('dashboard.html')
s=p.read_text()
css=r'''
/* Professional mobile dashboard v2 */
@media(max-width:760px){
  body{background:#fbf7f1;overflow-x:hidden;padding-bottom:calc(86px + env(safe-area-inset-bottom))}
  .shell{display:block;min-height:100vh}
  .side{display:none!important}
  .main{width:100%;min-width:0}
  .top{position:sticky;top:0;z-index:40;min-height:60px;padding:10px 16px;background:rgba(251,247,241,.94);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);border-bottom:1px solid #eadfd5}
  .top h1{font-size:20px}.rolebadge{font-size:10px;padding:7px 10px}
  .content{padding:14px 14px 24px;max-width:none}
  .welcome,.wow-welcome{display:block;position:relative;min-height:168px;margin:0 0 14px;padding:22px 20px;border-radius:24px;overflow:hidden;box-shadow:0 10px 28px #32170812}
  .welcome h2,.wow-welcome h2{font-size:29px;line-height:1.05;max-width:72%;margin:0 0 8px}
  .welcome p,.wow-welcome p{font-size:14px;line-height:1.45;max-width:68%}
  .welcome .primary,.wow-welcome .primary{position:absolute;left:20px;bottom:18px;padding:10px 13px;font-size:12px}
  .wow-profile-chip{position:absolute!important;top:16px!important;right:14px!important;max-width:52%;padding:8px 10px!important;border-radius:16px!important;box-shadow:0 8px 20px #32170816!important}
  .wow-profile-chip strong{font-size:12px!important}.wow-profile-chip small{font-size:10px!important}
  .stats,.wow-stats{grid-template-columns:repeat(2,minmax(0,1fr))!important;gap:10px!important;margin:0 0 14px!important}
  .stat,.wow-stat{min-height:132px!important;padding:15px!important;border-radius:20px!important}
  .stat span,.wow-stat span{font-size:11px!important}.stat strong,.wow-stat strong{font-size:28px!important;margin-top:6px!important}
  .wow-stat small{font-size:10px!important;margin-top:4px!important}
  .wow-bars{height:30px!important;gap:5px!important;margin-top:auto!important}.wow-bars i{min-width:0!important}
  .grid,.wow-grid{grid-template-columns:1fr!important;gap:12px!important}
  .card{padding:17px;border-radius:20px}.card h3{font-size:18px}
  .section-head{align-items:flex-start}.section-head h2{font-size:27px}
  .item{padding:12px 0}.itemtext b{font-size:14px}.itemtext small{font-size:12px}
  .job-item{display:grid;grid-template-columns:44px minmax(0,1fr);gap:10px}.job-item>[data-apply-job]{grid-column:1/-1;width:100%;min-width:0;margin-top:4px}
  .messages-workspace{display:block;min-height:calc(100vh - 160px);border-radius:18px}.conversation-sidebar{border-right:0}.chat-panel{min-height:calc(100vh - 170px)}
  .profile-dialog{width:calc(100% - 16px);max-height:94vh;border-radius:22px}.profile-form{padding:20px 16px}.form-grid{grid-template-columns:1fr}.form-wide{grid-column:auto}
  .mobile-nav{position:fixed!important;left:10px!important;right:10px!important;bottom:calc(8px + env(safe-area-inset-bottom))!important;z-index:100!important;display:grid!important;grid-template-columns:repeat(5,1fr)!important;gap:2px!important;padding:7px!important;background:rgba(50,23,8,.96)!important;border:1px solid #ffffff24!important;border-radius:22px!important;box-shadow:0 14px 40px #210f0790!important;backdrop-filter:blur(18px)!important;-webkit-backdrop-filter:blur(18px)!important}
  .mobile-nav button{min-width:0!important;border:0!important;background:transparent!important;color:#eadfd5!important;padding:8px 3px!important;border-radius:15px!important;font-size:10px!important;font-weight:800!important;white-space:nowrap!important;overflow:hidden!important;text-overflow:ellipsis!important}
  .mobile-nav button.active{background:#fff!important;color:#321708!important}
  .completed-profile-grid{grid-template-columns:1fr!important}.profile-detail{grid-template-columns:1fr!important;gap:5px!important}
  .settings-stack{gap:12px!important}
}
@media(max-width:390px){
  .content{padding-left:10px;padding-right:10px}
  .stats,.wow-stats{gap:8px!important}
  .stat,.wow-stat{padding:13px!important;min-height:124px!important}
  .welcome h2,.wow-welcome h2{font-size:25px;max-width:70%}
  .mobile-nav{left:6px!important;right:6px!important}.mobile-nav button{font-size:9px!important}
}
'''
if '/* Professional mobile dashboard v2 */' in s:
    raise SystemExit('already applied')
idx=s.find('</style>')
if idx<0: raise SystemExit('style closing tag not found')
s=s[:idx]+css+s[idx:]
p.write_text(s)
