import {readGoogleWifConfiguration} from '../native-billing/googleAuth.mjs';

export const androidPublicBillingIdentity=Object.freeze({
  projectId:'prj_7YTEsQnXSfNQpM0jNBGQ1T4BA07Q',ownerId:'team_W7sLByby0CKVDax9uhMshO5I',
  environment:'production',issuer:'https://oidc.vercel.com/baristamatch',audience:'https://vercel.com/baristamatch',
  subject:'owner:baristamatch:project:baristamatch-android:environment:production',
  apiHost:'baristamatch-android-baristamatch.vercel.app',supabaseUrl:'https://lmwqrxoitraofaftpwhe.supabase.co',
  packageName:'com.baristajobmatch.app',productId:'baristamatch_cafe_pro',basePlanId:'monthly-us',
});
const generatedHost=/^baristamatch-android-[a-z0-9]{1,32}-baristamatch\.vercel\.app$/;
const unavailable=()=>{throw new Error('Android billing configuration is unavailable.');};
const requireValue=value=>{if(!value)unavailable();};
const optionalOff=value=>value===undefined || value==='' || value==='false';
const flag=value=>{requireValue(optionalOff(value) || value==='true');return value==='true';};
const settings=['ANDROID_GOOGLE_BILLING_ACTIVE','ANDROID_GOOGLE_RECEIPTS_ACTIVE','ANDROID_GOOGLE_EVENTS_ACTIVE','NATIVE_PURCHASES_ENABLED','BILLING_ENABLED',
  'ANDROID_DIRECT_FCM_ENABLED','ANDROID_REVIEW_ACCESS_ENABLED','VERCEL_PROJECT_ID','VERCEL_ENV','VERCEL_TARGET_ENV','VERCEL_URL',
  'SUPABASE_URL','SUPABASE_PUBLISHABLE_KEY','SUPABASE_SECRET_KEY','NATIVE_BILLING_ENVIRONMENT',
  'GOOGLE_PLAY_AUTH_MODE','GOOGLE_PLAY_PRODUCT_ID','GOOGLE_PLAY_BASE_PLAN_ID','GOOGLE_PLAY_PUSH_AUDIENCE',
  'GOOGLE_PLAY_PUSH_SERVICE_ACCOUNT_EMAIL','GOOGLE_PLAY_WIF_PROJECT_NUMBER','GOOGLE_PLAY_WIF_SERVICE_ACCOUNT_EMAIL',
  'GOOGLE_PLAY_WIF_PROVIDER_RESOURCE','GOOGLE_PLAY_WIF_VERCEL_ISSUER','GOOGLE_PLAY_WIF_VERCEL_AUDIENCE',
  'GOOGLE_PLAY_WIF_VERCEL_CUSTOM_ENVIRONMENT_ID','GOOGLE_PLAY_SERVICE_ACCOUNT_JSON',
  'ANDROID_STRIPE_READ_RESTRICTED_KEY','ANDROID_STRIPE_ACCOUNT_ID','ANDROID_STRIPE_MONTHLY_PRICE_ID'];

/** Capture only reviewed settings. No provider, auth, database or file access. */
export function readAndroidPublicBillingConfiguration(env,host,{events=false}={}) {
  // Disabled is checked before reading credentials or any other configuration.
  if(env.ANDROID_GOOGLE_BILLING_ACTIVE!=='true')return null;
  if(events && env.ANDROID_GOOGLE_RECEIPTS_ACTIVE!=='true')return null;
  if(events && env.ANDROID_GOOGLE_EVENTS_ACTIVE!=='true')return null;
  const snapshot=Object.freeze(Object.fromEntries(settings.map(key=>[key,env[key]])));
  const identity=androidPublicBillingIdentity;
  requireValue(snapshot.VERCEL_PROJECT_ID===identity.projectId && snapshot.VERCEL_ENV==='production'
    && snapshot.VERCEL_TARGET_ENV==='production' && snapshot.NATIVE_BILLING_ENVIRONMENT==='Production');
  requireValue(typeof snapshot.VERCEL_URL==='string' && generatedHost.test(snapshot.VERCEL_URL));
  requireValue(typeof host==='string' && (host===identity.apiHost || host===snapshot.VERCEL_URL));
  requireValue(snapshot.SUPABASE_URL===identity.supabaseUrl
    && /^sb_publishable_[A-Za-z0-9_-]+$/.test(snapshot.SUPABASE_PUBLISHABLE_KEY || '')
    && /^sb_secret_[A-Za-z0-9_-]+$/.test(snapshot.SUPABASE_SECRET_KEY || ''));
  requireValue(snapshot.GOOGLE_PLAY_PRODUCT_ID===identity.productId && snapshot.GOOGLE_PLAY_BASE_PLAN_ID===identity.basePlanId);
  // Notification delivery is independently scoped; it is not a billing gate.
  flag(snapshot.ANDROID_DIRECT_FCM_ENABLED);
  requireValue(optionalOff(snapshot.ANDROID_REVIEW_ACCESS_ENABLED));
  const purchases=flag(snapshot.NATIVE_PURCHASES_ENABLED),billing=flag(snapshot.BILLING_ENABLED);
  const receiptsEnabled=flag(snapshot.ANDROID_GOOGLE_RECEIPTS_ACTIVE),eventsEnabled=flag(snapshot.ANDROID_GOOGLE_EVENTS_ACTIVE);
  // A Stripe setup failure closes only new checkout. Existing Google receipts,
  // RTDN and owned cancellation must remain available with their own gates.
  const stripeValid=/^rk_live_[A-Za-z0-9]+$/.test(snapshot.ANDROID_STRIPE_READ_RESTRICTED_KEY || '')
    && /^acct_[A-Za-z0-9_]{1,240}$/.test(snapshot.ANDROID_STRIPE_ACCOUNT_ID || '')
    && /^price_[A-Za-z0-9_]{1,240}$/.test(snapshot.ANDROID_STRIPE_MONTHLY_PRICE_ID || '');
  const newSalesEnabled=purchases && billing && receiptsEnabled && stripeValid;
  let stripe=null;
  if(newSalesEnabled) {
    stripe=Object.freeze({restrictedKey:snapshot.ANDROID_STRIPE_READ_RESTRICTED_KEY,
      accountId:snapshot.ANDROID_STRIPE_ACCOUNT_ID,priceId:snapshot.ANDROID_STRIPE_MONTHLY_PRICE_ID});
  }
  const auth=readGoogleWifConfiguration(snapshot);
  let notification=null;
  if(eventsEnabled) {
    // The audience must be this exact endpoint, never a website/Sandbox origin.
    requireValue(snapshot.GOOGLE_PLAY_PUSH_AUDIENCE===`https://${identity.apiHost}/api/native-purchases?action=google-events`
      && snapshot.GOOGLE_PLAY_PUSH_SERVICE_ACCOUNT_EMAIL==='baristamatch-rtdn-public@baristamatch.iam.gserviceaccount.com');
    notification=Object.freeze({audience:snapshot.GOOGLE_PLAY_PUSH_AUDIENCE,serviceAccountEmail:snapshot.GOOGLE_PLAY_PUSH_SERVICE_ACCOUNT_EMAIL});
  }
  return Object.freeze({environment:'Production',provider:'google',packageName:identity.packageName,
    productId:identity.productId,basePlanId:identity.basePlanId,newSalesEnabled,stripe,
    receiptsEnabled,eventsEnabled,notification,authMode:auth.authMode,wif:Object.freeze({...auth.wif}),
    supabase:Object.freeze({url:snapshot.SUPABASE_URL,publishableKey:snapshot.SUPABASE_PUBLISHABLE_KEY,secretKey:snapshot.SUPABASE_SECRET_KEY})});
}

/** Input MUST be a freshly signature-verified request-context payload supplied
 * by the server composition. Environment variables/decoded caller JWTs are not
 * identity evidence. This additional exact-claim check never verifies a JWT. */
export function assertAndroidPublicBillingIdentity(payload,now=Date.now()) {
  const expected=androidPublicBillingIdentity;
  requireValue(payload && typeof payload==='object' && !Array.isArray(payload));
  for(const [key,value] of Object.entries({iss:expected.issuer,aud:expected.audience,sub:expected.subject,
    owner_id:expected.ownerId,project_id:expected.projectId,environment:expected.environment})) {
    requireValue(Object.hasOwn(payload,key) && payload[key]===value);
  }
  requireValue(!('custom_environment_id' in payload));
  const seconds=now/1000;
  requireValue(Number.isFinite(seconds) && ['exp','iat','nbf'].every(key=>Object.hasOwn(payload,key) && Number.isSafeInteger(payload[key]))
    && payload.iat<=seconds && payload.nbf<=seconds && payload.exp>seconds
    && payload.exp>payload.iat && payload.nbf<payload.exp && payload.exp-payload.iat<=86400);
}
