export class AndroidPushError extends Error {
  constructor(code) { super('Android notifications are temporarily unavailable.'); this.name='AndroidPushError'; this.code=code; }
}
export const requirePush=value=>{if(!value)throw new AndroidPushError('CONFIGURATION');};
export const androidPushIdentity=Object.freeze({
  apiBaseUrl:'https://android-testing.baristajobmatch.com/api',
  supabaseUrl:'https://ojvjlvojvozvhktbclcg.supabase.co',
  firebaseProjectId:'baristamatch',packageName:'com.baristajobmatch.app',
  serviceAccountEmail:'baristamatch-fcm-test@baristamatch.iam.gserviceaccount.com',
  projectNumber:'397053773139',
  providerResource:'projects/397053773139/locations/global/workloadIdentityPools/baristamatch-android-test/providers/vercel-android-testing',
  ownerId:'team_W7sLByby0CKVDax9uhMshO5I',projectId:'prj_VuAxQpdhDJPeTPdanA5HjtOrylA5',
  environment:'android-testing',issuer:'https://oidc.vercel.com/baristamatch',
  audience:'https://vercel.com/baristamatch',subject:'owner:baristamatch:project:baa:environment:android-testing',
});

// This selects transport only. Editable environment values do not prove identity;
// the request JWT and Google's exact Custom Environment condition must both agree.
export const usesAndroidDirectFcm=env=>env.VERCEL_TARGET_ENV===androidPushIdentity.environment || env.ANDROID_DIRECT_FCM_ENABLED==='true';

export function readAndroidPushConfiguration(env) {
  const id=androidPushIdentity;
  requirePush(env.ANDROID_DIRECT_FCM_ENABLED==='true' && env.VERCEL_ENV==='preview'
    && env.VERCEL_TARGET_ENV===id.environment && env.NATIVE_BILLING_ENVIRONMENT==='Sandbox'
    && env.ANDROID_FCM_API_BASE_URL===id.apiBaseUrl && env.SUPABASE_URL===id.supabaseUrl
    && /^sb_publishable_[A-Za-z0-9_-]+$/.test(env.SUPABASE_PUBLISHABLE_KEY || '')
    && /^sb_secret_[A-Za-z0-9_-]+$/.test(env.SUPABASE_SECRET_KEY || '')
    && !env.ANDROID_FCM_SERVICE_ACCOUNT_JSON);
  const config={
    serviceAccountEmail:env.ANDROID_FCM_SERVICE_ACCOUNT_EMAIL,
    projectNumber:env.GOOGLE_PLAY_WIF_PROJECT_NUMBER,providerResource:env.GOOGLE_PLAY_WIF_PROVIDER_RESOURCE,
    issuer:env.GOOGLE_PLAY_WIF_VERCEL_ISSUER,audience:env.GOOGLE_PLAY_WIF_VERCEL_AUDIENCE,
    customEnvironmentId:env.GOOGLE_PLAY_WIF_VERCEL_CUSTOM_ENVIRONMENT_ID,
  };
  validateAndroidPushIdentity(config);
  return Object.freeze(config);
}

export function validateAndroidPushIdentity(config) {
  const id=androidPushIdentity;
  requirePush(config?.serviceAccountEmail===id.serviceAccountEmail && config.projectNumber===id.projectNumber
    && config.providerResource===id.providerResource && config.issuer===id.issuer && config.audience===id.audience
    && typeof config.customEnvironmentId==='string' && /^[A-Za-z0-9_-]{8,128}$/.test(config.customEnvironmentId)
    && !/placeholder|replace|pending|example/i.test(config.customEnvironmentId));
}
