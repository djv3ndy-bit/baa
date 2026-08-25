from pathlib import Path

p=Path('dashboard.html')
s=p.read_text()

# 1) Add a dedicated account logout card in Account Settings.
settings_marker="const notificationSection=`<article class=\"card settings-card notification-card\""
if settings_marker not in s:
    raise SystemExit('notification settings marker not found')

account_section="const accountActionsSection=`<article class=\"card settings-card account-actions-card\"><div><h3>Account</h3><p>Manage your account session and sign out securely.</p></div><button class=\"secondary account-logout-button\" type=\"button\" data-account-logout>Log out</button></article>`;"
if 'data-account-logout' not in s:
    s=s.replace(settings_marker,account_section+settings_marker,1)

render_old="${passwordSection}</article>${notificationSection}${advancedSettings}</div>`"
render_new="${passwordSection}</article>${notificationSection}${accountActionsSection}${advancedSettings}</div>`"
if render_old in s:
    s=s.replace(render_old,render_new,1)
elif render_new not in s:
    raise SystemExit('settings render marker not found')

bind_old="content.querySelectorAll('[data-enable-notifications]').forEach(button=>button.onclick=()=>enableBrowserNotifications(button));"
bind_new="content.querySelectorAll('[data-enable-notifications]').forEach(button=>button.onclick=()=>enableBrowserNotifications(button));content.querySelectorAll('[data-account-logout]').forEach(button=>button.onclick=async()=>{button.disabled=true;button.textContent='Logging out…';await activeClient.auth.signOut();location.replace('/')});"
if bind_old in s and 'data-account-logout]).forEach' not in s:
    s=s.replace(bind_old,bind_new,1)

# 2) Add an account shortcut to the navigation menu for both roles if Settings is present.
# Keep existing product section names; this simply gives a polished account destination.
menu_render_old="document.getElementById('menu').innerHTML=view.menu.map((x,i)=>`<button class=\"${i?'':'active'}\" data-section=\"${x}\">${x}</button>`).join('');updateUnreadBadges();"
menu_render_new="document.getElementById('menu').innerHTML=view.menu.map((x,i)=>`<button class=\"${i?'':'active'}\" data-section=\"${x}\"><span class=\"nav-icon\" aria-hidden=\"true\"></span><span class=\"nav-label\">${x}</span></button>`).join('');updateUnreadBadges();"
if menu_render_old in s:
    s=s.replace(menu_render_old,menu_render_new,1)
elif 'class=\"nav-icon\"' not in s:
    raise SystemExit('menu render marker not found')

# 3) Premium Option-4 CSS overrides. Appended after existing CSS so behavior remains intact.
style_end='</style>'
css=r'''
/* BaristaMatch premium navigation — Option 4 */
.side{
  background:
    radial-gradient(circle at 11% 4%,rgba(169,88,32,.30),transparent 28%),
    radial-gradient(circle at 80% 28%,rgba(255,255,255,.035),transparent 22%),
    linear-gradient(118deg,#4b200b 0%,#321708 46%,#210d04 100%);
  box-shadow:0 12px 36px rgba(35,14,4,.18);
}
.brand{letter-spacing:-.02em}.brand img{box-shadow:0 8px 22px rgba(0,0,0,.18)}
.menu button{
  display:flex;align-items:center;gap:10px;min-width:0;
  border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.025);
  color:#f4e9df;border-radius:14px;padding:12px 13px;font-weight:750;
  transition:background .18s ease,border-color .18s ease,color .18s ease,transform .18s ease,box-shadow .18s ease;
}
.menu button:hover{background:rgba(255,255,255,.08);color:#fff;border-color:rgba(255,255,255,.25);transform:translateY(-1px)}
.menu button.active{background:#f8eadc;color:#321708;border-color:#f8eadc;box-shadow:0 8px 22px rgba(0,0,0,.16)}
.menu button[data-section="Messages"]:before{content:none!important}
.nav-icon{width:18px;height:18px;display:grid;place-items:center;flex:0 0 18px;font-size:16px;line-height:1}
.menu button[data-section="Overview"] .nav-icon:before{content:"▦"}
.menu button[data-section="Find Jobs"] .nav-icon:before,.menu button[data-section="Job Posts"] .nav-icon:before{content:"▣"}
.menu button[data-section="Candidates"] .nav-icon:before{content:"♙"}
.menu button[data-section="Matches"] .nav-icon:before{content:"♡";font-size:20px}
.menu button[data-section="Messages"] .nav-icon:before{content:"◌";font-size:21px}
.menu button[data-section="Profile Views"] .nav-icon:before{content:"◉"}
.menu button[data-section="My Profile"] .nav-icon:before,.menu button[data-section="Café Profile"] .nav-icon:before,.menu button[data-section="Profile"] .nav-icon:before{content:"◎"}
.menu button[data-section="Pricing"] .nav-icon:before,.menu button[data-section="Pricing & Subscription"] .nav-icon:before{content:"◇"}
.menu button[data-section="Account Settings"] .nav-icon:before,.menu button[data-section="Settings"] .nav-icon:before{content:"⚙"}
.nav-label{white-space:nowrap}.nav-badge{margin-left:auto;box-shadow:0 0 0 2px #321708}
.menu button.active .nav-badge{box-shadow:0 0 0 2px #f8eadc}
.sidefoot{display:none!important}.logout{display:none!important}
.account-actions-card{display:flex;align-items:center;justify-content:space-between;gap:18px}.account-actions-card h3{margin-bottom:7px}.account-actions-card p{margin:0;color:var(--muted);line-height:1.5}.account-logout-button{flex:0 0 auto}

@media(min-width:901px){
  .side{padding-top:26px}
  .menu{gap:8px}
}

@media(max-width:900px){
  .shell{display:block}
  .side{position:relative;top:auto;height:auto;min-height:0;padding:20px 18px 17px;border-radius:0 0 24px 24px;overflow:hidden}
  .brand{margin:0 4px 18px;font-size:23px}.brand img{width:48px;height:48px;border-radius:14px}
  .menu{display:flex;gap:9px;overflow-x:auto;overflow-y:hidden;padding:10px 3px 5px;margin:0 -3px;scrollbar-width:none;-webkit-overflow-scrolling:touch;scroll-snap-type:x proximity}
  .menu::-webkit-scrollbar{display:none}
  .menu button{flex:0 0 auto;min-height:48px;padding:11px 15px;border-radius:16px;scroll-snap-align:start;background:rgba(255,255,255,.025)}
  .menu button.active{background:#f8eadc;color:#321708;box-shadow:0 8px 24px rgba(0,0,0,.18)}
  .side:after{content:"";position:absolute;left:18px;right:18px;top:84px;height:1px;background:rgba(255,255,255,.13)}
  .main{min-width:0}
}

@media(max-width:560px){
  .side{padding:17px 14px 14px;border-radius:0 0 20px 20px}
  .brand{font-size:21px;margin-bottom:17px}.brand img{width:44px;height:44px}
  .side:after{top:76px;left:14px;right:14px}
  .menu{gap:8px;padding-top:11px}
  .menu button{min-height:44px;padding:10px 13px;font-size:14px;border-radius:15px}
  .nav-icon{width:17px;height:17px;flex-basis:17px}
  .account-actions-card{align-items:flex-start;flex-direction:column}.account-logout-button{width:100%}
}
'''
if 'BaristaMatch premium navigation — Option 4' not in s:
    s=s.replace(style_end,css+'\n'+style_end,1)

p.write_text(s)
print('Option 4 header patch applied')
