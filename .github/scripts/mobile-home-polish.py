from pathlib import Path
import re
p=Path('index.html')
s=p.read_text()
# Add a visible mobile login action before hamburger menu.
if 'id="mobile-login"' not in s:
    s=s.replace('<button class="mobile-menu" id="mobile-menu"', '<a class="mobile-login" id="mobile-login" href="/login.html">Log in</a><button class="mobile-menu" id="mobile-menu"', 1)
# Append mobile-specific polish just before closing style.
css=r'''
/* Premium mobile homepage polish */
.mobile-login{display:none}
@media(max-width:680px){
  body{background:linear-gradient(180deg,#fffdf9 0%,#fbf7f1 54%,#fffaf5 100%)}
  .wrap{width:min(100% - 28px,1180px)}
  .site-header{background:#fffdf9f7;box-shadow:0 3px 18px #3217080b}
  .nav{min-height:78px;gap:10px}
  .brand{font-size:21px;letter-spacing:-.02em;min-width:0}
  .brand img{width:42px;height:42px}
  .mobile-login{display:inline-flex;margin-left:auto;align-items:center;justify-content:center;border:1px solid #d8c8ba;border-radius:999px;padding:9px 14px;background:#fff;color:var(--brown);font-size:13px;font-weight:850;box-shadow:0 6px 18px #3217080a}
  .mobile-menu{display:grid!important;place-items:center;margin-left:0;width:46px;height:46px;border-radius:15px;box-shadow:0 6px 18px #3217080b}
  .hero{background:radial-gradient(circle at 88% 12%,#f5e5d5 0,transparent 34%),linear-gradient(180deg,#fff 0%,#fffaf5 100%)}
  .hero-inner{display:block;min-height:auto}
  .hero-copy{padding:48px 0 30px}
  .hero h1{font-size:clamp(46px,13vw,62px);line-height:.98;letter-spacing:-.06em;margin-bottom:24px}
  .hero-copy>p{font-size:18px;line-height:1.48;margin-bottom:28px;color:#55483f}
  .role-grid{grid-template-columns:1fr;gap:14px;max-width:none}
  .role-card{min-height:142px;padding:20px;border-radius:22px;grid-template-columns:58px 1fr;gap:16px;align-items:center;box-shadow:0 14px 34px #3217080d;background:linear-gradient(145deg,#fff,#fff9f3)}
  .role-card.hiring{background:linear-gradient(145deg,#fff,#f1f8f3)}
  .role-icon{width:58px;height:58px;border-radius:17px}
  .role-card strong{font-size:21px;letter-spacing:-.02em}
  .role-card small{font-size:14px;line-height:1.45;min-height:0}
  .role-card b{font-size:14px;margin-top:13px}
  .trust{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:22px}
  .trust span{min-height:46px;padding:11px 12px;border:1px solid #eadfd5;border-radius:14px;background:#ffffffbd;font-size:11px;line-height:1.25;box-shadow:0 5px 16px #32170808}
  .hero-media{min-height:400px;margin:26px -14px 0;border-radius:26px 26px 0 0;overflow:hidden}
  .hero-media:before{background:linear-gradient(180deg,#fff 0%,#ffffff2b 16%,transparent 34%)}
  .hero-photo{object-position:center 35%}
  .phone{width:154px;height:315px;right:6%;bottom:-18px;border-radius:28px;padding:7px}
  .phone-screen{border-radius:22px;padding:14px 10px}
  .phone-bar{margin-bottom:12px;font-size:8px}
  .phone-card{padding:9px;border-radius:12px}
  .phone-card h3{font-size:12px}.phone-card p{font-size:7px}.pills span{font-size:6px;padding:3px 4px}
  .phone-match{margin-top:10px}.phone-person{gap:6px}.phone-person .avatar{width:24px;height:24px;font-size:7px}.phone-person small{font-size:6px}
  .section{padding:50px 0}
  .title{font-size:34px;margin-bottom:20px}
  .how-grid{grid-template-columns:1fr;gap:22px}
  .steps{grid-template-columns:1fr;gap:4px}
  .step{display:grid;grid-template-columns:58px 1fr;text-align:left;gap:14px;align-items:center;padding:10px 0}
  .step-icon{margin:0;width:56px;height:56px;font-size:24px}
  .step h3{margin:0 0 5px}.step p{font-size:13px}
  .community{min-height:370px;border-radius:22px}
  .community:after{background:linear-gradient(180deg,#fff 0%,#fffffff5 52%,#ffffff88 74%,transparent)}
  .community-copy{width:100%;padding:26px}
  .community h3{font-size:27px}.community p{font-size:14px}.checks{font-size:13px}
  .audience{grid-template-columns:1fr;gap:18px}
  .audience-card{min-height:430px;border-radius:24px}
  .audience-card.barista:after{background:linear-gradient(180deg,transparent 0%,#261108b8 42%,#261108 68%)}
  .audience-card.cafe:after{background:linear-gradient(180deg,#fffffff5 0%,#ffffffdd 55%,#ffffff5c 78%,transparent)}
  .audience-copy,.audience-card.barista .audience-copy{width:100%;margin:0;padding:28px;justify-content:flex-end}
  .audience-card.cafe .audience-copy{justify-content:flex-start}
  .audience h3{font-size:31px}.audience ul{font-size:13px}.audience-note{font-size:11px}
  .benefits{padding:46px 0}.benefits h2{font-size:27px;line-height:1.12}
  .benefit-grid{grid-template-columns:1fr 1fr;gap:20px 0}
  .benefit,.benefit:nth-child(3){border-left:0;padding:0 12px}.benefit:nth-child(even){border-left:1px solid var(--line)}
  .preview-section{padding:12px 0 46px}.previews{grid-template-columns:1fr;gap:14px;padding:10px;border-radius:20px}.preview{min-height:310px}
  .final{padding-bottom:42px}.final-panel{grid-template-columns:1fr;border-radius:22px}.final-image{height:155px}.final-image:after{background:linear-gradient(180deg,transparent,#fff)}.final-copy{padding:26px 22px}.final h2{font-size:28px}.choice{margin:0 18px 14px;padding:20px}.choice:last-child{margin-bottom:20px}
  footer{padding:38px 0 24px}.footer-grid{grid-template-columns:1fr 1fr;gap:28px 18px}.footer-grid>div:first-child{grid-column:1/-1}.footer-bottom{display:grid;gap:8px}
}
'''
if 'Premium mobile homepage polish' not in s:
    s=s.replace('</style>',css+'</style>',1)
# Sync login visibility to authenticated state via existing user-actions element.
sync=r'''<script>
(()=>{const login=document.getElementById('mobile-login'),user=document.getElementById('user-actions');if(!login||!user)return;const sync=()=>{login.hidden=!user.hidden};sync();new MutationObserver(sync).observe(user,{attributes:true,attributeFilter:['hidden']})})();
</script>'''
if 'mobile-login' in s and 'MutationObserver(sync)' not in s:
    s=s.replace('</body>',sync+'</body>',1)
p.write_text(s)
