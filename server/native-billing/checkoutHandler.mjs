const account=user=>({id:user.id,role:user.profile.role,suspendedAt:user.profile.suspended_at});
export function checkoutHandler({authenticateCafe,serviceFor,websiteStatus}) {
  return async(req,res)=>{
    res.setHeader('Cache-Control','no-store');
    try {
      const action=req.query?.action || 'status';
      if(!['status','prepare','start','cancel'].includes(action))return res.status(404).json({error:'Billing route not found.'});
      const method=action==='status'?'GET':'POST';
      if(req.method!==method){res.setHeader('Allow',method);return res.status(405).json({error:'Method not allowed.'});}
      const user=await authenticateCafe(req);
      if(!user)return res.status(401).json({error:'Please log in with your café account.'});
      if(user.profile.role!=='cafe_owner_manager'||user.profile.suspended_at)return res.status(403).json({error:'This account cannot manage café purchases.'});
      const service=await serviceFor();
      if(action==='status')return res.status(200).json(await service.status(account(user),await websiteStatus(req)));
      let body=req.body;
      if(Buffer.isBuffer(body))body=body.toString('utf8');
      if(typeof body==='string'){if(Buffer.byteLength(body)>4096)return res.status(413).json({error:'Purchase request is too large.'});try{body=JSON.parse(body);}catch{return res.status(400).json({error:'Purchase request is invalid.'});}}
      if(!body || typeof body!=='object' || Array.isArray(body) || Buffer.byteLength(JSON.stringify(body))>4096)return res.status(400).json({error:'Purchase request is invalid.'});
      const result=action==='prepare'?await service.prepare(account(user),body)
        :action==='start'?await service.start(account(user),body.attemptId)
        :await service.cancel(account(user),body.attemptId,body.reason);
      return res.status(200).json(result);
    }catch(error){
      const message={CHECKOUT_BLOCKED:'Another purchase or billing update is in progress. Check your subscription status before trying again.',WEBSITE_BILLING_EXISTS:'Your website subscription or checkout needs attention. Finish or cancel that checkout before purchasing here.',PRODUCT_UNAVAILABLE:'New subscriptions are available only in the United States.',NOT_ENABLED:'In-app purchasing is not available yet.',INVALID_CANCELLATION:'This purchase could not be marked as canceled. Check its status before trying again.'}[error?.code];
      return res.status(message?409:503).json({error:message || 'Subscription services are temporarily unavailable. Please try again. If checkout already opened, check its status before purchasing again.'});
    }
  };
}
