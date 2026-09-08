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
const stripeSupport=fs.readFileSync('api/_billing.js','utf8');
if(!stripeWebhook.includes('constructStripeEvent')||!stripeSupport.includes('Stripe.webhooks.constructEvent')||!stripeWebhook.includes('STRIPE_WEBHOOK_SECRET')) throw new Error('Stripe webhook signature verification is missing');
for(const token of ['rk_test_','rk_live_','STRIPE_LIVEMODE','client.prices.retrieve(priceId)','validateConfiguredPrice','subscriptionUsesConfiguredPrice'])if(!stripeSupport.includes(token))throw new Error(`Stripe mode and Price validation is missing ${token}`);
for(const token of ['VERCEL_ENV === "production"','Production Stripe configuration requires STRIPE_LIVEMODE=true'])if(!stripeSupport.includes(token))throw new Error(`Stripe Production mode guard is missing ${token}`);
if(!stripeSupport.includes('stripeWebhookClient')||!stripeWebhook.includes('await stripeWebhookClient()'))throw new Error('Relevant Stripe webhooks must validate the configured account and Price');
if(stripeSupport.includes('client.accounts.retrieve')) throw new Error('Stripe runtime key requires excessive Accounts Read permission');
if(!stripeCheckout.includes('process.env.BILLING_ENABLED !== "true"')||!stripeCheckout.includes('billingPaused: true')) throw new Error('Stripe billing kill switch is not safe by default');
if(stripeWebhook.includes('return res.status(200).json({ received: true, billingPaused: true })')) throw new Error('Stripe webhook ingestion must remain active while checkout is paused');
if(!stripeWebhook.includes('checkout.session.completed')||!stripeWebhook.includes('syncCheckoutSession')||!stripeWebhook.includes('subscriptionUsesConfiguredPrice'))throw new Error('Stripe Checkout fulfillment or plan validation is incomplete');
for(const token of ['checkout.session.async_payment_succeeded','checkoutSessionCanFulfill','constructStripeEvent','Webhook processing failed'])if(!stripeWebhook.includes(token))throw new Error(`Stripe webhook lifecycle handling is missing ${token}`);
for(const token of ['subscriptionBelongsToCafe','subscriptionSelectionRank','preferredConfiguredSubscription','syncPreferredCustomerSubscription','reconcileCurrentCustomerSubscription','forcedStatus'])if(!stripeWebhook.includes(token))throw new Error(`Stripe current-state reconciliation is missing ${token}`);
if(!stripeWebhook.includes('if (!usesConfiguredPrice) return true'))throw new Error('Invoices from an unapproved replacement Price must not be recorded as plan revenue');
if(!stripeCheckout.includes('async function confirmCheckout')||!stripeCheckout.includes('checkoutSessionBelongsToCafe')||!dashboard.includes('/api/confirm-checkout-session'))throw new Error('Authenticated Stripe Checkout return reconciliation is missing');
if(dashboard.includes('Payment received. Subscription status is still syncing')||!dashboard.includes('result.confirmed!==true')||!dashboard.includes('We have not confirmed a payment.'))throw new Error('Website must not claim payment from an unverified Checkout return');
if(!dashboard.includes('billing.canManageBilling')||!stripeCheckout.includes('canManageBilling'))throw new Error('Canceled and recoverable subscriptions are not routed safely');
if(!dashboard.includes('/api/create-checkout-session')||dashboard.includes("fetch('/api/billing/checkout'"))throw new Error('Website Stripe Checkout route is not connected to the production endpoint');
const stripeRuntimeMigration='supabase/migrations/20260908090000_harden_stripe_runtime_coordination.sql';
if(!fs.existsSync(stripeRuntimeMigration))throw new Error('Missing Stripe runtime-coordination migration');
const stripeRuntimeSql=fs.readFileSync(stripeRuntimeMigration,'utf8');
for(const token of ['claim_stripe_checkout','release_stripe_checkout','stripe_checkout_claim_kind','stripe_checkout_claim_is_current','attach_stripe_checkout_customer','claim_stripe_deletion','settle_stripe_checkout_attempt_for_deletion','stripe_checkout_attempt_id','claim_stripe_webhook_event','complete_stripe_webhook_event','fail_stripe_webhook_event','sync_stripe_subscription','stripe_subscription_event_created_at','stripe_subscription_created_at','stripe_subscription_sync_revision','record_stripe_subscription_payment','provider_event_created_at'])if(!stripeRuntimeSql.includes(token))throw new Error(`Stripe runtime coordination is missing ${token}`);
for(const token of ['incoming_selection_rank < existing_selection_rank','p_subscription_id collate "C" < existing.stripe_subscription_id collate "C"'])if(!stripeRuntimeSql.includes(token))throw new Error(`Stripe duplicate-subscription ordering is missing ${token}`);
if(!stripeRuntimeSql.includes('p_authoritative\n     and existing.stripe_subscription_event_created_at is not null'))throw new Error('Authoritative Stripe no-op can skip legacy watermark initialization');
for(const token of ['rpc/claim_stripe_checkout','rpc/release_stripe_checkout','rpc/stripe_checkout_claim_is_current','rpc/attach_stripe_checkout_customer','rpc/claim_stripe_webhook_event','rpc/complete_stripe_webhook_event','rpc/fail_stripe_webhook_event','rpc/sync_stripe_subscription','rpc/record_stripe_subscription_payment'])if(!stripeCheckout.includes(token))throw new Error(`Stripe runtime does not use ${token}`);
if(!stripeCheckout.includes('checkoutClaim.attemptId')||!stripeCheckout.includes('checkoutClaim.recovered')||!stripeCheckout.includes('p_clear_attempt: clearAttempt'))throw new Error('Stripe Checkout recovery is not bound to a durable idempotency attempt');
if(!stripeCheckout.includes('["attached", "owned"].includes(attachment)')||!stripeCheckout.includes('if (attachment === "missing")')||stripeCheckout.includes('["deletion", "missing"].includes(attachment)'))throw new Error('Interrupted Stripe Customer cleanup is not successor-safe');
if(!stripeCheckout.includes('openSubscriptionCheckoutSessions')||!stripeCheckout.includes('starting_after: startingAfter')||!stripeCheckout.includes('.filter((session) => session.id !== reusableSession?.id)'))throw new Error('Stripe Checkout must enumerate and expire every non-reusable subscription Session');
const jobEntitlementMigration='supabase/migrations/20260908100000_enforce_cafe_job_posting_entitlements.sql';
if(!fs.existsSync(jobEntitlementMigration))throw new Error('Missing lifetime-free-job entitlement migration');
const jobEntitlementSql=fs.readFileSync(jobEntitlementMigration,'utf8');
for(const token of ['private.cafe_job_entitlements','free_job_deleted_at','private.cafe_has_paid_job_entitlement','public.cafe_can_create_job','JOB_PRO_SUBSCRIPTION_REQUIRED','JOB_ACTIVE_LIMIT_REACHED','private.pause_jobs_without_paid_entitlement'])if(!jobEntitlementSql.includes(token))throw new Error(`Lifetime-free-job enforcement is missing ${token}`);
for(const token of ["subscription.stripe_customer_id ~ '^cus_", "subscription.stripe_subscription_id ~ '^sub_", "subscription.status = 'active'", "subscription.status = 'trialing'", 'subscription.trial_ends_at > now()'])if(!jobEntitlementSql.includes(token))throw new Error(`Paid job entitlement is not bound to current Stripe state: ${token}`);
if(!/create trigger pause_jobs_without_paid_entitlement\s+after insert or update on public\.cafe_subscriptions/i.test(jobEntitlementSql))throw new Error('Paid-only jobs are not paused when Stripe entitlement changes');
if(/create trigger pause_jobs_without_paid_entitlement\s+after[^;]*delete/i.test(jobEntitlementSql))throw new Error('Subscription cascade deletion must not run the paid-job pause trigger');
for(const token of ['cafe_can_create_job','JOB_SUBSCRIPTION_REQUIRED','PJB01','PJB04','persistPendingJobDraft','resumePendingJobDraft'])if(!dashboard.includes(token))throw new Error(`Website lifetime job gate is missing ${token}`);
const rolloutGuide=fs.readFileSync('README.md','utf8');
const requiredBillingMigrations=['202608310001_connect_stripe_billing.sql','20260908090000_harden_stripe_runtime_coordination.sql','20260908100000_enforce_cafe_job_posting_entitlements.sql','20260908110000_consolidate_job_participant_visibility.sql'];
let previousMigrationIndex=-1;
for(const migration of requiredBillingMigrations){
  const migrationIndex=rolloutGuide.indexOf(migration);
  if(migrationIndex<=previousMigrationIndex)throw new Error(`README billing migrations are missing or out of order: ${migration}`);
  previousMigrationIndex=migrationIndex;
}
for(const token of ['exactly one free job post for the lifetime','scheduling an interview','second distinct job row','must not insert or expose that job to baristas'])if(!rolloutGuide.includes(token))throw new Error(`README lifetime-free-job rollout is missing ${token}`);
const participantPolicyMigration=fs.readFileSync('supabase/migrations/20260908110000_consolidate_job_participant_visibility.sql','utf8');
if(!participantPolicyMigration.includes('private.job_caller_is_application_participant')||!participantPolicyMigration.includes('drop policy if exists "Application participants can view their jobs"'))throw new Error('Paused-job participant visibility policy is not consolidated');
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
if(/href=["'][^"']*(?:pricing|cafe-trial)/i.test(homepage)||homepage.includes('Your first job and first hire are free.')||homepage.includes('$9.99'))throw new Error('Café pricing must not appear on the public homepage');

// Mobile interaction regressions.
const mobileHome=fs.readFileSync('mobile/app/home.tsx','utf8');
if(!mobileHome.includes("router.push('/settings')")) throw new Error('Mobile dashboard settings button is not routed to Settings');
if(mobileHome.includes('onPress={logout}')) throw new Error('Mobile dashboard settings button still logs the user out');
const mobileDiscover=fs.readFileSync('mobile/app/discover.tsx','utf8');
const mobileDiscovery=fs.readFileSync('mobile/lib/discovery.ts','utf8');
const mobileCandidates=fs.readFileSync('mobile/app/candidates.tsx','utf8');
const mobileChat=['mobile/app/chat/[id].tsx','mobile/lib/useConversation.ts','mobile/lib/messaging.ts'].map(file=>fs.readFileSync(file,'utf8')).join('\n');
if(!mobileDiscover.includes('sendDiscoveryInterest')) throw new Error('Mobile discovery screen bypasses the shared interest flow');
if(!/supabase\s*\.from\('discovery_interests'\)/.test(mobileDiscovery)||!mobileDiscovery.includes("authenticatedApi('/push-event'")){
  throw new Error('Mobile discovery interest flow is incomplete');
}
if(!mobileCandidates.includes("authenticatedApi('/match-application'")) throw new Error('Mobile match action bypasses the authenticated API');
if(!mobileChat.includes("'/send-message'")||!mobileChat.includes('deliverMessage(supabase, authenticatedApi')) throw new Error('Mobile messaging action bypasses the authenticated API');
if(!mobileHome.includes("getCurrentContext") && !mobileHome.includes("supabase.auth.getSession()")) throw new Error('Mobile dashboard performs a blocking remote auth check');
const mobileLogin=fs.readFileSync('mobile/app/login.tsx','utf8');
if(!mobileLogin.includes("router.push('/forgot-password')")) throw new Error('Mobile login is missing password recovery');
if(!/finally\s*\{[^}]*setSocialLoading\(null\)/.test(mobileLogin)) throw new Error('Mobile social login can remain stuck after cancellation');
if(!mobileLogin.includes('<ScrollView') || !mobileLogin.includes('KeyboardAvoidingView')) throw new Error('Mobile login controls must remain reachable above the keyboard and with large text');
// Viewport-sized photo header replaces the previous fixed breakpoint styles.
if(!mobileLogin.includes('useWindowDimensions') || !mobileLogin.includes('useSafeAreaInsets') || !/height:\s*heroHeight/.test(mobileLogin) || !mobileLogin.includes('keyboardVisible') || !/minHeight:\s*inputHeight/.test(mobileLogin)) throw new Error('Mobile login must size its hero and inputs for the viewport, safe areas, larger text and keyboard');
// First-time OAuth users complete the same explicit role and consent form as email users.
if(!mobileLogin.includes("pathname: '/signup'")) throw new Error('New mobile OAuth accounts must complete signup');
const mobileSignup=fs.readFileSync('mobile/app/signup.tsx','utf8');
for(const token of ['ageConfirmed','at least 16','parent or legal guardian','/terms.html','/privacy.html'])if(!mobileSignup.includes(token))throw new Error(`Mobile signup legal consent is missing ${token}`);
for(const token of ['normalizeFloridaLocation','Florida (FL)','Florida is selected automatically'])if(!mobileSignup.includes(token))throw new Error(`Mobile signup structured Florida location is missing ${token}`);
const mobileSettings=fs.readFileSync('mobile/app/settings.tsx','utf8');
if(mobileSettings.includes('/create-checkout-session')||!mobileSettings.includes('View Free and Pro plans')) throw new Error('Mobile plan settings are incomplete or bypass the preview gate');
for(const token of ['role === "cafe_owner_manager"','"/billing-status"','Next billing date:','Manage subscription','"/create-portal-session"'])if(!mobileSettings.replaceAll("'", '"').includes(token))throw new Error(`Mobile café-only subscription management is missing ${token}`);
if(!mobileSettings.includes('/delete-account')||!mobileSettings.includes('showAdvanced')||!mobileSettings.includes('Delete my account')) throw new Error('Mobile Advanced settings account deletion is missing');
if(mobileSettings.indexOf('Delete my account')<mobileSettings.indexOf('Log out')) throw new Error('Mobile account deletion must remain separated from Log out');
for(const token of ['/terms.html','/privacy.html','BaristaMatch LLC'])if(!mobileSettings.includes(token))throw new Error(`Mobile settings legal access is missing ${token}`);
const deleteAccount=fs.readFileSync('api/delete-account.js','utf8');
if(deleteAccount.includes('DELETE_COOLDOWN_DAYS')||deleteAccount.includes('deletion becomes available')) throw new Error('Account deletion has a prohibited signup cooldown');
if(deleteAccount.includes('subscriptionBlocksAccountDeletion')||deleteAccount.includes('Cancel your current Stripe subscription'))throw new Error('Account deletion still blocks on the removed manual-subscription guard');
for(const token of ['await stripeWebhookClient()','endStripeBillingForDeletion','deleteOwnedStripeCustomer','stripe.customers.del(customerId)','stripe.customers.search','stripe.customers.list','expireOpenCheckoutSessions','stripe_checkout_attempt_id'])if(!deleteAccount.includes(token))throw new Error(`Account deletion Stripe cleanup is missing ${token}`);
for(const token of ['suspended_at=is.null','stripeBillingAttempted','restoreDeletionLock','rpc/claim_stripe_deletion','rpc/settle_stripe_checkout_attempt_for_deletion','releaseDeletionBillingClaim','is_discoverable: Boolean(profile.is_discoverable)'])if(!deleteAccount.includes(token))throw new Error(`Account deletion coordination is missing ${token}`);
if(deleteAccount.indexOf('rpc/claim_stripe_deletion')>deleteAccount.indexOf('suspended_at=is.null'))throw new Error('Account deletion must own the billing lease before changing profile visibility');
const deletionFailureHandler=deleteAccount.slice(deleteAccount.lastIndexOf('} catch (error) {'));
if(deletionFailureHandler.indexOf('if (restoreDeletionLock)')>deletionFailureHandler.indexOf('if (releaseDeletionBillingClaim)'))throw new Error('Account deletion must restore its lock before handing off the billing lease');
for(const source of [dashboard,mobileSettings])if(!source.includes('active Pro subscription')||(!source.includes('cancels it immediately')&&!source.includes('canceled immediately')))throw new Error('Account deletion must disclose immediate Pro subscription cancellation');
const safetyMigration='supabase/migrations/20260831090000_add_member_safety_controls.sql';
if(!fs.existsSync(safetyMigration)) throw new Error('Mobile safety controls migration is missing');
const safetySql=fs.readFileSync(safetyMigration,'utf8');
for(const token of ['user_blocks','user_reports','members_are_blocked','message_is_allowed'])if(!safetySql.includes(token))throw new Error(`Mobile safety migration missing ${token}`);
const mobileSafety=fs.readFileSync('mobile/lib/safety.ts','utf8');
for(const token of ['blockUser','reportUser','isMessageAllowed'])if(!mobileSafety.includes(token))throw new Error(`Mobile safety helper missing ${token}`);
for(const token of ['openSafetyMenu','Report conversation','Block account','isMessageAllowed'])if(!mobileChat.includes(token))throw new Error(`Mobile chat safety flow missing ${token}`);
const mobileProfile=fs.readFileSync('mobile/app/profile.tsx','utf8') + fs.readFileSync('mobile/lib/profilePrivacy.ts','utf8');
if(!mobileProfile.includes('requestMediaLibraryPermissionsAsync')||!mobileProfile.includes('launchImageLibraryAsync'))throw new Error('Mobile profile media does not use the phone photo library');
for(const token of ['normalizeFloridaLocation','locationCity','Florida (FL)'])if(!mobileProfile.includes(token))throw new Error(`Mobile profile structured Florida location is missing ${token}`);
for(const token of ['date_of_birth','isEligibleBirthDate','getProfileReadiness','"female"','"male"','never shown to cafés'])if(!mobileProfile.includes(token))throw new Error(`Mobile private barista demographics missing ${token}`);
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
if(!/pathname:\s*'\/post-job'/.test(mobileJobs)||!/update\(\{\s*active:\s*!job.active/.test(mobileJobs))throw new Error('Mobile job management is incomplete');
const mobileApi=fs.readFileSync('mobile/lib/api.ts','utf8');
if(!mobileApi.includes('EXPO_PUBLIC_API_BASE_URL')) throw new Error('Mobile API cannot target a Stripe-enabled preview deployment');

// Café pricing synchronization. Historical SQL migrations may retain old trial
// language, but every current customer-facing surface must use this offer.
const pricingFiles=['cafe-trial.html','mobile/app/subscription.tsx','PRICING-DECISION.md'];
const pricingTokens=['$9.99','3 active jobs','first job','second job','schedule interviews','founder price'];
for(const file of pricingFiles){
  const source=fs.readFileSync(file,'utf8').toLowerCase();
  for(const token of pricingTokens)if(!source.includes(token.toLowerCase()))throw new Error(`${file}: pricing is missing ${token}`);
  for(const stale of ['1 month free','30-day free','30 days'])if(source.includes(stale))throw new Error(`${file}: stale trial copy remains (${stale})`);
}
for(const file of ['mobile/app/home.tsx','mobile/app/settings.tsx']){
  const source=fs.readFileSync(file,'utf8').toLowerCase();
  if(!source.includes('first job')||!source.includes('interview'))throw new Error(`${file}: Free plan summary is out of sync`);
}
if(!stripeCheckout.includes('monthlyPriceCents: 999')||!stripeCheckout.includes('maxActiveJobs: 3'))throw new Error('Billing status metadata is out of sync with the Founder plan');
if(!stripeCheckout.includes('currentPeriodEnd: subscription?.current_period_end')||!stripeCheckout.includes('connectedToBilling'))throw new Error('Billing status omits paying-café renewal details');
if(/async function createPortal[\s\S]*?if \(BILLING_PAUSED\)/.test(stripeCheckout)||/async function stripeWebhook[\s\S]*?if \(BILLING_PAUSED\)/.test(stripeWebhook))throw new Error('Billing pause blocks existing customers from managing or canceling subscriptions');
const publicPricing=fs.readFileSync('pricing.html','utf8');
if(!publicPricing.includes('/signup.html?role=cafe_owner_manager')||!publicPricing.includes('BaristaMatchCafeGate.authorize()')||!publicPricing.includes('/dashboard.html?section=subscription')||/\$\d|class="plans"/.test(publicPricing))throw new Error('The old public pricing route must be an account gateway without prices');
const cafeAccess=fs.readFileSync('cafe-trial.html','utf8'),cafeGate=fs.readFileSync('cafe-account-gate.js','utf8');
if(!cafeAccess.includes('id="cafe-plans" hidden')||!cafeAccess.includes('[hidden]{display:none!important}')||!cafeAccess.includes('BaristaMatchCafeGate.authorize()')||!cafeAccess.includes("event==='SIGNED_OUT'"))throw new Error('Café welcome pricing must stay hidden until café authorization and hide on sign-out');
if(!cafeGate.includes("profile.role!=='cafe_owner_manager'")||!cafeGate.includes(".select('role')")||!cafeGate.includes('client.auth.getSession()'))throw new Error('Pricing access must verify the saved café account role');
if(ownerDashboardScript.includes("metric('Free trials'")||!ownerDashboardScript.includes('Free and Pro plan displays are synchronized'))throw new Error('Private subscription analytics uses stale launch-plan labels');
const mobileSubscription=fs.readFileSync('mobile/app/subscription.tsx','utf8');
const nativeCafeAccess=fs.readFileSync('mobile/lib/useCafeAccess.ts','utf8');
if(!mobileSubscription.includes('useCafeAccess')||!mobileSubscription.includes('!access.ready')||!nativeCafeAccess.includes("context.role !== 'cafe_owner_manager'")||!nativeCafeAccess.includes("event === 'SIGNED_OUT'"))throw new Error('Mobile subscription route is not protected from barista accounts');
if(mobileSubscription.includes('/create-checkout-session')||!mobileSubscription.includes('Pro purchases are not available in this app'))throw new Error('Mobile subscription screen can bypass the App Store-safe web purchase boundary');
for(const file of ['terms.html','privacy.html']){
  const source=fs.readFileSync(file,'utf8');
  const effectiveDate=file==='privacy.html'?'Effective September 6, 2026':'Effective September 2, 2026';
  if(!source.includes('BaristaMatch LLC')||!source.includes(effectiveDate))throw new Error(`${file}: LLC operator or effective date is missing`);
}

console.log('BaristaMatch launch readiness static checks passed');
