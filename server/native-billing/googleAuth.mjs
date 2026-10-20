import {PurchaseVerificationError} from './verifiedStatus.mjs';

const check=value=> { if(!value) throw new PurchaseVerificationError('SERVER_CONFIGURATION'); };
const scope='https://www.googleapis.com/auth/androidpublisher';
const identity=Object.freeze({
  projectNumber:'397053773139',
  providerResource:'projects/397053773139/locations/global/workloadIdentityPools/baristamatch-android-test/providers/vercel-android-testing',
  serviceAccountEmail:'baristamatch-play-test@baristamatch.iam.gserviceaccount.com',
  ownerId:'team_W7sLByby0CKVDax9uhMshO5I',
  projectId:'prj_VuAxQpdhDJPeTPdanA5HjtOrylA5',
  environment:'android-testing',
  issuer:'https://oidc.vercel.com/baristamatch',
  audience:'https://vercel.com/baristamatch',
  subject:'owner:baristamatch:project:baa:environment:android-testing',
});
const productionIdentity=Object.freeze({
  projectNumber:'397053773139',
  providerResource:'projects/397053773139/locations/global/workloadIdentityPools/baristamatch-android-public/providers/vercel-android-production',
  serviceAccountEmail:'baristamatch-play-public@baristamatch.iam.gserviceaccount.com',
  ownerId:'team_W7sLByby0CKVDax9uhMshO5I',
  projectId:'prj_7YTEsQnXSfNQpM0jNBGQ1T4BA07Q',
  environment:'production',
  issuer:'https://oidc.vercel.com/baristamatch',
  audience:'https://vercel.com/baristamatch',
  subject:'owner:baristamatch:project:baristamatch-android:environment:production',
});

function validateWif(wif, selectedIdentity=identity) {
  check(wif?.projectNumber===selectedIdentity.projectNumber && wif.serviceAccountEmail===selectedIdentity.serviceAccountEmail);
  check(wif.providerResource===selectedIdentity.providerResource);
  // Both projects use the explicitly selected team issuer mode.
  check(wif.issuer===selectedIdentity.issuer && wif.audience===selectedIdentity.audience);
  if(selectedIdentity===productionIdentity) {
    check(wif.customEnvironmentId===undefined);
    return;
  }
  check(typeof wif.customEnvironmentId==='string'
    && /^[A-Za-z0-9_-]{8,128}$/.test(wif.customEnvironmentId)
    && !/placeholder|replace|pending|example/i.test(wif.customEnvironmentId));
}

/** Local environment checks are configuration safeguards. The signed JWT and
 * Google's provider condition must both bind the selected dedicated deployment;
 * editable branch/environment variables cannot establish that trust. */
export function readGoogleWifConfiguration(env) {
  const production=env.NATIVE_BILLING_ENVIRONMENT==='Production';
  if(production) {
    check(env.GOOGLE_PLAY_AUTH_MODE==='vercel_oidc' && env.VERCEL_ENV==='production'
      && env.VERCEL_TARGET_ENV===productionIdentity.environment && !env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON);
  } else {
    check(env.NATIVE_BILLING_ENVIRONMENT==='Sandbox' && env.VERCEL_ENV==='preview'
      && env.VERCEL_TARGET_ENV===identity.environment && !env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON);
  }
  const wif={
    projectNumber:env.GOOGLE_PLAY_WIF_PROJECT_NUMBER,
    serviceAccountEmail:env.GOOGLE_PLAY_WIF_SERVICE_ACCOUNT_EMAIL,
    providerResource:env.GOOGLE_PLAY_WIF_PROVIDER_RESOURCE,
    issuer:env.GOOGLE_PLAY_WIF_VERCEL_ISSUER,
    audience:env.GOOGLE_PLAY_WIF_VERCEL_AUDIENCE,
    customEnvironmentId:env.GOOGLE_PLAY_WIF_VERCEL_CUSTOM_ENVIRONMENT_ID,
  };
  validateWif(wif,production ? productionIdentity : identity);
  return {authMode:'vercel_oidc',wif};
}

/** The Google auth client may cache Google access tokens. Its supplier reads
 * and verifies the current platform request token on every federation refresh.
 * No request object or raw Vercel token is captured by this factory. */
export async function createGoogleAuthClient(config,{
  loadGoogle=()=>import('google-auth-library'),loadOidc=()=>import('@vercel/oidc'),
}={}) {
  check(config?.provider==='google');
  if(config.authMode===undefined || config.authMode==='service_account_json') {
    check(config.credentials?.type==='service_account');
    const {GoogleAuth}=await loadGoogle();
    const auth=new GoogleAuth({credentials:config.credentials,scopes:[scope]});
    return auth.getClient();
  }
  check(config.authMode==='vercel_oidc' && ['Sandbox','Production'].includes(config.environment) && !config.credentials);
  const selectedIdentity=config.environment==='Production' ? productionIdentity : identity;
  // Do not let later caller mutation replace the validated production settings.
  const wif=selectedIdentity===productionIdentity ? Object.freeze({...config.wif}) : config.wif;
  validateWif(wif,selectedIdentity);
  const {IdentityPoolClient}=await loadGoogle();
  const {getContext,verifyVercelOidcToken}=await loadOidc();
  check(typeof getContext==='function' && typeof verifyVercelOidcToken==='function');
  return new IdentityPoolClient({
    type:'external_account',
    audience:`//iam.googleapis.com/${wif.providerResource}`,
    subject_token_type:'urn:ietf:params:oauth:token-type:jwt',
    token_url:'https://sts.googleapis.com/v1/token',
    service_account_impersonation_url:`https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${selectedIdentity.serviceAccountEmail}:generateAccessToken`,
    scopes:[scope],
    subject_token_supplier:{getSubjectToken:async()=> {
      try {
        // Never call the SDK's fallback-capable getVercelOidcToken helper or
        // accept a header from the application's incoming request argument.
        const token=getContext()?.headers?.['x-vercel-oidc-token'];
        check(typeof token==='string' && token.length>0 && token.length<=32_768);
        const {payload}=await verifyVercelOidcToken(token,{
          issuer:wif.issuer,audience:wif.audience,subject:selectedIdentity.subject,
          projectId:selectedIdentity.projectId,ownerId:selectedIdentity.ownerId,environment:selectedIdentity.environment,
          algorithms:['RS256'],requiredClaims:selectedIdentity===productionIdentity
            ? ['exp','iat','nbf','sub','owner_id','project_id','environment'] : ['exp','iat','nbf','sub','custom_environment_id'],
        });
        if(selectedIdentity===productionIdentity) {
          // Production is a built-in environment, not a Custom Environment.
          // Inspect claims only after the actual SDK verified the signature.
          check(payload.custom_environment_id===undefined && payload.aud===productionIdentity.audience);
          check(Number.isInteger(payload.iat) && payload.iat<=Math.floor(Date.now()/1000)
            && payload.exp>payload.iat && payload.exp-payload.iat<=86_400);
        } else check(payload.custom_environment_id===wif.customEnvironmentId);
        return token;
      } catch { throw new PurchaseVerificationError('SERVER_CONFIGURATION'); }
    }},
  });
}
