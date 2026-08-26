from pathlib import Path
p=Path('dashboard.html')
s=p.read_text()
css=r'''
/* Mobile full navigation drawer */
.mobile-menu-toggle,.mobile-menu-backdrop{display:none}
@media (max-width:760px){
  .mobile-menu-toggle{display:grid;place-items:center;position:fixed;top:calc(10px + env(safe-area-inset-top));left:12px;z-index:1100;width:46px;height:46px;border:1px solid #e7ddd2;border-radius:15px;background:rgba(255,255,255,.96);color:#321708;font-size:24px;font-weight:900;box-shadow:0 8px 24px #32170824;backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px)}
  .mobile-menu-backdrop{display:block;position:fixed;inset:0;z-index:1040;background:rgba(25,11,5,.42);opacity:0;pointer-events:none;transition:opacity .2s ease}
  .side{display:flex!important;position:fixed!important;left:0!important;top:0!important;bottom:0!important;width:min(84vw,330px)!important;height:100dvh!important;z-index:1050!important;transform:translateX(-105%)!important;transition:transform .24s ease!important;overflow-y:auto!important;padding-top:calc(22px + env(safe-area-inset-top))!important;box-shadow:18px 0 50px #160a0566!important}
  body.mobile-menu-open{overflow:hidden}
  body.mobile-menu-open .side{transform:translateX(0)!important}
  body.mobile-menu-open .mobile-menu-backdrop{opacity:1;pointer-events:auto}
  body.mobile-menu-open .mobile-menu-toggle{left:min(calc(84vw - 58px),272px);background:#fff;color:#321708}
  .side .menu{display:grid!important;gap:7px!important}
  .side .menu button{display:flex!important;align-items:center!important;width:100%!important;min-height:48px!important;padding:12px 14px!important;border-radius:13px!important;font-size:15px!important}
  .side .brand{margin-bottom:24px!important}
  .sidefoot{display:block!important;padding-bottom:calc(20px + env(safe-area-inset-bottom))!important}
  .top{padding-left:70px!important}
}
'''
if '/* Mobile full navigation drawer */' not in s:
    s=s.replace('</style>',css+'\n</style>',1)
html='''\n<button class="mobile-menu-toggle" id="mobile-menu-toggle" type="button" aria-label="Open navigation" aria-expanded="false">☰</button>\n<div class="mobile-menu-backdrop" id="mobile-menu-backdrop" aria-hidden="true"></div>\n'''
if 'id="mobile-menu-toggle"' not in s:
    s=s.replace('</body>',html+'</body>',1)
js=r'''
<script>
(function(){
  const toggle=document.getElementById('mobile-menu-toggle');
  const backdrop=document.getElementById('mobile-menu-backdrop');
  if(!toggle||!backdrop)return;
  const close=()=>{document.body.classList.remove('mobile-menu-open');toggle.setAttribute('aria-expanded','false');toggle.textContent='☰';};
  const open=()=>{document.body.classList.add('mobile-menu-open');toggle.setAttribute('aria-expanded','true');toggle.textContent='×';};
  toggle.addEventListener('click',()=>document.body.classList.contains('mobile-menu-open')?close():open());
  backdrop.addEventListener('click',close);
  document.addEventListener('click',e=>{if(e.target.closest('#menu button[data-section]'))close();});
  window.addEventListener('resize',()=>{if(innerWidth>760)close();});
})();
</script>
'''
if 'mobile-menu-open' not in s.split('</body>')[0][-3000:]:
    s=s.replace('</body>',js+'</body>',1)
p.write_text(s)
