import existingBilling from './billing.js';
import {adminRows,authenticatedCafe,subscriptionFor,stripeClient,stripeMode} from './_billing.js';
import {nativeBillingRepository} from '../server/native-billing/repository.mjs';
import {nativeCheckoutService,websiteBillingAllowsNative} from '../server/native-billing/checkoutService.mjs';
import {checkoutHandler} from '../server/native-billing/checkoutHandler.mjs';
import {createCheckoutReadiness} from '../server/native-billing/checkoutReadiness.mjs';
import {captureBillingStatus} from '../server/native-billing/accountBillingHandler.mjs';

const repository=nativeBillingRepository(adminRows);
const readiness=new Map();
export function nativeAccountService(){
    const environment=process.env.NATIVE_BILLING_ENVIRONMENT;
    if(!['Sandbox','Production'].includes(environment)
      || (environment==='Production')!==(process.env.VERCEL_ENV==='production'))throw new Error('Native billing environment unavailable');
    const productId='com.baristajobmatch.cafe.pro.monthly';
    const googlePlan={productId:process.env.GOOGLE_PLAY_PRODUCT_ID,basePlanId:process.env.GOOGLE_PLAY_BASE_PLAN_ID};
    const readinessKey=JSON.stringify([environment,productId,googlePlan.productId,googlePlan.basePlanId]);
    if(!readiness.has(readinessKey)) readiness.set(readinessKey,createCheckoutReadiness({environment,productId,googlePlan}));
    return nativeCheckoutService({repository,environment,productId,googlePlan,
      enabled:process.env.NATIVE_PURCHASES_ENABLED==='true' && process.env.BILLING_ENABLED==='true',
      ready:readiness.get(readinessKey),
      async inspectWebsiteBilling(userId){
        return websiteBillingAllowsNative({userId,subscription:await subscriptionFor(userId),stripe:await stripeClient(),liveMode:stripeMode()==='live'});
      },
    });
}
export default checkoutHandler({
  authenticateCafe:authenticatedCafe,
  serviceFor:nativeAccountService,
  async websiteStatus(req){
    // Reuse the existing Stripe status implementation and all its account and
    // pricing rules. No copied status rules or loopback HTTP with credentials.
    const result=await captureBillingStatus(existingBilling,req);
    if(result.code!==200)throw new Error('Website billing unavailable');
    return result.body;
  },
});
