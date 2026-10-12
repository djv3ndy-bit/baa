import {createGoogleAuthClient} from '../native-billing/googleAuth.mjs';
import {googleProvider,verifiedGoogleNotification} from '../native-billing/providers.mjs';
import {validateGoogleCheckoutCatalog} from '../native-billing/googleCheckoutReadiness.mjs';
import {verifiedGoogleStatus,PurchaseVerificationError} from '../native-billing/verifiedStatus.mjs';

/** Google-only factory. It imports no Apple SDK, certificate, Stripe client,
 * email transport or push sender. Instantiate only after scope/auth guards. */
export async function androidGoogleRuntime(configuration,{
  loadGoogle=()=>import('google-auth-library'),loadOidc=()=>import('@vercel/oidc'),now=Date.now,createAuthClient=createGoogleAuthClient,
}={}) {
  if(configuration?.provider!=='google' || configuration.environment!=='Production')throw new Error('Google billing unavailable.');
  const googleConfiguration=Object.freeze({provider:'google',environment:'Production',packageName:configuration.packageName,
    productId:configuration.productId,basePlanId:configuration.basePlanId,authMode:configuration.authMode,wif:configuration.wif});
  const google=await loadGoogle();
  const authClient=await createAuthClient(googleConfiguration,{loadGoogle:async()=>google,loadOidc});
  const provider=googleProvider({...googleConfiguration,authClient,now});
  const notification=configuration.notification;
  const oauthClient=notification?new google.OAuth2Client():null;
  return Object.freeze({provider,
    async ready() {
      const response=await authClient.request({url:`https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${encodeURIComponent(configuration.packageName)}/subscriptions/${encodeURIComponent(configuration.productId)}`,
        method:'GET',timeout:15000});
      validateGoogleCheckoutCatalog(response.data,googleConfiguration);
    },
    async inspectNotification(proof) {
      if(typeof proof!=='string' || !proof || proof.length>8192 || /\s/.test(proof))throw new PurchaseVerificationError('INVALID_PROOF');
      const response=await authClient.request({url:`https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${encodeURIComponent(configuration.packageName)}/purchases/subscriptionsv2/tokens/${encodeURIComponent(proof)}`,
        method:'GET',timeout:15000});
      const data=response.data,binding=data?.externalAccountIdentifiers?.obfuscatedExternalAccountId;
      if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(binding || ''))throw new PurchaseVerificationError('ACCOUNT_MISMATCH');
      if(data && Object.hasOwn(data,'testPurchase') && (!data.testPurchase || typeof data.testPurchase!=='object' || Array.isArray(data.testPurchase)))throw new PurchaseVerificationError('INVALID_RESPONSE');
      const environment=data?.testPurchase?'Sandbox':'Production';
      const verified=verifiedGoogleStatus(data,{...googleConfiguration,environment,binding,purchaseToken:proof},now());
      return Object.freeze({environment:verified.environment,binding:verified.binding,providerSubscriptionId:verified.providerSubscriptionId});
    },
    async notification(authorization,body) {
      if(!notification || !oauthClient)throw new Error('Google events unavailable.');
      return verifiedGoogleNotification({authorization,body,oauthClient,audience:notification.audience,
        serviceAccountEmail:notification.serviceAccountEmail,packageName:configuration.packageName});
    },
  });
}
