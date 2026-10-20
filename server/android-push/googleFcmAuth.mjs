import {AndroidPushError,androidPushIdentity,requirePush,validateAndroidPushIdentity} from './configuration.mjs';

// Deliberately separate from the Play Publisher factory: no JSON, ADC, token-file,
// caller-header or billing scope fallback can reach this dedicated sender identity.
export async function createAndroidFcmAuthClient(config,{
  loadGoogle=()=>import('google-auth-library'),loadOidc=()=>import('@vercel/oidc'),
}={}) {
  validateAndroidPushIdentity(config);
  const {IdentityPoolClient}=await loadGoogle();
  const {getContext,verifyVercelOidcToken}=await loadOidc();
  requirePush(typeof getContext==='function' && typeof verifyVercelOidcToken==='function');
  const id=androidPushIdentity;
  return new IdentityPoolClient({
    type:'external_account',audience:`//iam.googleapis.com/${id.providerResource}`,
    subject_token_type:'urn:ietf:params:oauth:token-type:jwt',token_url:'https://sts.googleapis.com/v1/token',
    service_account_impersonation_url:`https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${id.serviceAccountEmail}:generateAccessToken`,
    scopes:['https://www.googleapis.com/auth/firebase.messaging'],
    transporterOptions:{timeout:10_000,retry:false},forceRefreshOnFailure:false,
    subject_token_supplier:{getSubjectToken:async()=>{
      try {
        const token=getContext()?.headers?.['x-vercel-oidc-token'];
        requirePush(typeof token==='string' && token.length>0 && token.length<=32_768);
        const {payload}=await verifyVercelOidcToken(token,{
          issuer:id.issuer,audience:id.audience,subject:id.subject,ownerId:id.ownerId,
          projectId:id.projectId,environment:id.environment,algorithms:['RS256'],
          requiredClaims:['exp','iat','nbf','sub','custom_environment_id'],
        });
        requirePush(payload.custom_environment_id===config.customEnvironmentId);
        return token;
      } catch {throw new AndroidPushError('CONFIGURATION');}
    }},
  });
}
