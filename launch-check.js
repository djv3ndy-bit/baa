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
console.log('BaristaMatch launch readiness static checks passed');
