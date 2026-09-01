import fs from 'node:fs';
const requiredHtml=['index.html','signup.html','login.html','reset-password.html','dashboard.html','pricing.html','cafe-trial.html','support.html','support-admin.html','terms.html','privacy.html','owner-dashboard.html','owner-growth.html','owner-subscriptions.html','owner-marketplace.html','owner-audience.html','owner-accounts.html'];
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
for(const file of ['api/_billing.js','api/billing.js','mobile-billing-return.html']){
  if(!fs.existsSync(file)) throw new Error(`Missing Stripe billing file ${file}`);
}
const stripeCheckout=fs.readFileSync('api/billing.js','utf8');
const stripeWebhook=stripeCheckout;
if(!stripeCheckout.includes('integration_identifier')||stripeCheckout.includes('payment_method_types')) throw new Error('Stripe Checkout configuration is unsafe or incomplete');
if(!stripeWebhook.includes('constructEvent')||!stripeWebhook.includes('STRIPE_WEBHOOK_SECRET')) throw new Error('Stripe webhook signature verification is missing');
if(!stripeCheckout.includes('process.env.BILLING_ENABLED !== "true"')||!stripeCheckout.includes('billingPaused: true')) throw new Error('Stripe billing kill switch is not enforced');
if(dashboard.includes("views.cafe_owner_manager.menu.push('Subscription')")) throw new Error('Subscription management must live inside café Account Settings');
for(const token of ["currentRole==='cafe_owner_manager'?`<article",'<h3>Subscription</h3>','Next billing date:','Manage subscription',"name==='Account Settings'&&role==='cafe_owner_manager'"]){
  if(!dashboard.includes(token))throw new Error(`Website café-only subscription management is missing ${token}`);
}
if((dashboard.match(/id="billing-summary"/g)||[]).length!==1)throw new Error('Website has duplicate subscription-management surfaces');
const pauseMigration='supabase/migrations/20260831140330_pause_billing_and_restore_push_service_access.sql';
if(!fs.existsSync(pauseMigration)) throw new Error('Missing billing pause and push access migration');
const pauseSql=fs.readFileSync(pauseMigration,'utf8');
for(const token of ['complimentary_access = true','grant select on table public.profiles to service_role','grant select, update on table public.device_push_tokens to service_role','grant select, insert on table public.push_event_log to service_role'])if(!pauseSql.includes(token))throw new Error(`Billing/push migration missing ${token}`);
const membershipGrantMigration='supabase/migrations/20260830130318_grant_service_role_cafe_subscription_updates.sql';
if(!fs.existsSync(membershipGrantMigration)) throw new Error('Missing café membership service-role grant migration');
const membershipGrant=fs.readFileSync(membershipGrantMigration,'utf8');
if(!/grant\s+select\s*,\s*update\s+on\s+table\s+public\.cafe_subscriptions\s+to\s+service_role/i.test(membershipGrant)){
  throw new Error('Café membership service-role grant migration is incomplete');
}
const demographicMigration='supabase/migrations/20260830132340_add_private_profile_demographics.sql';
if(!fs.existsSync(demographicMigration)) throw new Error('Missing private profile demographics migration');
const demographicSql=fs.readFileSync(demographicMigration,'utf8');
if(!demographicSql.includes('alter table public.profile_demographics enable row level security')||!demographicSql.includes('owner_demographic_analytics')) throw new Error('Private profile demographics migration is incomplete');
const ownerDashboardScript=fs.readFileSync('owner-dashboard.js','utf8');
for(const page of ['overview','growth','subscriptions','marketplace','audience','accounts'])if(!ownerDashboardScript.includes(`renderers.${page}`))throw new Error(`Owner dashboard renderer missing ${page}`);
if(!ownerDashboardScript.includes('lineChart')||!ownerDashboardScript.includes('donutChart'))throw new Error('Owner dashboard charts are incomplete');
for(const token of ['renderers.reliability','Reliability office','Operations','/owner-reliability','/support-admin'])if(ownerDashboardScript.includes(token))throw new Error(`Owner dashboard must contain statistics only; found ${token}`);
for(const file of ['owner-reliability.html','owner-reliability.css'])if(fs.existsSync(file))throw new Error(`Retired Reliability Office UI still exists: ${file}`);
const vercelConfig=JSON.parse(fs.readFileSync('vercel.json','utf8'));
const reliabilityRedirect=(vercelConfig.redirects||[]).find((item)=>item.source==='/owner-reliability');
if(!reliabilityRedirect||reliabilityRedirect.destination!=='/owner-dashboard'||reliabilityRedirect.permanent!==false)throw new Error('Retired Reliability Office route must redirect to owner statistics');
if(!dashboard.includes("method:'HEAD'")||!dashboard.includes("location.replace('/owner-dashboard')"))throw new Error('Authenticated owner routing is incomplete');
for(const file of ['api/reliability.js','tests/reliability-api.test.js'])if(!fs.existsSync(file))throw new Error(`Reliability monitor backend missing ${file}`);
const reliabilityApi=fs.readFileSync('api/reliability.js','utf8');
for(const token of ['Owner access required','production_writes_enabled: false','model_used_for_monitoring: false','P0–P2'])if(!reliabilityApi.includes(token))throw new Error(`Reliability monitor safety contract missing ${token}`);
if(reliabilityApi.includes('SUPABASE_READ_ONLY_TOKEN')||reliabilityApi.includes('VERCEL_READ_TOKEN')||reliabilityApi.includes('ERA_RESEND_API_KEY'))throw new Error('Reliability monitor API must not receive provider credentials');
const subscriptionPauseMigration='supabase/migrations/20260901062356_add_owner_subscription_pause.sql';
if(!fs.existsSync(subscriptionPauseMigration))throw new Error('Missing owner subscription-pause migration');
const subscriptionPauseSql=fs.readFileSync(subscriptionPauseMigration,'utf8');
for(const token of ['owner_paused_at','grant select (owner_id, city, state, postal_code, created_at) on table public.jobs to service_role','s.owner_paused_at is null','on conflict (user_id) do update'])if(!subscriptionPauseSql.includes(token))throw new Error(`Subscription-pause migration missing ${token}`);
if(/alter\s+policy|create\s+policy|drop\s+policy/i.test(subscriptionPauseSql))throw new Error('Subscription-pause migration must not modify RLS policies');
for(const token of ['account_directory','set_cafe_subscription_access','stripe_subscription_id','owner_paused_at'])if(!fs.readFileSync('api/analytics.js','utf8').includes(token))throw new Error(`Owner account API missing ${token}`);
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
if(!homepage.includes('href="/pricing.html">Pricing</a>')||!homepage.includes('Your first job and first hire are free.'))throw new Error('Homepage café pricing entry points are out of sync');

// Mobile interaction regressions.
const mobileHome=fs.readFileSync('mobile/app/home.tsx','utf8');
if(!mobileHome.includes("router.push('/settings')")) throw new Error('Mobile dashboard settings button is not routed to Settings');
if(mobileHome.includes('onPress={logout}')) throw new Error('Mobile dashboard settings button still logs the user out');
const mobileDiscover=fs.readFileSync('mobile/app/discover.tsx','utf8');
const mobileDiscovery=fs.readFileSync('mobile/lib/discovery.ts','utf8');
const mobileCandidates=fs.readFileSync('mobile/app/candidates.tsx','utf8');
const mobileChat=fs.readFileSync('mobile/app/chat/[id].tsx','utf8');
if(!mobileDiscover.includes('sendDiscoveryInterest')) throw new Error('Mobile discovery screen bypasses the shared interest flow');
if(!/supabase\s*\.from\('discovery_interests'\)/.test(mobileDiscovery)||!mobileDiscovery.includes("authenticatedApi('/push-event'")){
  throw new Error('Mobile discovery interest flow is incomplete');
}
if(!mobileCandidates.includes("authenticatedApi('/match-application'")) throw new Error('Mobile match action bypasses the authenticated API');
if(!mobileChat.includes("authenticatedApi('/send-message'")) throw new Error('Mobile messaging action bypasses the authenticated API');
if(!mobileHome.includes("supabase.auth.getSession()")) throw new Error('Mobile dashboard performs a blocking remote auth check');
const mobileLogin=fs.readFileSync('mobile/app/login.tsx','utf8');
if(!mobileLogin.includes("router.push('/forgot-password')")) throw new Error('Mobile login is missing password recovery');
if(!/finally\s*\{\s*setSocialLoading\(null\)/.test(mobileLogin)) throw new Error('Mobile social login can remain stuck after cancellation');
if(mobileLogin.includes('<ScrollView')) throw new Error('Mobile login must fit without scrolling');
if(!mobileLogin.includes('height < 900')||!mobileLogin.includes('height < 720')||!mobileLogin.includes('styles.sheetShort')) throw new Error('Mobile login responsive layouts do not cover all supported iPhone heights');
const mobileSettings=fs.readFileSync('mobile/app/settings.tsx','utf8');
if(mobileSettings.includes('/create-checkout-session')||!mobileSettings.includes('View Free and Pro plans')) throw new Error('Mobile plan settings are incomplete or bypass the preview gate');
for(const token of ['role === "cafe_owner_manager"','"/billing-status"','Next billing date:','Manage subscription','"/create-portal-session"'])if(!mobileSettings.includes(token))throw new Error(`Mobile café-only subscription management is missing ${token}`);
if(!mobileSettings.includes('/delete-account')||!mobileSettings.includes('Delete account')) throw new Error('Mobile direct account deletion is missing');
const deleteAccount=fs.readFileSync('api/delete-account.js','utf8');
if(deleteAccount.includes('DELETE_COOLDOWN_DAYS')||deleteAccount.includes('deletion becomes available')) throw new Error('Account deletion has a prohibited signup cooldown');
const safetyMigration='supabase/migrations/20260831090000_add_member_safety_controls.sql';
if(!fs.existsSync(safetyMigration)) throw new Error('Mobile safety controls migration is missing');
const safetySql=fs.readFileSync(safetyMigration,'utf8');
for(const token of ['user_blocks','user_reports','members_are_blocked','message_is_allowed'])if(!safetySql.includes(token))throw new Error(`Mobile safety migration missing ${token}`);
const mobileSafety=fs.readFileSync('mobile/lib/safety.ts','utf8');
for(const token of ['blockUser','reportUser','isMessageAllowed'])if(!mobileSafety.includes(token))throw new Error(`Mobile safety helper missing ${token}`);
for(const token of ['openSafetyMenu','Report conversation','Block account','isMessageAllowed'])if(!mobileChat.includes(token))throw new Error(`Mobile chat safety flow missing ${token}`);
const mobileProfile=fs.readFileSync('mobile/app/profile.tsx','utf8');
if(!mobileProfile.includes('requestMediaLibraryPermissionsAsync')||!mobileProfile.includes('launchImageLibraryAsync'))throw new Error('Mobile profile media does not use the phone photo library');
const mobileJobs=fs.readFileSync('mobile/app/jobs.tsx','utf8');
if(!mobileJobs.includes("pathname:'/post-job'")||!mobileJobs.includes("update({active:false})"))throw new Error('Mobile job management is incomplete');
const mobileApi=fs.readFileSync('mobile/lib/api.ts','utf8');
if(!mobileApi.includes('EXPO_PUBLIC_API_BASE_URL')) throw new Error('Mobile API cannot target a Stripe-enabled preview deployment');

// Café pricing synchronization. Historical SQL migrations may retain old trial
// language, but every current customer-facing surface must use this offer.
const pricingFiles=['pricing.html','cafe-trial.html','mobile/app/subscription.tsx','mobile/app/cafe-trial.tsx','PRICING-DECISION.md'];
const pricingTokens=['$9.99','3 active jobs','first job','first hire','founder price'];
for(const file of pricingFiles){
  const source=fs.readFileSync(file,'utf8').toLowerCase();
  for(const token of pricingTokens)if(!source.includes(token.toLowerCase()))throw new Error(`${file}: pricing is missing ${token}`);
  for(const stale of ['1 month free','30-day free','30 days'])if(source.includes(stale))throw new Error(`${file}: stale trial copy remains (${stale})`);
}
for(const file of ['mobile/app/home.tsx','mobile/app/settings.tsx']){
  const source=fs.readFileSync(file,'utf8').toLowerCase();
  if(!source.includes('first job')||!source.includes('first hire'))throw new Error(`${file}: Free plan summary is out of sync`);
}
if(!stripeCheckout.includes('monthlyPriceCents: 999')||!stripeCheckout.includes('maxActiveJobs: 3'))throw new Error('Billing status metadata is out of sync with the Founder plan');
if(!stripeCheckout.includes('currentPeriodEnd: subscription?.current_period_end')||!stripeCheckout.includes('connectedToBilling'))throw new Error('Billing status omits paying-café renewal details');
if(/async function createPortal[\s\S]*?if \(BILLING_PAUSED\)/.test(stripeCheckout)||/async function stripeWebhook[\s\S]*?if \(BILLING_PAUSED\)/.test(stripeWebhook))throw new Error('Billing pause blocks existing customers from managing or canceling subscriptions');
if(!fs.readFileSync('pricing.html','utf8').includes('Founder checkout is not active yet'))throw new Error('Public pricing preview can start a charge while billing is paused');
if(ownerDashboardScript.includes("metric('Free trials'")||!ownerDashboardScript.includes('Free and Pro plan displays are synchronized'))throw new Error('Private subscription analytics uses stale launch-plan labels');
const mobileSubscription=fs.readFileSync('mobile/app/subscription.tsx','utf8');
if(!mobileSubscription.includes("role !== 'cafe_owner_manager'")||!mobileSubscription.includes("router.replace('/home')"))throw new Error('Mobile subscription route is not protected from barista accounts');

console.log('BaristaMatch launch readiness static checks passed');
