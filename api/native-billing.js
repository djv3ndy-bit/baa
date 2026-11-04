import existingBilling from './billing.js';
import {adminRows,authenticatedCafe,subscriptionFor,stripeClient,stripeMode} from './_billing.js';
import {nativeBillingRepository} from '../server/native-billing/repository.mjs';
import {nativeCheckoutService,websiteBillingAllowsNative} from '../server/native-billing/checkoutService.mjs';
import {checkoutHandler} from '../server/native-billing/checkoutHandler.mjs';
import {readContextConfiguration,providerRuntimeCache} from '../server/native-billing/runtime.mjs';
import {configuredBillingContext} from '../server/native-billing/billingContext.mjs';
import {captureBillingStatus} from '../server/native-billing/accountBillingHandler.mjs';
import {nativePurchasePolicyFromEnvironment} from '../server/native-billing/purchasePolicy.mjs';
import {ownedAppleRefresh} from '../server/native-billing/ownedAppleRefresh.mjs';

const repository=nativeBillingRepository(adminRows);
const runtime=providerRuntimeCache();
export function nativeAccountService(){
    const environment=process.env.NATIVE_BILLING_ENVIRONMENT;
    if(!['Sandbox','Production'].includes(environment)
      || (environment==='Production')!==(process.env.VERCEL_ENV==='production'))throw new Error('Native billing environment unavailable');
    const productId='com.baristajobmatch.cafe.pro.monthly';
    const contextFor=async(userId,provider,options={})=>configuredBillingContext(await repository.context(userId,provider,options),environment,provider);
    const refreshExisting=ownedAppleRefresh({repository,environment,productId,contextFor,
      budgetSecret:()=>process.env.SUPABASE_SECRET_KEY,
      async providerFor(context){
        const config=readContextConfiguration('apple',context);
        if(config.productId!==productId)throw new Error('Store product mismatch');
        return (await runtime(config)).provider;
      },
    });
    return nativeCheckoutService({repository,environment,
      contextFor,refreshExisting,
      enabled:process.env.NATIVE_PURCHASES_ENABLED==='true' && process.env.BILLING_ENABLED==='true',productId,
      purchaseAllowed:nativePurchasePolicyFromEnvironment(process.env),
      async ready(context){
        const config=readContextConfiguration('apple',context);
        if(config.productId!=='com.baristajobmatch.cafe.pro.monthly')throw new Error('Store product mismatch');
        await runtime(config);
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
