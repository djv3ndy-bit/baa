// Run with Node after installing Playwright, or set BJM_PLAYWRIGHT_MODULE to its module path.
// Optionally set BJM_BROWSER_EXECUTABLE to a local Chromium/Chrome executable.
// The browser is isolated: every request is either a repo fixture or is blocked.
const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const {chromium}=require(process.env.BJM_PLAYWRIGHT_MODULE || 'playwright');
const repo=path.resolve(__dirname,'../..');
(async()=>{
 const raw=fs.readFileSync(repo+'/dashboard.html','utf8');
 const scripts=[...raw.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)].filter(m=>!m[1].includes('src=')).map(m=>m[2].replace(/^start\(\);$/m,''));
 const browser=await chromium.launch({headless:true,...(process.env.BJM_BROWSER_EXECUTABLE ? {executablePath:process.env.BJM_BROWSER_EXECUTABLE} : {})});
 const page=await browser.newPage({viewport:{width:1512,height:900}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/*',route=>{const u=new URL(route.request().url());if(u.hostname!=='preview.invalid')return route.abort();if(u.pathname==='/dashboard')return route.fulfill({contentType:'text/html',body:raw.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'')});if(u.pathname.startsWith('/assets/')||['/checkout.css','/dashboard-quiet-focus.css'].includes(u.pathname)){const p=repo+u.pathname;return fs.existsSync(p)?route.fulfill({path:p}):route.fulfill({status:404,body:''});}return route.fulfill({contentType:'application/json',body:'{}'});});
 await page.goto('https://preview.invalid/dashboard');
 await page.addScriptTag({content:fs.readFileSync(repo+'/dashboard-quiet-focus.js','utf8')});
 for(const content of scripts)await page.addScriptTag({content});
 // Keep the real navigation dispatcher, renderers, and bindContentActions.
 // Only startup authentication and billing I/O are replaced with local fixtures.
 await page.evaluate(()=>{window.originalDashboardChrome=[document.getElementById('app'),document.querySelector('.side'),document.getElementById('menu'),document.querySelector('.quiet-shell-header'),document.getElementById('dashboard-mobile-navigation')];});
 const results=[];
 for(const role of ['cafe_owner_manager','barista'])for(const populated of [false,true]){
  await page.evaluate(({role,populated})=>{
   currentRole=role;currentView=views[role];currentUser={id:'self',email:'layout@example.invalid',identities:[{provider:populated?'email':'google'}]};
   currentProfile={id:'self',role,display_name:role==='barista'?'Alex Morgan':null,cafe_name:role==='cafe_owner_manager'?'Local Café':null,location:'Miami, FL',bio:'A friendly neighborhood coffee team.',skills:['Espresso','Latte art'],availability:'Mornings',experience:'Two years',pay_expectation:'$18–22/hr',cafe_address:'Example address',open_hours:'Weekdays',shop_type:'Café',barista_preferences:['Friendly service'],is_discoverable:true,visible_to_cafes:true};
   currentDemographics={date_of_birth:'1995-02-04'};
   const cafe={id:'cafe',cafe_name:'Local Café',location:'Miami, FL',bio:'Our coffee team.',shop_type:'Café'};
   const barista={id:'barista',display_name:'Alex Morgan',location:'Miami, FL',skills:['Espresso'],bio:'Coffee professional.'};
   marketJobs=populated?[{id:'job1',owner_id:role==='cafe_owner_manager'?'self':'cafe',title:'Lead Barista',active:true,location:'Miami, FL',pay_min:18,pay_max:22,schedule:'Morning shifts',description:'A welcoming team with room to grow.',owner:cafe}]:[];
   applications=populated?[{id:'app1',job_id:'job1',barista_id:'barista',status:'matched',job:marketJobs[0],barista,created_at:'2026-09-01T12:00:00Z'}]:[];
   candidateProfiles=populated?[barista]:[];discoveryMatches=[];discoveryInterests=[];notificationRows=[];profileViews=[];
   const app=document.getElementById('app');app.classList.remove('role-cafe_owner_manager','role-barista');app.classList.add('role-'+role);app.hidden=false;document.getElementById('loading').hidden=true;
   document.getElementById('menu').innerHTML=currentView.menu.map(s=>`<button data-section="${s}"><span class="nav-icon">${BaristaMatchQuietFocus.menuIcon(s)}</span><span class="nav-label">${BaristaMatchQuietFocus.menuLabel(s,role)}</span></button>`).join('');
   document.getElementById('menu').onclick=e=>{const b=e.target.closest('[data-section]');if(b)openSection(b.dataset.section,currentView,currentRole)};
   loadAccountSubscription=async()=>{};reconcileBillingReturn=async()=>{};
   window.BaristaMatchCheckout={destroy(){},mount(){document.getElementById('checkout-intro').hidden=false;document.getElementById('checkout-spinner').hidden=true;document.getElementById('checkout-message-title').textContent='Secure payment form';document.getElementById('checkout-message-detail').textContent='Local layout fixture';}};
  },{role,populated});
  for(const width of [1512,1024,761,760,736,360,320]){
   await page.setViewportSize({width,height:900});
   await page.waitForTimeout(300); // Let the responsive drawer transition settle.
   const sections=role==='cafe_owner_manager'?['Overview','Job Posts','Discover','Candidates','Matches','Messages','Café Profile','Account Settings','Subscription','Overview']:['Overview','Discover','Matches','Messages','Profile Views','My Profile','Account Settings','Overview'];
   let chrome;
   for(const section of sections){
    await page.evaluate(s=>openSection(s,currentView,currentRole),section);await page.waitForTimeout(180);
    const m=await page.evaluate(()=>{const measure=s=>{const el=document.querySelector(s),r=el.getBoundingClientRect(),c=getComputedStyle(el);return {x:r.x,y:r.y,width:r.width,height:r.height,background:c.backgroundColor,borderRadius:c.borderRadius}};
     const bounds=r=>({left:r.left,right:r.right,top:r.top,bottom:r.bottom});
     // Ranges measure the full text, including text hidden by overflow/ellipsis.
     const navLabels=[...document.querySelectorAll(innerWidth>760?'.side .menu .nav-label':'.quiet-mobile-nav small')].filter(el=>el.getClientRects().length).map(el=>{
      const range=document.createRange();range.selectNodeContents(el);
      return {text:el.textContent.trim(),textBounds:bounds(range.getBoundingClientRect()),labelBounds:bounds(el.getBoundingClientRect()),buttonBounds:bounds(el.closest('button').getBoundingClientRect())};
     });
     return {section:currentSection,chromeMounted:originalDashboardChrome.every(el=>el.isConnected),hasPermanentTheme:document.body.classList.contains('prism-dashboard-page')&&document.getElementById('app').classList.contains('prism-dashboard-shell'),expectedTitle:BaristaMatchQuietFocus.menuLabel(currentSection,currentRole),visiblePageTitle:[...document.querySelectorAll('.top h1,#content h1')].filter(el=>el.getClientRects().length).map(el=>el.textContent.trim()),width:innerWidth,height:innerHeight,navLabels,scroll:document.documentElement.scrollWidth,chrome:{side:innerWidth>760?measure('.side'):null,nav:innerWidth>760?measure('.menu'):null,header:measure('.quiet-shell-header'),bottom:measure('.quiet-mobile-nav'),background:getComputedStyle(document.body).backgroundColor},content:measure('#content'),headings:[...document.querySelectorAll('.top h1,#content h1,#content h2,#content h3')].filter(el=>el.getClientRects().length).map(el=>({text:el.textContent,font:getComputedStyle(el).fontFamily})),buttons:[...document.querySelectorAll('#content button')].filter(el=>el.getClientRects().length).map(el=>{const r=el.getBoundingClientRect();return {text:el.textContent.trim(),left:r.x,right:r.right,width:r.width}})};});
    assert.ok(m.scroll<=width,JSON.stringify({role,populated,overflow:m}));
    if(!chrome)chrome=m.chrome;else assert.deepEqual(m.chrome,chrome,`shared chrome shifted: ${role}/${section}/${width}`);
    assert.ok(m.chromeMounted&&m.hasPermanentTheme,`Dashboard chrome was replaced or lost its theme on ${section}`);
    assert.equal(m.chrome.background,'rgb(255, 255, 255)',`Dashboard background changed on ${section}`);
    assert.ok(m.headings.length>0,`No visible heading ${section}`);
    if(section!=='Overview')assert.deepEqual(m.visiblePageTitle,[m.expectedTitle],`Missing or duplicated page title: ${role}/${section}/${width}`);
    assert.ok(m.headings.every(h=>!/(Georgia|Times New Roman)/i.test(h.font)),`Old serif heading returned on ${role}/${section}/${width}`);
    assert.ok(m.buttons.every(b=>b.left>=-1&&b.right<=width+1),JSON.stringify({role,populated,section,width,buttons:m.buttons}));
    assert.ok(m.navLabels.length>0,`No visible navigation labels: ${role}/${section}/${width}`);
    for(const label of m.navLabels){
     for(const [container,b] of Object.entries({label:label.labelBounds,button:label.buttonBounds,viewport:{left:0,right:width,top:0,bottom:m.height}})){
      const t=label.textBounds;
      assert.ok(t.left>=b.left-1&&t.right<=b.right+1&&t.top>=b.top-1&&t.bottom<=b.bottom+1,`Navigation label clips ${container}: ${JSON.stringify({role,populated,section,width,...label})}`);
     }
    }
    if(section==='Account Settings'&&!populated){
     const cardPadding=await page.locator('.google-password-card').evaluate(el=>parseFloat(getComputedStyle(el).paddingLeft));
     assert.ok(cardPadding>=16,`Provider security card content touches its rounded border at ${width}px`);
    }
    results.push({role,populated,section,width});

   }
  }
 }
 assert.deepEqual(errors,[]);
 await browser.close();console.log(JSON.stringify({passed:results.length,errors}));
})().catch(e=>{console.error(e);process.exit(1)});
