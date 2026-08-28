const fs=require('fs');
const requiredHtml=['index.html','signup.html','login.html','reset-password.html','dashboard.html','support.html','support-admin.html','terms.html','privacy.html'];
for(const file of requiredHtml){
  if(!fs.existsSync(file)) throw new Error(`Missing ${file}`);
  const src=fs.readFileSync(file,'utf8');
  if(!src.includes('<meta name="viewport"')) throw new Error(`${file}: missing responsive viewport`);
  if(!src.includes('</html>')) throw new Error(`${file}: incomplete HTML`);
}
const dashboard=fs.readFileSync('dashboard.html','utf8');
for(const token of ['/api/send-message','/api/apply-job','/api/match-application','refreshNotifications','subscribeNotifications','reportClientError','mark_conversation_read','nav-badge','conversation-unread']){
  if(!dashboard.includes(token)) throw new Error(`dashboard missing ${token}`);
}
if(dashboard.includes('event.currentTarget.reset()')) throw new Error('Unsafe async event.currentTarget.reset pattern is present');
if((dashboard.match(/<h2>Profile Views<\/h2>/g)||[]).length>1) throw new Error('Profile Views heading duplicated in static dashboard');
for(const file of ['api/send-message.js','api/apply-job.js','api/match-application.js','api/report-error.js','api/support.js','api/support-admin.js','api/delete-account.js']){
  if(!fs.existsSync(file)) throw new Error(`Missing ${file}`);
}
const signup=fs.readFileSync('signup.html','utf8');
if(!signup.includes('/privacy.html')||!signup.includes('/terms.html')||!signup.includes('name="terms"')) throw new Error('Signup legal consent links missing');
if(!signup.includes('class="login-link" href="/login.html"')) throw new Error('Signup login link is not routed to login');
const login=fs.readFileSync('login.html','utf8');
if(!login.includes('resetPasswordForEmail')||!login.includes('/reset-password.html')) throw new Error('Password reset request flow is missing');
const resetPassword=fs.readFileSync('reset-password.html','utf8');
if(!resetPassword.includes('href="/login.html">Request another reset link</a>')) throw new Error('Expired reset link recovery does not return to login');

// Marketplace trust, location, and responsive regression checks.
for(const token of ['barista-image-field','preferred_city','preferred_state','preferred_postal_code','address_line1','postal_code','jobMatchesBaristaLocation','profileVisibilityReady']){
  if(!dashboard.includes(token)) throw new Error(`dashboard missing trust/location token ${token}`);
}
if(dashboard.includes(".wow-stat:nth-child(4) .profile-info{font-size:12px;color:#a95820;vertical-align:1px}.wow-stat-label{color:#dbcbbc}")) throw new Error('Dashboard has global wow-stat label color bleed');
const homepage=fs.readFileSync('index.html','utf8');
if(!homepage.includes('href="/support.html">Help Center</a>')||!homepage.includes('href="/support.html">Contact Us</a>')) throw new Error('Homepage support links are not routed to support page');

// Mobile interaction regressions.
const mobileHome=fs.readFileSync('mobile/app/home.tsx','utf8');
if(!mobileHome.includes("router.push('/settings')")) throw new Error('Mobile dashboard settings button is not routed to Settings');
if(mobileHome.includes('onPress={logout}')) throw new Error('Mobile dashboard settings button still logs the user out');
const mobileDiscover=fs.readFileSync('mobile/app/discover.tsx','utf8');
const mobileCandidates=fs.readFileSync('mobile/app/candidates.tsx','utf8');
const mobileChat=fs.readFileSync('mobile/app/chat/[id].tsx','utf8');
if(!mobileDiscover.includes("authenticatedApi('/apply-job'")) throw new Error('Mobile application action bypasses the authenticated API');
if(!mobileCandidates.includes("authenticatedApi('/match-application'")) throw new Error('Mobile match action bypasses the authenticated API');
if(!mobileChat.includes("authenticatedApi('/send-message'")) throw new Error('Mobile messaging action bypasses the authenticated API');

console.log('BaristaMatch launch readiness static checks passed');
