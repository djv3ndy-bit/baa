import existingBilling from './billing.js';
import {adminRows,authenticatedCafe,subscriptionFor,stripeClient,stripeMode} from './_billing.js';
import {nativeBillingRepository} from '../server/native-billing/repository.mjs';
import {websiteBillingAllowsNative} from '../server/native-billing/checkoutService.mjs';
import {createNativeAccountService} from '../server/native-billing/checkoutRuntime.mjs';
import {checkoutHandler} from '../server/native-billing/checkoutHandler.mjs';
import {captureBillingStatus} from '../server/native-billing/accountBillingHandler.mjs';

const repository=nativeBillingRepository(adminRows);
export const nativeAccountService=createNativeAccountService({repository,
  async inspectWebsiteBilling(userId){
    return websiteBillingAllowsNative({userId,subscription:await subscriptionFor(userId),stripe:await stripeClient(),liveMode:stripeMode()==='live'});
  },
});
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
