import existingBilling from './billing.js';
import {adminRows,authenticatedCafe,subscriptionFor,stripeClient,stripeMode} from './_billing.js';
import {nativeBillingRepository} from '../server/native-billing/repository.mjs';
import {nativeCheckoutService,websiteBillingAllowsNative} from '../server/native-billing/checkoutService.mjs';
import {checkoutHandler} from '../server/native-billing/checkoutHandler.mjs';
import {readProviderConfiguration,createProviderRuntime} from '../server/native-billing/runtime.mjs';
import {captureBillingStatus} from '../server/native-billing/accountBillingHandler.mjs';

const repository=nativeBillingRepository(adminRows);
let ready;
export function nativeAccountService(){
    const environment=process.env.NATIVE_BILLING_ENVIRONMENT;
    if(!['Sandbox','Production'].includes(environment)
      || (environment==='Production')!==(process.env.VERCEL_ENV==='production'))throw new Error('Native billing environment unavailable');
    return nativeCheckoutService({repository,environment,
      enabled:process.env.NATIVE_PURCHASES_ENABLED==='true' && process.env.BILLING_ENABLED==='true',productId:'com.baristajobmatch.cafe.pro.monthly',
      async ready(){
        if(!ready){const config=readProviderConfiguration('apple');if(config.productId!=='com.baristajobmatch.cafe.pro.monthly')throw new Error('Store product mismatch');ready=createProviderRuntime(config).catch(error=>{ready=null;throw error;});}
        await ready;
      },
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
