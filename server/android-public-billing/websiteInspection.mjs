import {CheckoutUnavailable} from '../native-billing/checkoutService.mjs';

const fields=['stripe_customer_id','stripe_subscription_id','stripe_checkout_attempt_id'];
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const blocked=()=>{throw new CheckoutUnavailable('WEBSITE_BILLING_EXISTS');};

/** The new Google-only server has no Stripe credential. An existing complete
 * caller-bound free row with three explicit null IDs is the sole local shape
 * case; linked/missing/ambiguous state needs the existing website billing flow.
 * This does not assert that Stripe has no remote customer and is not deletion
 * authorization. The durable native claim remains required around inspection. */
export async function inspectAndroidPublicWebsiteBilling({provider,userId,readSubscription}) {
  if(provider!=='google')throw new CheckoutUnavailable('PROVIDER_UNAVAILABLE');
  if(typeof userId!=='string' || !uuid.test(userId))blocked();
  const row=await readSubscription(userId);
  if(!row || typeof row!=='object' || Array.isArray(row) || !Object.hasOwn(row,'user_id') || row.user_id!==userId)blocked();
  if(!fields.every(key=>Object.hasOwn(row,key) && row[key]===null))blocked();
  if(!Object.hasOwn(row,'status') || row.status!=='free'
    || !Object.hasOwn(row,'current_period_end') || row.current_period_end!==null
    || !Object.hasOwn(row,'cancel_at_period_end') || row.cancel_at_period_end!==false)blocked();
  return true;
}
