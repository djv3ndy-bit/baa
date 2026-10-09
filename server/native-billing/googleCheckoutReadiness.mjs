import { PurchaseVerificationError } from './verifiedStatus.mjs';
import {createGoogleAuthClient} from './googleAuth.mjs';

const requireConfiguration=value=> { if(!value) throw new PurchaseVerificationError('SERVER_CONFIGURATION'); };

/** Only the normal monthly base plan is approved at launch. A successful read
 * establishes catalog access, not permission to verify/acknowledge purchases. */
export function validateGoogleCheckoutCatalog(subscription,config) {
  requireConfiguration(subscription?.packageName===config.packageName && subscription.productId===config.productId && subscription.archived!==true);
  const plans=Array.isArray(subscription.basePlans) ? subscription.basePlans.filter(plan=>plan?.basePlanId===config.basePlanId) : [];
  requireConfiguration(plans.length===1);
  const plan=plans[0];
  requireConfiguration(plan.state==='ACTIVE' && plan.autoRenewingBasePlanType?.billingPeriodDuration==='P1M'
    && !plan.prepaidBasePlanType && !plan.installmentsBasePlanType && Array.isArray(plan.regionalConfigs));
  const us=plan.regionalConfigs.filter(region=>region?.regionCode==='US');
  requireConfiguration(us.length===1 && us[0].newSubscriberAvailability===true);
  const price=us[0].price;
  requireConfiguration(price?.currencyCode==='USD' && String(price.units)==='9' && price.nanos===990_000_000);
  const unavailable=value=>value===false || value===undefined;
  requireConfiguration(plan.regionalConfigs.every(region=>/^[A-Z]{2}$/.test(region?.regionCode || '')
    && (region.regionCode==='US' || unavailable(region.newSubscriberAvailability)))
    && unavailable(plan.otherRegionsConfig?.newSubscriberAvailability));
}

export async function verifyGoogleCheckoutCatalog(config,{loadGoogle=()=>import('google-auth-library'),loadOidc=()=>import('@vercel/oidc'),timeoutMs=15_000}={}) {
  requireConfiguration(config?.provider==='google' && config.packageName==='com.baristajobmatch.app'
    && /^[a-z0-9][a-z0-9_.]{0,39}$/.test(config.productId || '') && /^[a-z0-9][a-z0-9-]{0,62}$/.test(config.basePlanId || ''));
  let deadline;
  // Bound SDK loading, authentication and the read, including token exchange.
  // A late read cannot authorize checkout after this promise has rejected.
  const timeout=new Promise((_,reject)=> { deadline=setTimeout(()=>reject(new PurchaseVerificationError('SERVER_CONFIGURATION')),timeoutMs); });
  try {
    const response=await Promise.race([timeout,(async()=> {
      const client=await createGoogleAuthClient(config,{loadGoogle,loadOidc});
      return client.request({
        url:`https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${encodeURIComponent(config.packageName)}/subscriptions/${encodeURIComponent(config.productId)}`,
        method:'GET',timeout:timeoutMs,
      });
    })()]);
    validateGoogleCheckoutCatalog(response.data,config);
  } finally { clearTimeout(deadline); }
}
