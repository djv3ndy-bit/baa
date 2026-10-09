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

function validateWif(wif) {
  check(wif?.projectNumber===identity.projectNumber && wif.serviceAccountEmail===identity.serviceAccountEmail);
  check(wif.providerResource===identity.providerResource);
  // The existing project uses team issuer mode; never infer it from a token.
  check(wif.issuer===identity.issuer);
  check(wif.audience===identity.audience && typeof wif.customEnvironmentId==='string'
    && /^[A-Za-z0-9_-]{8,128}$/.test(wif.customEnvironmentId)
    && !/placeholder|replace|pending|example/i.test(wif.customEnvironmentId));
}

/** Local environment checks are configuration safeguards. The signed JWT and
 * Google's provider condition must both bind the dedicated Custom Environment;
 * editable branch/environment variables cannot establish that trust. */
export function readGoogleWifConfiguration(env) {
  check(env.NATIVE_BILLING_ENVIRONMENT==='Sandbox' && env.VERCEL_ENV==='preview'
    && env.VERCEL_TARGET_ENV===identity.environment && !env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON);
  const wif={
    projectNumber:env.GOOGLE_PLAY_WIF_PROJECT_NUMBER,
    serviceAccountEmail:env.GOOGLE_PLAY_WIF_SERVICE_ACCOUNT_EMAIL,
    providerResource:env.GOOGLE_PLAY_WIF_PROVIDER_RESOURCE,
    issuer:env.GOOGLE_PLAY_WIF_VERCEL_ISSUER,
    audience:env.GOOGLE_PLAY_WIF_VERCEL_AUDIENCE,
    customEnvironmentId:env.GOOGLE_PLAY_WIF_VERCEL_CUSTOM_ENVIRONMENT_ID,
  };
  validateWif(wif);
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
  check(config.authMode==='vercel_oidc' && config.environment==='Sandbox' && !config.credentials);
  validateWif(config.wif);
  const {IdentityPoolClient}=await loadGoogle();
  const {getContext,verifyVercelOidcToken}=await loadOidc();
  check(typeof getContext==='function' && typeof verifyVercelOidcToken==='function');
  const wif=config.wif;
  return new IdentityPoolClient({
    type:'external_account',
    audience:`//iam.googleapis.com/${wif.providerResource}`,
    subject_token_type:'urn:ietf:params:oauth:token-type:jwt',
    token_url:'https://sts.googleapis.com/v1/token',
    service_account_impersonation_url:`https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${identity.serviceAccountEmail}:generateAccessToken`,
    scopes:[scope],
    subject_token_supplier:{getSubjectToken:async()=> {
      try {
        // Never call the SDK's fallback-capable getVercelOidcToken helper or
        // accept a header from the application's incoming request argument.
        const token=getContext()?.headers?.['x-vercel-oidc-token'];
        check(typeof token==='string' && token.length>0 && token.length<=32_768);
        const {payload}=await verifyVercelOidcToken(token,{
          issuer:wif.issuer,audience:wif.audience,subject:identity.subject,
          projectId:identity.projectId,ownerId:identity.ownerId,environment:identity.environment,
          algorithms:['RS256'],requiredClaims:['exp','iat','nbf','sub','custom_environment_id'],
        });
        check(payload.custom_environment_id===wif.customEnvironmentId);
        return token;
      } catch { throw new PurchaseVerificationError('SERVER_CONFIGURATION'); }
    }},
  });
}
