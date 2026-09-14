import { randomUUID } from 'node:crypto';
import { combinedAccountStatus } from './accountStatus.mjs';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export class CheckoutUnavailable extends Error {
  constructor(code) { super('Native checkout unavailable'); this.code=code; }
}
const requireValue=(condition,code)=>{if(!condition)throw new CheckoutUnavailable(code);};
export function nativeCheckoutService({ repository, inspectWebsiteBilling, environment, enabled, productId, ready, createId=randomUUID }) {
  requireValue(['Production','Sandbox'].includes(environment),'CONFIGURATION');
  const accountCheck=account=>requireValue(account?.id && account.role==='cafe_owner_manager' && !account.suspendedAt,'ACCOUNT_UNAVAILABLE');
  return {
    async status(account,website) {
      accountCheck(account);
      await repository.settleVerifiedCheckout(account.id,environment);
      const [native,checkoutPending]=await Promise.all([repository.summary(account.id,environment),repository.checkoutPending(account.id,environment)]);
      const status=combinedAccountStatus({account,website,native,environment,checkoutPending});
      return {...status,canPurchase:enabled && status.canPurchase};
    },
    async prepare(account,request) {
      accountCheck(account);
      requireValue(enabled,'NOT_ENABLED');
      requireValue(request?.provider==='apple' && request.productId===productId && request.storefront==='USA','PRODUCT_UNAVAILABLE');
      // Fail before opening the store if server verification is not configured.
      await ready();
      const attempt=await repository.claimCheckout(account.id,'apple',environment,createId());
      requireValue(attempt && uuid.test(attempt.attemptId) && uuid.test(attempt.accountBinding),'CHECKOUT_BLOCKED');
      try {
        // A durable DB reservation already blocks a new website Checkout. Check
        // Stripe itself for older sessions/subscriptions, including legacy plans.
        requireValue(await inspectWebsiteBilling(account.id),'WEBSITE_BILLING_EXISTS');
        return attempt;
      } catch(error) {
        try { await repository.cancelCheckout(account.id,environment,attempt.attemptId,true); } catch { /* Unused reservation expires safely. */ }
        throw error;
      }
    },
    async start(account,attemptId) {
      accountCheck(account);requireValue(enabled && uuid.test(attemptId),'CHECKOUT_BLOCKED');
      await ready();
      requireValue(await repository.startCheckout(account.id,environment,attemptId),'CHECKOUT_BLOCKED');
      return {started:true};
    },
    async cancel(account,attemptId,reason) {
      accountCheck(account);requireValue(uuid.test(attemptId) && reason==='user-cancelled','INVALID_CANCELLATION');
      requireValue(await repository.cancelCheckout(account.id,environment,attemptId,false),'CHECKOUT_BLOCKED');
      return {cancelled:true};
    },
  };
}

/** Only reads the existing provider. An open web checkout is preserved and
 * must be finished/canceled there before starting another subscription. */
export async function websiteBillingAllowsNative({userId,subscription,stripe,liveMode}) {
  if (!subscription) return false;
  if (!subscription.stripe_customer_id) return !subscription.stripe_subscription_id && !subscription.stripe_checkout_attempt_id;
  const customer=await stripe.customers.retrieve(subscription.stripe_customer_id);
  if (customer.deleted || customer.id!==subscription.stripe_customer_id || customer.livemode!==liveMode || customer.metadata?.cafe_user_id!==userId) return false;
  let after;
  for(let page=0;page<50;page++) {
    const result=await stripe.subscriptions.list({customer:customer.id,status:'all',limit:100,...(after?{starting_after:after}:{})});
    if(!Array.isArray(result.data) || typeof result.has_more!=='boolean') throw new CheckoutUnavailable('PROVIDER_UNAVAILABLE');
    for(const row of result.data) {
      if(row.livemode!==liveMode || (typeof row.customer==='string'?row.customer:row.customer?.id)!==customer.id) throw new CheckoutUnavailable('PROVIDER_UNAVAILABLE');
      if(!['canceled','incomplete_expired'].includes(row.status)) return false;
    }
    if(!result.has_more)break;
    const next=result.data.at(-1)?.id;
    if(!next || next===after || page===49)throw new CheckoutUnavailable('PROVIDER_UNAVAILABLE');
    after=next;
  }
  const sessions=await stripe.checkout.sessions.list({customer:customer.id,status:'open',limit:100});
  if(!Array.isArray(sessions.data) || typeof sessions.has_more!=='boolean')throw new CheckoutUnavailable('PROVIDER_UNAVAILABLE');
  // Any open Checkout can conflict. Do not guess the purpose of an old plan.
  return sessions.data.length===0 && !sessions.has_more;
}
