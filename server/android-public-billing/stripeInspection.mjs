import {CheckoutUnavailable} from './errors.mjs';

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const id=(value,prefix)=>typeof value==='string' && new RegExp(`^${prefix}_[A-Za-z0-9_]{1,240}$`).test(value);
const unavailable=()=>{throw new CheckoutUnavailable('PROVIDER_UNAVAILABLE');};
const conflict=()=>{throw new CheckoutUnavailable('WEBSITE_BILLING_EXISTS');};
const email=value=>typeof value==='string' && value.length<=320 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)?value.toLowerCase():null;
const terminal=new Set(['canceled','incomplete_expired']);
const subscriptionStatuses=new Set(['active','trialing','past_due','unpaid','incomplete','paused',...terminal]);

/** Read-only restricted client. The existing account-specific Price pin proves
 * the credential belongs to the approved live Stripe account without Account
 * read/write permissions. No API entry, webhook, mutation or global client. */
export async function createAndroidStripeReadClient({restrictedKey,accountId,priceId}={}, {loadStripe=()=>import('stripe')}={}) {
  if(typeof restrictedKey!=='string' || !/^rk_live_[A-Za-z0-9]+$/.test(restrictedKey)
    || !id(accountId,'acct') || !id(priceId,'price'))unavailable();
  // Capture settings before asynchronous module loading.
  const settings=Object.freeze({restrictedKey,accountId,priceId});
  const module=await loadStripe();
  const Stripe=module.default;
  if(typeof Stripe!=='function')unavailable();
  const client=new Stripe(settings.restrictedKey,{apiVersion:'2026-08-26.dahlia',timeout:5000,maxNetworkRetries:0});
  const price=await client.prices.retrieve(settings.priceId);
  if(!price || price.id!==settings.priceId || price.livemode!==true || price.active!==true
    || price.currency!=='usd' || price.unit_amount!==999 || price.type!=='recurring'
    || price.recurring?.interval!=='month' || price.recurring?.interval_count!==1
    || price.metadata?.application!=='baristamatch' || price.metadata?.plan!=='cafe_monthly'
    || price.metadata?.stripe_account_id!==settings.accountId)unavailable();
  // Expose only fixed read methods; callers cannot create/cancel/refund anything.
  return Object.freeze({
    customers:params=>client.customers.list(params),
    subscriptions:params=>client.subscriptions.list(params),
    sessions:params=>client.checkout.sessions.list(params),
  });
}

/** Exhaustive bounded LIST reads, never eventual-consistency Search. The caller
 * must already hold its durable native reservation. All website checkout paths
 * must continue using the shared cafe-row lock. Out-of-band Dashboard/API writes
 * cannot be atomically locked with Stripe; no cross-provider transaction exists.
 * No remote customers are treated as absent after outages, truncation, malformed
 * pages or ambiguous ownership. Only a fully enumerated live-account result can
 * pass. Email comes from freshly verified Supabase Auth, never the request body. */
export async function inspectAndroidPublicStripeBilling({account,readSubscription,createClient,maxPages=50,timeoutMs=25000}={}) {
  const userId=account?.id,verifiedEmail=email(account?.email);
  if(!uuid.test(userId || '') || account?.role!=='cafe_owner_manager' || account.suspendedAt!=null
    || account.emailConfirmed!==true || !verifiedEmail)conflict();
  if(!Number.isInteger(maxPages) || maxPages<1 || maxPages>50 || !Number.isInteger(timeoutMs) || timeoutMs<1 || timeoutMs>30000)unavailable();
  const local=await readSubscription(userId);
  const own=key=>Object.hasOwn(local,key);
  if(!local || typeof local!=='object' || Array.isArray(local) || !own('user_id') || local.user_id!==userId
    || !own('status') || !['free','canceled','expired','incomplete_expired'].includes(local.status)
    || !own('current_period_end') || !(local.current_period_end===null || typeof local.current_period_end==='string' && Number.isFinite(Date.parse(local.current_period_end)))
    || !own('cancel_at_period_end') || typeof local.cancel_at_period_end!=='boolean'
    || !own('stripe_customer_id') || !(local.stripe_customer_id===null || id(local.stripe_customer_id,'cus'))
    || !own('stripe_subscription_id') || !(local.stripe_subscription_id===null || id(local.stripe_subscription_id,'sub'))
    || !own('stripe_checkout_attempt_id') || local.stripe_checkout_attempt_id!==null
    || (local.stripe_customer_id===null && local.stripe_subscription_id!==null))conflict();
  let stopped=false,timer;
  const scan=(async()=>{
    const client=await createClient();
    if(stopped)unavailable();
    const customers=new Set(),subscriptions=new Set();
    const enumerate=async(kind,prefix,params,visit)=>{
      const seen=new Set();let after;
      for(let page=0;page<maxPages;page++) {
        if(stopped)unavailable();
        const result=await client[kind]({...params,limit:100,...(after?{starting_after:after}:{})});
        if(stopped)unavailable();
        if(result?.object!=='list' || !Array.isArray(result.data) || result.data.length>100 || typeof result.has_more!=='boolean')unavailable();
        for(const row of result.data) {
          if(!row || !id(row.id,prefix) || seen.has(row.id) || row.livemode!==true || row.deleted===true)unavailable();
          seen.add(row.id);visit(row);
        }
        if(!result.has_more)return;
        if(result.data.length===0 || page===maxPages-1)unavailable();
        after=result.data.at(-1).id;
      }
      unavailable();
    };
    await enumerate('customers','cus',{},row=>{
      if(!row.metadata || typeof row.metadata!=='object' || Array.isArray(row.metadata))unavailable();
      const owner=row.metadata.cafe_user_id;
      const matches=owner===userId || row.id===local.stripe_customer_id || email(row.email)===verifiedEmail;
      if(!matches)return;
      // Matching email with absent/different metadata is ambiguous, not Free.
      if(owner!==userId)conflict();
      customers.add(row.id);
    });
    if(local.stripe_customer_id!==null && !customers.has(local.stripe_customer_id))conflict();
    await enumerate('subscriptions','sub',{status:'all'},row=>{
      if(!subscriptionStatuses.has(row.status) || typeof row.customer!=='string' || !id(row.customer,'cus')
        || !row.metadata || typeof row.metadata!=='object' || Array.isArray(row.metadata))unavailable();
      if(!customers.has(row.customer) && row.metadata.cafe_user_id!==userId && row.id!==local.stripe_subscription_id)return;
      if(!customers.has(row.customer))conflict();
      if(row.metadata.cafe_user_id!==undefined && row.metadata.cafe_user_id!==userId)conflict();
      subscriptions.add(row.id);
      // Any renewable/delinquent/unknown legacy plan blocks a second purchase.
      if(!terminal.has(row.status))conflict();
    });
    if(local.stripe_subscription_id!==null && !subscriptions.has(local.stripe_subscription_id))conflict();
    await enumerate('sessions','cs',{status:'open'},row=>{
      if(row.status!=='open' || !row.metadata || typeof row.metadata!=='object' || Array.isArray(row.metadata))unavailable();
      const customer=row.customer;
      if(!(customer===null || typeof customer==='string' && id(customer,'cus')))unavailable();
      if(customers.has(customer) || row.metadata.cafe_user_id===userId || row.client_reference_id===userId
        || email(row.customer_email)===verifiedEmail || email(row.customer_details?.email)===verifiedEmail)conflict();
    });
    return true;
  })();
  try {
    return await Promise.race([scan,new Promise((_,reject)=>{timer=setTimeout(()=>{stopped=true;reject(new CheckoutUnavailable('PROVIDER_UNAVAILABLE'));},timeoutMs);})]);
  } finally {stopped=true;clearTimeout(timer);}
}
