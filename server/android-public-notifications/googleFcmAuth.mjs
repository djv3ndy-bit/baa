import {publicPushIdentity,requirePush,PublicPushError,assertPublicPushIdentity} from './configuration.mjs';

/** Dedicated messaging scope and identity. No Publisher, JSON, ADC, file or
 * caller-header token source is accepted. The supplier runs on every refresh. */
export async function createPublicFcmAuth({loadGoogle=()=>import('google-auth-library'),loadOidc=()=>import('@vercel/oidc'),now=Date.now}={}) {
  const id=publicPushIdentity,{IdentityPoolClient}=await loadGoogle();
  const {getContext,verifyVercelOidcToken}=await loadOidc();
  requirePush(typeof getContext==='function'&&typeof verifyVercelOidcToken==='function');
  return new IdentityPoolClient({type:'external_account',audience:`//iam.googleapis.com/${id.providerResource}`,
    subject_token_type:'urn:ietf:params:oauth:token-type:jwt',token_url:'https://sts.googleapis.com/v1/token',
    service_account_impersonation_url:`https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${id.serviceAccountEmail}:generateAccessToken`,
    scopes:['https://www.googleapis.com/auth/firebase.messaging'],
    transporterOptions:{timeout:10_000,retry:false},forceRefreshOnFailure:false,
    subject_token_supplier:{getSubjectToken:async()=>{
      try {
        const token=getContext()?.headers?.['x-vercel-oidc-token'];
        requirePush(typeof token==='string'&&token.length>0&&token.length<=32768);
        const {payload}=await verifyVercelOidcToken(token,{issuer:id.issuer,audience:id.audience,
          subject:id.subject,ownerId:id.ownerId,projectId:id.projectId,environment:id.environment,
          algorithms:['RS256'],requiredClaims:['exp','iat','nbf','sub','owner_id','project_id','environment']});
        assertPublicPushIdentity(payload,now());
        return token;
      } catch {throw new PublicPushError('IDENTITY');}
    }},
  });
}
