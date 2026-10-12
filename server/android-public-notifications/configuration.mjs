import {androidPublicBillingIdentity,assertAndroidPublicBillingIdentity} from '../android-public-billing/configuration.mjs';

export const publicPushIdentity=Object.freeze({...androidPublicBillingIdentity,
  firebaseProjectId:'baristamatch',projectNumber:'397053773139',
  serviceAccountEmail:'baristamatch-fcm-public@baristamatch.iam.gserviceaccount.com',
  providerResource:'projects/397053773139/locations/global/workloadIdentityPools/baristamatch-android-public/providers/vercel-android-production',
});
export class PublicPushError extends Error {
  constructor(code='UNAVAILABLE') {super('Android notifications are temporarily unavailable.');this.code=code;}
}
export const requirePush=value=>{if(!value)throw new PublicPushError('CONFIGURATION');};
const off=value=>value===undefined||value===''||value==='false';
export function readPublicPushConfiguration(env,host) {
  if(env.ANDROID_PUBLIC_NOTIFICATIONS_ACTIVE!=='true')return null;
  const id=publicPushIdentity;
  requirePush(env.VERCEL_PROJECT_ID===id.projectId&&env.VERCEL_ENV==='production'
    &&env.VERCEL_TARGET_ENV==='production'&&env.NATIVE_BILLING_ENVIRONMENT==='Production'
    &&/^baristamatch-android-[a-z0-9]{1,32}-baristamatch\.vercel\.app$/.test(env.VERCEL_URL||'')
    &&(host===id.apiHost||host===env.VERCEL_URL)&&env.SUPABASE_URL===id.supabaseUrl
    &&/^sb_secret_[A-Za-z0-9_-]+$/.test(env.SUPABASE_SECRET_KEY||'')
    &&env.ANDROID_PUBLIC_FCM_SERVICE_ACCOUNT_EMAIL===id.serviceAccountEmail
    &&env.GOOGLE_PLAY_WIF_PROJECT_NUMBER===id.projectNumber
    &&env.GOOGLE_PLAY_WIF_PROVIDER_RESOURCE===id.providerResource
    &&env.GOOGLE_PLAY_WIF_VERCEL_ISSUER===id.issuer&&env.GOOGLE_PLAY_WIF_VERCEL_AUDIENCE===id.audience
    &&!env.GOOGLE_PLAY_WIF_VERCEL_CUSTOM_ENVIRONMENT_ID
    &&!env.ANDROID_FCM_SERVICE_ACCOUNT_JSON&&off(env.ANDROID_DIRECT_FCM_ENABLED)
    &&off(env.ANDROID_REVIEW_ACCESS_ENABLED));
  requirePush(typeof env.CRON_SECRET==='string'&&/^[A-Za-z0-9_-]{43}$/.test(env.CRON_SECRET)
    &&Buffer.from(env.CRON_SECRET,'base64url').length===32
    &&Buffer.from(env.CRON_SECRET,'base64url').toString('base64url')===env.CRON_SECRET);
  return Object.freeze({secretKey:env.SUPABASE_SECRET_KEY,cronSecret:env.CRON_SECRET});
}
export const assertPublicPushIdentity=assertAndroidPublicBillingIdentity;
