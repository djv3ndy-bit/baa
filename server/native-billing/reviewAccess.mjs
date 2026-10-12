/** Android reviewer access is a separate, revocable grant, never a receipt or
 * payment-provider subscription. No client input selects the deployment scope. */
const identity=Object.freeze({
  supabaseUrl:'https://ojvjlvojvozvhktbclcg.supabase.co',
  apiBaseUrl:'https://android-testing.baristajobmatch.com/api',
  packageName:'com.baristajobmatch.app',
  ownerId:'team_W7sLByby0CKVDax9uhMshO5I',projectId:'prj_VuAxQpdhDJPeTPdanA5HjtOrylA5',
  issuer:'https://oidc.vercel.com/baristamatch',audience:'https://vercel.com/baristamatch',
  environment:'android-testing',subject:'owner:baristamatch:project:baa:environment:android-testing',
});
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const unavailable=()=>{throw new Error('Reviewer access is temporarily unavailable.');};
const requireValue=value=>{if(!value)unavailable();};

export function readAndroidReviewConfiguration(env) {
  if(env.ANDROID_REVIEW_ACCESS_ENABLED!== 'true') {
    requireValue(env.ANDROID_REVIEW_ACCESS_ENABLED===undefined || env.ANDROID_REVIEW_ACCESS_ENABLED==='' || env.ANDROID_REVIEW_ACCESS_ENABLED==='false');
    return null;
  }
  requireValue(env.SUPABASE_URL===identity.supabaseUrl && env.ANDROID_REVIEW_API_BASE_URL===identity.apiBaseUrl
    && env.ANDROID_REVIEW_PACKAGE_NAME===identity.packageName && env.NATIVE_BILLING_ENVIRONMENT==='Sandbox'
    && env.VERCEL_ENV==='preview' && env.VERCEL_TARGET_ENV===identity.environment);
  const customEnvironmentId=env.ANDROID_REVIEW_CUSTOM_ENVIRONMENT_ID;
  requireValue(typeof customEnvironmentId==='string' && /^[A-Za-z0-9_-]{8,128}$/.test(customEnvironmentId)
    && !/placeholder|replace|pending|example/i.test(customEnvironmentId)
    && customEnvironmentId===env.GOOGLE_PLAY_WIF_VERCEL_CUSTOM_ENVIRONMENT_ID);
  const allowed=typeof env.ANDROID_REVIEW_USER_IDS==='string'?env.ANDROID_REVIEW_USER_IDS.split(','):[];
  requireValue(allowed.length>0 && allowed.length<=8 && allowed.every(id=>uuid.test(id))
    && new Set(allowed.map(id=>id.toLowerCase())).size===allowed.length);
  return Object.freeze({customEnvironmentId,allowedUserIds:Object.freeze(allowed.map(id=>id.toLowerCase()))});
}

/** Verify the signed platform context afresh, including the server-only CID.
 * There is no incoming-header, file, environment-token, or cached-token fallback. */
export function createAndroidReviewAccess({repository,env=process.env,now=Date.now,
  loadOidc=()=>import('@vercel/oidc')}={}) {
  const config=readAndroidReviewConfiguration(env);
  if(!config)return async()=>null;
  return async account=> {
    requireValue(account?.role==='cafe_owner_manager' && !account.suspendedAt && uuid.test(account.id || ''));
    if(!config.allowedUserIds.includes(account.id.toLowerCase()))return null;
    try {
      const {getContext,verifyVercelOidcToken}=await loadOidc();
      const token=getContext()?.headers?.['x-vercel-oidc-token'];
      requireValue(typeof token==='string' && token.length>0 && token.length<=32768);
      const {payload}=await verifyVercelOidcToken(token,{
        issuer:identity.issuer,audience:identity.audience,subject:identity.subject,
        projectId:identity.projectId,ownerId:identity.ownerId,environment:identity.environment,
        algorithms:['RS256'],requiredClaims:['exp','iat','nbf','sub','custom_environment_id'],
      });
      requireValue(payload.custom_environment_id===config.customEnvironmentId);
      const result=await repository.reviewAccess(account.id,'Sandbox',config.customEnvironmentId);
      if(result===null)return null;
      requireValue(result?.accountId===account.id && result.environment==='Sandbox'
        && result.reviewAccess?.active===true && typeof result.reviewAccess.expiresAt==='string');
      const expiry=Date.parse(result.reviewAccess.expiresAt),current=now();
      requireValue(Number.isFinite(expiry) && Number.isFinite(current));
      if(expiry<=current)return null;
      return {active:true,expiresAt:new Date(expiry).toISOString()};
    } catch { unavailable(); }
  };
}

export function withAndroidReviewAccess(status,reviewAccess) {
  return reviewAccess?{...status,access:'pro',canPurchase:false,canResumeAppleCheckout:false,reviewAccess}:status;
}
