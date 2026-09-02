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
const stripeSupport=fs.readFileSync('api/_billing.js','utf8');
for(const token of ['rk_test_','rk_live_','STRIPE_LIVEMODE','client.prices.retrieve(priceId)','validateConfiguredPrice','subscriptionUsesConfiguredPrice'])if(!stripeSupport.includes(token))throw new Error(`Stripe mode and Price validation is missing ${token}`);
if(stripeSupport.includes('client.accounts.retrieve')) throw new Error('Stripe runtime key requires excessive Accounts Read permission');
if(!stripeCheckout.includes('process.env.BILLING_ENABLED !== "true"')||!stripeCheckout.includes('billingPaused: true')) throw new Error('Stripe billing kill switch is not safe by default');
if(stripeWebhook.includes('return res.status(200).json({ received: true, billingPaused: true })')) throw new Error('Stripe webhook ingestion must remain active while checkout is paused');
if(!stripeWebhook.includes('checkout.session.completed')||!stripeWebhook.includes('syncCheckoutSession')||!stripeWebhook.includes('subscriptionUsesConfiguredPrice'))throw new Error('Stripe Checkout fulfillment or plan validation is incomplete');
if(!dashboard.includes('/api/create-checkout-session')||dashboard.includes("fetch('/api/billing/checkout'"))throw new Error('Website Stripe Checkout route is not connected to the production endpoint');
const subscriptionSyncStart=stripeWebhook.indexOf('async function syncSubscription');
const subscriptionSyncEnd=stripeWebhook.indexOf('async function recordInvoicePayment');
if(subscriptionSyncStart<0||subscriptionSyncEnd<=subscriptionSyncStart) throw new Error('Stripe subscription sync structure is missing');
const subscriptionSyncSource=stripeWebhook.slice(subscriptionSyncStart,subscriptionSyncEnd);
if(subscriptionSyncSource.includes('complimentary_access')) throw new Error('Stripe webhook sync must not mutate platform access grants');
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
if(!signup.includes('at least 16')||!signup.includes('parent or legal guardian')) throw new Error('Website signup age and guardian confirmation is missing');
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
if(!mobileLogin.includes('confirm you are at least 16')||!mobileLogin.includes('guardian permission')) throw new Error('Mobile social signup is missing age and guardian confirmation');
const mobileSignup=fs.readFileSync('mobile/app/signup.tsx','utf8');
for(const token of ['ageConfirmed','at least 16','parent or legal guardian','/terms.html','/privacy.html'])if(!mobileSignup.includes(token))throw new Error(`Mobile signup legal consent is missing ${token}`);
for(const token of ['normalizeFloridaLocation','Florida (FL)','Florida is selected automatically'])if(!mobileSignup.includes(token))throw new Error(`Mobile signup structured Florida location is missing ${token}`);
const mobileSettings=fs.readFileSync('mobile/app/settings.tsx','utf8');
if(mobileSettings.includes('/create-checkout-session')||!mobileSettings.includes('View Free and Pro plans')) throw new Error('Mobile plan settings are incomplete or bypass the preview gate');
for(const token of ['role === "cafe_owner_manager"','"/billing-status"','Next billing date:','Manage subscription','"/create-portal-session"'])if(!mobileSettings.includes(token))throw new Error(`Mobile café-only subscription management is missing ${token}`);
if(!mobileSettings.includes('/delete-account')||!mobileSettings.includes('showAdvanced')||!mobileSettings.includes('Delete my account')) throw new Error('Mobile Advanced settings account deletion is missing');
if(mobileSettings.indexOf('Delete my account')<mobileSettings.indexOf('Log out')) throw new Error('Mobile account deletion must remain separated from Log out');
for(const token of ['/terms.html','/privacy.html','BaristaMatch LLC'])if(!mobileSettings.includes(token))throw new Error(`Mobile settings legal access is missing ${token}`);
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
for(const token of ['normalizeFloridaLocation','locationCity','Florida (FL)','Florida is selected automatically'])if(!mobileProfile.includes(token))throw new Error(`Mobile profile structured Florida location is missing ${token}`);
for(const token of ['date_of_birth','Date of birth required','maximumBirthDate','"female"','"male"','never shown to cafés'])if(!mobileProfile.includes(token))throw new Error(`Mobile private barista demographics missing ${token}`);
for(const stale of ['AGE_RANGES','non_binary','another_identity','prefer_not_to_say'])if(mobileProfile.includes(stale))throw new Error(`Mobile barista demographics retain stale option ${stale}`);
const privateDemographicsMigration='supabase/migrations/20260902025028_require_private_barista_demographics.sql';
if(!fs.existsSync(privateDemographicsMigration))throw new Error('Missing private date-of-birth migration');
const privateDemographicsSql=fs.readFileSync(privateDemographicsMigration,'utf8');
for(const token of ['date_of_birth date',"gender_identity in ('female', 'male')",'where p.role = \'barista\'','never exposed on marketplace profiles'])if(!privateDemographicsSql.includes(token))throw new Error(`Private demographics migration missing ${token}`);
if(!dashboard.includes('name="date_of_birth" type="date"')||!dashboard.includes('Private account information')||dashboard.includes('name="age_range"'))throw new Error('Website private barista demographics are incomplete');
const invokerHardeningMigration='supabase/migrations/20260902030619_remove_authenticated_security_definer_functions.sql';
if(!fs.existsSync(invokerHardeningMigration))throw new Error('Missing authenticated function privilege-hardening migration');
const invokerHardeningSql=fs.readFileSync(invokerHardeningMigration,'utf8');
for(const functionName of ['cafe_has_hiring_access','ensure_cafe_subscription','mark_conversation_read']){
  if(!invokerHardeningSql.includes(`function public.${functionName}`))throw new Error(`Privilege hardening missing ${functionName}`);
}
if((invokerHardeningSql.match(/security invoker/g)||[]).length<3||invokerHardeningSql.includes('security definer'))throw new Error('Authenticated RPC functions must use caller permissions');
for(const token of ['grant insert (user_id, complimentary_access)','grant update (read_at) on table public.messages','Matched recipients can mark messages read'])if(!invokerHardeningSql.includes(token))throw new Error(`Privilege hardening missing ${token}`);
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
const publicPricing=fs.readFileSync('pricing.html','utf8');
if(!publicPricing.includes('/signup.html?role=cafe_owner_manager')||publicPricing.includes('Founder checkout is not active yet'))throw new Error('Public pricing must route cafés through an authenticated account before Checkout');
if(ownerDashboardScript.includes("metric('Free trials'")||!ownerDashboardScript.includes('Free and Pro plan displays are synchronized'))throw new Error('Private subscription analytics uses stale launch-plan labels');
const mobileSubscription=fs.readFileSync('mobile/app/subscription.tsx','utf8');
if(!mobileSubscription.includes("role !== 'cafe_owner_manager'")||!mobileSubscription.includes("router.replace('/home')"))throw new Error('Mobile subscription route is not protected from barista accounts');
if(mobileSubscription.includes('/create-checkout-session')||!mobileSubscription.includes('Pro purchases are not available in this app'))throw new Error('Mobile subscription screen can bypass the App Store-safe web purchase boundary');
for(const file of ['terms.html','privacy.html']){
  const source=fs.readFileSync(file,'utf8');
  if(!source.includes('BaristaMatch LLC')||!source.includes('Effective September 2, 2026'))throw new Error(`${file}: LLC operator or effective date is missing`);
}

console.log('BaristaMatch launch readiness static checks passed');
