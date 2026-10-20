import {CheckoutUnavailable,websiteBillingAllowsNative} from './checkoutService.mjs';

/** Google accounts without a Stripe customer use the existing local conflict
 * check. Missing records and orphaned Stripe identifiers still fail closed.
 * Apple retains its eager Stripe configuration check, including free accounts. */
export async function inspectNativeWebsiteBilling({provider,userId,readSubscription,createStripe,readStripeMode}) {
  if(!['apple','google'].includes(provider))throw new CheckoutUnavailable('PROVIDER_UNAVAILABLE');
  const subscription=await readSubscription(userId);
  if(provider==='google' && !subscription?.stripe_customer_id) {
    return websiteBillingAllowsNative({userId,subscription});
  }
  return websiteBillingAllowsNative({userId,subscription,stripe:await createStripe(),liveMode:readStripeMode()==='live'});
}
