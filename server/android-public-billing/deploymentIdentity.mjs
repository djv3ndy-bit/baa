import {androidPublicBillingIdentity,assertAndroidPublicBillingIdentity} from './configuration.mjs';

/** Verify the platform's current request context, never an application header
 * or a fallback environment/file token. No raw token leaves this function. */
export async function verifiedAndroidDeploymentIdentity({loadOidc=()=>import('@vercel/oidc'),now=Date.now}={}) {
  const expected=androidPublicBillingIdentity;
  const {getContext,verifyVercelOidcToken}=await loadOidc();
  if(typeof getContext!=='function' || typeof verifyVercelOidcToken!=='function')throw new Error('Deployment identity unavailable.');
  const token=getContext()?.headers?.['x-vercel-oidc-token'];
  if(typeof token!=='string' || !token || token.length>32768)throw new Error('Deployment identity unavailable.');
  const {payload}=await verifyVercelOidcToken(token,{issuer:expected.issuer,audience:expected.audience,
    subject:expected.subject,ownerId:expected.ownerId,projectId:expected.projectId,environment:expected.environment,
    algorithms:['RS256'],requiredClaims:['exp','iat','nbf','sub','owner_id','project_id','environment']});
  assertAndroidPublicBillingIdentity(payload,now());
  return payload;
}
