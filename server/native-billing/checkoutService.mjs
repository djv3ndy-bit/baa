import { randomUUID } from 'node:crypto';
import { combinedAccountStatus } from './accountStatus.mjs';
import { APPLE_STORE_GUARD, checkedBillingContext, requireStoreGuard, storeContextView } from './billingContext.mjs';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export class CheckoutUnavailable extends Error {
  constructor(code) { super('Native checkout unavailable'); this.code=code; }
}
const requireValue=(condition,code)=>{if(!condition)throw new CheckoutUnavailable(code);};
export function nativeCheckoutService({ repository, inspectWebsiteBilling, environment, contextFor, enabled, purchaseAllowed=null, productId, ready, createId=randomUUID }) {
  requireValue(['Production','Sandbox'].includes(environment),'CONFIGURATION');
  const accountCheck=account=>requireValue(account?.id && account.role==='cafe_owner_manager' && !account.suspendedAt,'ACCOUNT_UNAVAILABLE');
  const resolve = async(account, provider=null) => checkedBillingContext(contextFor
    ? await contextFor(account.id,provider) : {environment,appleSandboxTester:false});
  const view = context => contextFor ? storeContextView(context) : {};
  const protocolArgs = (context,protocol) => context.appleSandboxTester ? [protocol] : [];
  const enabledFor = (context,provider) => purchaseAllowed === null ? Boolean(enabled)
    : typeof purchaseAllowed === 'function' && purchaseAllowed(context,provider) === true;
  return {
    async status(account,website) {
      accountCheck(account);
      const context=await resolve(account,'apple');
      const purchaseEnabled=enabledFor(context,'apple');
      // Already-verified recorded cleanup remains possible after map revocation.
      for(const recorded of contextFor ? ['Production','Sandbox'] : [environment]) await repository.settleVerifiedCheckout(account.id,recorded);
      const [native,checkoutPending]=await Promise.all([repository.summary(account.id,context.environment),repository.checkoutPending(account.id,context.environment)]);
      const status=combinedAccountStatus({account,website,native,environment:context.environment,checkoutPending});
      const recovery = purchaseEnabled && status.checkoutPending && status.status === 'pending' && status.access === 'free'
        && !website.billingPaused && !status.accessPaused && repository.recoverAppleCheckout
        ? await repository.recoverAppleCheckout(account.id,context.environment,...protocolArgs(context,APPLE_STORE_GUARD)) : null;
      const latest=await resolve(account,'apple');
      requireValue(latest.environment===context.environment && latest.appleSandboxTester===context.appleSandboxTester,'CHECKOUT_BLOCKED');
      return {...status,canPurchase:purchaseEnabled && status.canPurchase,canResumeAppleCheckout:!!recovery,...view(context)};
    },
    async prepare(account,request,protocol=null) {
      accountCheck(account);
      requireValue(request?.provider==='apple' && request.productId===productId && request.storefront==='USA','PRODUCT_UNAVAILABLE');
      const context=await resolve(account,'apple');
      requireValue(enabledFor(context,request.provider),'NOT_ENABLED'); requireStoreGuard(context,protocol);
      // Fail before opening the store if server verification is not configured.
      await ready(context);
      const attempt=await repository.claimCheckout(account.id,'apple',context.environment,createId(),...protocolArgs(context,protocol));
      requireValue(attempt && uuid.test(attempt.attemptId) && uuid.test(attempt.accountBinding),'CHECKOUT_BLOCKED');
      try {
        // A durable DB reservation already blocks a new website Checkout. Check
        // Stripe itself for older sessions/subscriptions, including legacy plans.
        requireValue(await inspectWebsiteBilling(account.id),'WEBSITE_BILLING_EXISTS');
        const latest=await resolve(account,'apple');
        requireValue(latest.environment===context.environment && latest.appleSandboxTester===context.appleSandboxTester,'CHECKOUT_BLOCKED');
        return {...attempt,...view(context)};
      } catch(error) {
        try { await repository.cancelCheckout(account.id,context.environment,attempt.attemptId,true); } catch { /* Unused reservation expires safely. */ }
        throw error;
      }
    },
    async resume(account,request,websiteInput,protocol=null) {
      accountCheck(account);
      requireValue(request?.provider==='apple' && request.productId===productId && request.storefront==='USA','PRODUCT_UNAVAILABLE');
      const context=await resolve(account,'apple');
      requireValue(enabledFor(context,request.provider),'NOT_ENABLED'); requireStoreGuard(context,protocol);
      await ready(context);
      const website=typeof websiteInput==='function' ? await websiteInput() : websiteInput;
      requireValue(website?.billingPaused === false && website.plan === 'free','CHECKOUT_BLOCKED');
      // Reuse the original Apple reservation. Never release it or allocate a
      // second checkout while the first store result is uncertain.
      const attempt=await repository.recoverAppleCheckout(account.id,context.environment,...protocolArgs(context,protocol));
      requireValue(attempt && uuid.test(attempt.attemptId) && uuid.test(attempt.accountBinding),'CHECKOUT_BLOCKED');
      requireValue(await inspectWebsiteBilling(account.id),'WEBSITE_BILLING_EXISTS');
      const latest=await resolve(account,'apple');
      requireValue(latest.environment===context.environment && latest.appleSandboxTester===context.appleSandboxTester,'CHECKOUT_BLOCKED');
      return {...attempt,...view(context)};
    },
    async start(account,attemptId,protocol=null) {
      accountCheck(account);requireValue(uuid.test(attemptId),'CHECKOUT_BLOCKED');
      let attempt;
      if(typeof repository.attemptContext === 'function') {
        attempt=await repository.attemptContext(account.id,attemptId);
        requireValue(attempt && attempt.provider==='apple','CHECKOUT_BLOCKED');
      } else {
        // The new policy must derive provider from an owned durable reservation.
        // Only the legacy service constructor retains its previous fallback.
        requireValue(purchaseAllowed === null,'CHECKOUT_BLOCKED');
      }
      const provider=attempt?.provider || 'apple';
      const context=await resolve(account,provider);
      requireValue(enabledFor(context,provider),'CHECKOUT_BLOCKED'); requireStoreGuard(context,protocol);
      if(attempt) {
        requireValue(attempt && attempt.environment===context.environment && attempt.provider==='apple'
          && (!context.appleSandboxTester || attempt.guardProtocol===APPLE_STORE_GUARD),'CHECKOUT_BLOCKED');
      }
      await ready(context);
      requireValue(await repository.startCheckout(account.id,context.environment,attemptId,...protocolArgs(context,protocol)),'CHECKOUT_BLOCKED');
      return {started:true,...view(context)};
    },
    async cancel(account,attemptId,reason) {
      accountCheck(account);requireValue(uuid.test(attemptId) && ['user-cancelled','store-guard-failed'].includes(reason),'INVALID_CANCELLATION');
      const attempt=repository.attemptContext ? await repository.attemptContext(account.id,attemptId) : {environment};
      requireValue(attempt && ['Production','Sandbox'].includes(attempt.environment),'CHECKOUT_BLOCKED');
      requireValue(await repository.cancelCheckout(account.id,attempt.environment,attemptId,reason==='store-guard-failed'),'CHECKOUT_BLOCKED');
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
