import {combinedAccountStatus} from '../native-billing/accountStatus.mjs';

const statuses=new Set(['free','active','trialing','past_due','unpaid','incomplete','incomplete_expired','paused','canceled','expired']);
const manageable=new Set(['active','trialing','past_due','unpaid','incomplete','paused']);
const invalid=()=>{throw new Error('Subscription details are temporarily unavailable.');};
const identifier=(value,prefix)=>value===null || typeof value==='string' && new RegExp(`^${prefix}_[A-Za-z0-9_]+$`).test(value);

/** Preserve the database-backed Stripe access contract. This is not a remote
 * Stripe conflict check; complimentary hiring access is not paid Pro. The
 * paused bit refers only to this candidate's unavailable Google checkout. */
export function androidWebsiteBillingProjection(row,userId,{checkoutEnabled=false}={}) {
  if(!row || typeof row!=='object' || Array.isArray(row) || row.user_id!==userId
    || !statuses.has(row.status) || typeof row.cancel_at_period_end!=='boolean' || typeof row.complimentary_access!=='boolean'
    || !(row.current_period_end===null || typeof row.current_period_end==='string' && Number.isFinite(Date.parse(row.current_period_end)))
    || !identifier(row.stripe_customer_id,'cus') || !identifier(row.stripe_subscription_id,'sub')
    || !(row.stripe_checkout_attempt_id===null || typeof row.stripe_checkout_attempt_id==='string'))invalid();
  const connectedToBilling=row.stripe_customer_id!==null && row.stripe_subscription_id!==null;
  return {status:row.status,currentPeriodEnd:row.current_period_end,cancelAtPeriodEnd:row.cancel_at_period_end,
    complimentaryAccess:row.complimentary_access,connectedToBilling,
    canManageBilling:connectedToBilling && manageable.has(row.status),billingPaused:checkoutEnabled!==true,
    plan:connectedToBilling && ['active','trialing'].includes(row.status)?'pro':'free',
    monthlyPriceCents:999,maxActiveJobs:3,
    message:'Billing is not active. Café accounts will not be charged during the plan preview.'};
}

/** Only read summary/pending state: never settle a reservation, recover Apple
 * checkout or interpret a failed ledger read as Free. */
export async function androidPublicReadOnlyStatus({account,transport,repository,now=Date.now,checkoutEnabled=false}) {
  const [row,native,pending]=await Promise.all([transport.subscriptionFor(account.id),
    repository.summary(account.id,'Production'),repository.checkoutPending(account.id,'Production')]);
  const combined=combinedAccountStatus({account,website:androidWebsiteBillingProjection(row,account.id,{checkoutEnabled}),
    native,environment:'Production',checkoutPending:pending,now:now()});
  return {...combined,canPurchase:checkoutEnabled===true && account.emailConfirmed===true && combined.canPurchase,canResumeAppleCheckout:false};
}
