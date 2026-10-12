import {randomUUID} from 'node:crypto';
import {CheckoutUnavailable} from './errors.mjs';
import {androidPublicBillingIdentity} from './configuration.mjs';

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const requireValue=(value,code)=>{if(!value)throw new CheckoutUnavailable(code);};
const accountCheck=account=>requireValue(uuid.test(account?.id || '') && account?.role==='cafe_owner_manager'
  && account.suspendedAt==null,'ACCOUNT_UNAVAILABLE');
const selectionCheck=value=>requireValue(value?.provider==='google' && value.productId===androidPublicBillingIdentity.productId
  && value.basePlanId===androidPublicBillingIdentity.basePlanId && value.storefront==='US','PRODUCT_UNAVAILABLE');

/** Google Production only. Existing claim/start atomics retain website, native
 * entitlement and reservation checks. Fresh remote Stripe checks run while the
 * durable claim blocks website checkout, both at prepare and just before start.
 * Cancellation uses the additive Google-only atomic wrapper, never a caller
 * provider field or the reserved-only provider RPC for a started attempt. */
export function androidPublicGoogleCheckoutService({repository,inspectWebsiteBilling,ready,enabled=false,createId=randomUUID}={}) {
  const assertEnabled=()=>requireValue(enabled===true,'NOT_ENABLED');
  const inspect=async account=>requireValue(await inspectWebsiteBilling(account)===true,'WEBSITE_BILLING_EXISTS');
  const unused=async(account,attemptId)=>{try{await repository.cancelGoogleCheckout(account.id,attemptId,true);}catch{/* Unlaunched claims expire safely. */}};
  return Object.freeze({
    async prepare(account,selection) {
      assertEnabled();accountCheck(account);selectionCheck(selection);
      await ready();
      const requestedId=createId();requireValue(uuid.test(requestedId || ''),'CHECKOUT_BLOCKED');
      const attempt=await repository.claimCheckout(account.id,'google','Production',requestedId);
      requireValue(attempt && Object.hasOwn(attempt,'attemptId') && attempt.attemptId===requestedId
        && Object.hasOwn(attempt,'accountBinding') && uuid.test(attempt.accountBinding || ''),'CHECKOUT_BLOCKED');
      try {await inspect(account);return {attemptId:attempt.attemptId,accountBinding:attempt.accountBinding};}
      catch(error){await unused(account,attempt.attemptId);throw error;}
    },
    async start(account,attemptId,selection) {
      assertEnabled();accountCheck(account);selectionCheck(selection);
      requireValue(uuid.test(attemptId || ''),'CHECKOUT_BLOCKED');
      // Trusted DB result, never selection.provider, selects the stored store.
      requireValue(await repository.checkoutProvider(account.id,'Production',attemptId)==='google','CHECKOUT_BLOCKED');
      await ready();
      try {await inspect(account);}
      catch(error){await unused(account,attemptId);throw error;}
      requireValue(await repository.startCheckout(account.id,'Production',attemptId)===true,'CHECKOUT_BLOCKED');
      return {started:true};
    },
    async cancel(account,attemptId,reason) {
      // Cancel remains available when new sales are disabled. Maintenance guard
      // still runs before this service in the endpoint composition.
      accountCheck(account);requireValue(uuid.test(attemptId || '') && reason==='user-cancelled','INVALID_CANCELLATION');
      requireValue(await repository.cancelGoogleCheckout(account.id,attemptId,false)===true,'CHECKOUT_BLOCKED');
      return {cancelled:true};
    },
  });
}

/** Narrow adapter for the already scope-pinned transport. No Apple recovery,
 * broad cancel or account selected by an untrusted request body is exposed. */
export function androidGoogleCheckoutRepository(adminRows) {
  const rpc=(name,body)=>adminRows(`rpc/${name}`,{method:'POST',body:JSON.stringify(body)});
  const owned=userId=>requireValue(uuid.test(userId || ''),'ACCOUNT_UNAVAILABLE');
  const attempt=id=>requireValue(uuid.test(id || ''),'CHECKOUT_BLOCKED');
  const scoped=(provider,environment)=>requireValue(provider==='google' && environment==='Production','CHECKOUT_BLOCKED');
  return Object.freeze({
    claimCheckout(userId,provider,environment,attemptId) {
      owned(userId);attempt(attemptId);scoped(provider,environment);
      return rpc('native_checkout_claim',{p_user_id:userId,p_provider:'google',p_environment:'Production',p_attempt_id:attemptId});
    },
    checkoutProvider(userId,environment,attemptId) {
      owned(userId);attempt(attemptId);scoped('google',environment);
      return rpc('native_checkout_provider',{p_user_id:userId,p_environment:'Production',p_attempt_id:attemptId});
    },
    startCheckout(userId,environment,attemptId) {
      owned(userId);attempt(attemptId);scoped('google',environment);
      return rpc('native_checkout_start',{p_user_id:userId,p_environment:'Production',p_attempt_id:attemptId});
    },
    cancelGoogleCheckout(userId,attemptId,beforeLaunch) {
      owned(userId);attempt(attemptId);requireValue(typeof beforeLaunch==='boolean','INVALID_CANCELLATION');
      return rpc('android_google_checkout_cancel',{p_user_id:userId,p_attempt_id:attemptId,p_before_launch:beforeLaunch});
    },
    settleVerifiedGoogleCheckout(userId) {
      owned(userId);
      return rpc('android_google_checkout_settle_verified',{p_user_id:userId});
    },
  });
}
