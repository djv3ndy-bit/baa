import {readProviderConfiguration,createProviderRuntime} from './runtime.mjs';
import {verifyGoogleCheckoutCatalog} from './googleCheckoutReadiness.mjs';
import {PurchaseVerificationError} from './verifiedStatus.mjs';

/** The selected provider is checked against server configuration, never against
 * configuration copied from the request. Failed initialization is retryable. */
export function createCheckoutReadiness({environment,productId,googlePlan}, {
  readConfiguration=readProviderConfiguration,createRuntime=createProviderRuntime,
  verifyGoogleCatalog=verifyGoogleCheckoutCatalog,
}={}) {
  const runtimes=new Map();
  return async provider=> {
    if(!['apple','google'].includes(provider)) throw new PurchaseVerificationError('SERVER_CONFIGURATION');
    const config=readConfiguration(provider);
    if(config.provider!==provider || config.environment!==environment || config.productId!==(provider==='apple' ? productId : googlePlan?.productId)
      || (provider==='google' && config.basePlanId!==googlePlan?.basePlanId)) throw new PurchaseVerificationError('SERVER_CONFIGURATION');
    const key=[provider,config.environment,config.productId,config.basePlanId || ''].join(':');
    if(!runtimes.has(key)) runtimes.set(key,Promise.resolve().then(()=>createRuntime(config)).catch(error=>{runtimes.delete(key);throw error;}));
    await runtimes.get(key);
    // Read each time, including startup after the reservation. Do not cache a
    // successful catalog check after an administrator changes the store plan.
    if(provider==='google') await verifyGoogleCatalog(config);
  };
}
