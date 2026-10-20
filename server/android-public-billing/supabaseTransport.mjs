import {androidPublicBillingIdentity} from './configuration.mjs';

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const fail=()=>{throw new Error('Android account services are unavailable.');};
const subscriptionFields='user_id,status,current_period_end,cancel_at_period_end,complimentary_access,stripe_customer_id,stripe_subscription_id,stripe_checkout_attempt_id';
const rpcNames=new Set(['native_billing_summary','native_checkout_pending','native_billing_owner','native_billing_read',
  'native_billing_apply','native_billing_claim_event','native_billing_finish_event',
  'native_checkout_claim','native_checkout_provider','native_checkout_start',
  'android_google_checkout_cancel','android_google_checkout_settle_verified']);

/** A private transport with fixed destinations and no caller-controlled headers.
 * Construct lazily after the separate deployment/maintenance guard passed. */
export function androidSupabaseTransport(configuration,{fetchImpl=fetch,timeoutMs=10000}={}) {
  const source=configuration?.supabase;
  if(source?.url!==androidPublicBillingIdentity.supabaseUrl
    || !/^sb_publishable_[A-Za-z0-9_-]+$/.test(source.publishableKey || '')
    || !/^sb_secret_[A-Za-z0-9_-]+$/.test(source.secretKey || '')
    || !Number.isInteger(timeoutMs) || timeoutMs<1 || timeoutMs>15000)fail();
  const settings=Object.freeze({...source});
  const request=async(path,{method='GET',body,token,publicAuth=false}={})=>{
    const headers={apikey:publicAuth?settings.publishableKey:settings.secretKey,'Content-Type':'application/json'};
    if(publicAuth)headers.Authorization=`Bearer ${token}`;
    const response=await fetchImpl(`${settings.url}${path}`,{method,headers,redirect:'error',
      signal:AbortSignal.timeout(timeoutMs),...(body===undefined?{}:{body:JSON.stringify(body)})});
    if(!response.ok) {
      if(publicAuth && [400,401,403].includes(response.status))return null;
      fail();
    }
    const text=await response.text();
    if(Buffer.byteLength(text)>1048576)fail();
    try{return text?JSON.parse(text):[];}catch{fail();}
  };
  const rows=async(path)=>{
    const result=await request(`/rest/v1/${path}`);
    if(!Array.isArray(result) || result.length>1)fail();
    return result;
  };
  const profile=async id=>{
    if(!uuid.test(id || ''))fail();
    const result=await rows(`profiles?id=eq.${id}&select=id,role,suspended_at&limit=2`);
    const row=result[0];
    if(row && (row.id!==id || typeof row.role!=='string' || !Object.hasOwn(row,'suspended_at')))fail();
    return row ?? null;
  };
  return Object.freeze({
    async connectionCheck() {
      // These fixed reserved probes cannot be selected by an API caller. A
      // nonempty response stops before the service-only schema lookup.
      const sentinel='00000000-0000-4000-8000-000000000000';
      const absent=await rows(`profiles?id=eq.${sentinel}&select=id&limit=2`);
      if(absent.length!==0)fail();
      const lookup=await request('/rest/v1/rpc/native_checkout_provider',{method:'POST',body:{
        p_user_id:sentinel,p_environment:'Production',p_attempt_id:'00000000-0000-4000-8000-000000000001'}});
      if(lookup!==null)fail();
    },
    async authenticateCafe(req) {
      const authorization=req.headers?.authorization;
      if(typeof authorization!=='string' || authorization.length>32776)return null;
      const matched=/^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(authorization);
      if(!matched)return null;
      const user=await request('/auth/v1/user',{publicAuth:true,token:matched[1]});
      if(user===null)return null;
      if(!user || !uuid.test(user.id || ''))fail();
      const owned=await profile(user.id);
      if(!owned)return null;
      // Only the fresh Auth response may establish email ownership. Never use
      // mutable user_metadata, a profile field or the request body for Stripe.
      const email=typeof user.email==='string' && user.email.length<=320 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(user.email)?user.email:null;
      const emailConfirmed=email!==null && typeof user.email_confirmed_at==='string' && Number.isFinite(Date.parse(user.email_confirmed_at));
      return {id:user.id,profile:owned,email,emailConfirmed};
    },
    async subscriptionFor(userId) {
      if(!uuid.test(userId || ''))fail();
      const result=await rows(`cafe_subscriptions?user_id=eq.${userId}&select=${subscriptionFields}&limit=2`);
      if(!result[0] || result[0].user_id!==userId)fail();
      return result[0];
    },
    async adminRows(path,options={}) {
      if(typeof path!=='string')fail();
      if(path.startsWith('profiles?')) {
        const matched=/^profiles\?id=eq\.([0-9a-f-]+)&select=id,role,suspended_at&limit=1$/i.exec(path);
        if(!matched || !uuid.test(matched[1]) || Object.keys(options).length)fail();
        const row=await profile(matched[1]);
        return row?[row]:[];
      }
      const name=path.startsWith('rpc/')?path.slice(4):'';
      if(!rpcNames.has(name) || options.method!=='POST' || typeof options.body!=='string'
        || Object.keys(options).some(key=>!['method','body'].includes(key)) || Buffer.byteLength(options.body)>131072)fail();
      let body;try{body=JSON.parse(options.body);}catch{fail();}
      if(!body || typeof body!=='object' || Array.isArray(body))fail();
      if(body.p_environment!==undefined && body.p_environment!=='Production')fail();
      if(body.p_provider!==undefined && body.p_provider!=='google')fail();
      const exact=keys=>Object.keys(body).length===keys.length && keys.every(key=>Object.hasOwn(body,key));
      if(['native_checkout_claim','native_checkout_provider','native_checkout_start'].includes(name)) {
        const keys=['p_user_id','p_environment','p_attempt_id',...(name==='native_checkout_claim'?['p_provider']:[])];
        if(!exact(keys) || !uuid.test(body.p_user_id || '') || !uuid.test(body.p_attempt_id || '')
          || body.p_environment!=='Production' || name==='native_checkout_claim' && body.p_provider!=='google')fail();
      }
      if(name==='android_google_checkout_cancel' && (!exact(['p_user_id','p_attempt_id','p_before_launch'])
        || !uuid.test(body.p_user_id || '') || !uuid.test(body.p_attempt_id || '') || typeof body.p_before_launch!=='boolean'))fail();
      if(name==='android_google_checkout_settle_verified' && (!exact(['p_user_id']) || !uuid.test(body.p_user_id || '')))fail();
      const result=await request(`/rest/v1/rpc/${name}`,{method:'POST',body});
      // The legacy repository maps falsey owner results to absence. Only an
      // actual JSON null is authoritative absence; malformed data must retry.
      if(name==='native_billing_owner' && !(result===null || typeof result==='string' && uuid.test(result)))fail();
      return result;
    },
  });
}
