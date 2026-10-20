import {androidPublicBillingIdentity,assertAndroidPublicBillingIdentity,readAndroidPublicBillingConfiguration} from './configuration.mjs';

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const account=user=>({id:user.id,role:user.profile.role,suspendedAt:user.profile.suspended_at,
  email:user.email ?? null,emailConfirmed:user.emailConfirmed===true});
const freezeBody=value=>{if(value && typeof value==='object'){for(const child of Object.values(value))freezeBody(child);Object.freeze(value);}return value;};
const bodyOf=(value,limit)=>{
  if(Buffer.isBuffer(value))value=value.toString('utf8');
  if(typeof value==='string') {if(Buffer.byteLength(value)>limit)throw new Error();value=JSON.parse(value);}
  if(!value || typeof value!=='object' || Array.isArray(value))throw new Error();
  const serialized=JSON.stringify(value);
  if(Buffer.byteLength(serialized)>limit)throw new Error();
  const captured=JSON.parse(serialized);
  if(!captured || typeof captured!=='object' || Array.isArray(captured))throw new Error();
  return freezeBody(captured);
};
const exactKeys=(body,keys)=>Object.keys(body).every(key=>keys.includes(key));
const selection=body=>body.provider==='google' && body.productId===androidPublicBillingIdentity.productId
  && body.basePlanId===androidPublicBillingIdentity.basePlanId && body.storefront==='US';

/** A maintenance boundary, separate from the new-sales switches. All injected
 * operations must be lazy Google-only adapters: never supply a general Apple/
 * Stripe service. A future start adapter must preserve trusted provider and
 * atomic lease checks; an incoming provider never selects a reservation.
 * Cancel uses only the authoritative owned Google-only composition.
 * verifyDeploymentIdentity must verify the CURRENT signed platform context,
 * not request headers or decoded claims. Event adapter must verify Pub/Sub OIDC
 * before ledger access. No callback or dependency is constructed while off. */
export function androidPublicGoogleBillingHandler({route,env=process.env,verifyDeploymentIdentity,authenticateCafe,
  status,prepareGoogleCheckout,startGoogleCheckout,cancelGoogleCheckout,verifyGooglePurchase,handleGoogleEvent,newCheckoutReady=false,now=Date.now}={}) {
  return async(req,res)=>{
    res.setHeader('Cache-Control','no-store');
    res.setHeader('X-Content-Type-Options','nosniff');
    const unavailable=()=>res.status(503).json({error:'Android subscription services are temporarily unavailable.'});
    try {
      // Before parsing, account authentication, status settlement or any lazy
      // factory. A disabled route is not a read-only alias of the old handler.
      if(env.ANDROID_GOOGLE_BILLING_ACTIVE!=='true')return unavailable();
      const action=req.query?.action || (route==='billing'?'status':'verify');
      const events=route==='purchases' && action==='google-events';
      if(route==='purchases' && ['verify','google-events'].includes(action) && env.ANDROID_GOOGLE_RECEIPTS_ACTIVE!=='true')return unavailable();
      if(route==='billing' && ['prepare','start','cancel'].includes(action) && env.ANDROID_GOOGLE_RECEIPTS_ACTIVE!=='true')return unavailable();
      if(events && env.ANDROID_GOOGLE_EVENTS_ACTIVE!=='true')return unavailable();
      const config=readAndroidPublicBillingConfiguration(env,req.headers?.host,{events});
      if(!config)return unavailable();
      if(!['billing','purchases'].includes(route) || Object.keys(req.query || {}).some(key=>key!=='action')
        || typeof action!=='string' || !(route==='billing'?['status','prepare','start','cancel'].includes(action):['verify','google-events'].includes(action))) {
        return res.status(404).json({error:'Billing route not found.'});
      }
      const method=action==='status'?'GET':'POST';
      if(req.method!==method){res.setHeader('Allow',method);return res.status(405).json({error:'Method not allowed.'});}
      // Exact scope/config and full remote Stripe inspection are required by
      // the concrete checkout composition; sales flags alone are insufficient.
      if(['prepare','start'].includes(action) && (!config.newSalesEnabled || newCheckoutReady!==true))return res.status(409).json({error:'New subscriptions are not available yet.'});
      let body;
      if(action!=='status') {
        try {body=bodyOf(req.body,events?262144:action==='verify'?65536:4096);}
        catch {return res.status(400).json({error:'Purchase request is invalid.'});}
        const valid=events? exactKeys(body,['message','subscription']) && body.message && typeof body.message==='object' && !Array.isArray(body.message)
          : action==='verify'? exactKeys(body,['provider','proof']) && body.provider==='google' && typeof body.proof==='string' && body.proof.length>0 && body.proof.length<=32768
          : action==='cancel'? exactKeys(body,['attemptId','reason']) && uuid.test(body.attemptId || '') && body.reason==='user-cancelled'
          : exactKeys(body,action==='start'?['provider','productId','basePlanId','storefront','attemptId']:['provider','productId','basePlanId','storefront'])
            && selection(body) && (action!=='start' || uuid.test(body.attemptId || ''));
        if(!valid)return res.status(400).json({error:'Purchase request is invalid.'});
      }
      // No verified identity default/fallback: missing composition fails closed.
      assertAndroidPublicBillingIdentity(await verifyDeploymentIdentity(),now());
      if(events) {
        await handleGoogleEvent({authorization:req.headers?.authorization,body,configuration:config});
        return res.status(200).json({received:true});
      }
      const user=await authenticateCafe(req,config);
      if(!user)return res.status(401).json({error:'Please log in with your café account.'});
      if(!uuid.test(user.id || '') || user.profile?.id!==user.id || user.profile.role!=='cafe_owner_manager' || user.profile.suspended_at!=null) {
        return res.status(403).json({error:'This account cannot manage café purchases.'});
      }
      const options={account:account(user),configuration:config};
      const result=action==='status'? await status(options)
        : action==='prepare'? await prepareGoogleCheckout({...options,selection:body})
        : action==='start'? await startGoogleCheckout({...options,selection:body,attemptId:body.attemptId})
        : action==='cancel'? await cancelGoogleCheckout({...options,attemptId:body.attemptId,reason:body.reason})
        : await verifyGooglePurchase({...options,proof:body.proof});
      return res.status(200).json(result);
    } catch(error) {
      if(error?.code==='WEBSITE_BILLING_EXISTS')return res.status(409).json({error:'Your website billing needs attention. Manage it on the website before purchasing here.'});
      if(['CHECKOUT_BLOCKED','INVALID_CANCELLATION','NOT_ENABLED'].includes(error?.code))return res.status(409).json({error:'Another purchase or billing update is in progress. Check your subscription status before trying again.'});
      return unavailable();
    }
  };
}
