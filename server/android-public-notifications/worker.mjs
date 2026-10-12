import {timingSafeEqual} from 'node:crypto';
import {readPublicPushConfiguration,publicPushIdentity,PublicPushError} from './configuration.mjs';
import {createPublicFcmAuth} from './googleFcmAuth.mjs';
import {verifiedAndroidDeploymentIdentity} from '../android-public-billing/deploymentIdentity.mjs';

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const validToken=t=>typeof t==='string'&&Buffer.byteLength(t)>0&&Buffer.byteLength(t)<=2048&&!/[\s\p{Cc}]/u.test(t);
export function publicFcmMessage(row) {
  if(!row||!uuid.test(row.recipient_id)||!validToken(row.fcm_token)||!uuid.test(row.source_id))throw new PublicPushError('PAYLOAD');
  const route=row.route,type=row.notification_type;
  if(!((type==='application'&&route==='/candidates')||(type==='match'&&route==='/matches')
    ||(type==='message'&&typeof route==='string'&&/^\/chat\/[0-9a-f-]{36}\?kind=(application|discovery)$/.test(route)
      &&uuid.test(route.slice(6).split('?')[0]))))throw new PublicPushError('PAYLOAD');
  const title=type==='message'?'New message':type==='match'?'New match':'New application';
  return {message:{token:row.fcm_token,notification:{title,body:type==='message'?'Open BaristaMatch to read it.':'Open BaristaMatch to view it.'},
    data:{body:JSON.stringify({route,type,recipientUserId:row.recipient_id,eventId:row.source_id})},
    android:{restricted_package_name:publicPushIdentity.packageName,priority:'HIGH',ttl:'300s',
      notification:{channel_id:'baristamatch-alerts',sound:'default',visibility:'PRIVATE'}}}};
}
export function createPushQueueTransport(config,{fetchImpl=globalThis.fetch,signal}={}) {
  const names=new Set(['android_public_push_poll','android_public_push_claim','android_public_push_revalidate','android_public_push_finish']);
  return async (name,body)=>{
    if(!names.has(name))throw new PublicPushError('DATABASE');
    try {
      const response=await fetchImpl(`${publicPushIdentity.supabaseUrl}/rest/v1/rpc/${name}`,{method:'POST',redirect:'error',
        signal:signal?AbortSignal.any([signal,AbortSignal.timeout(8000)]):AbortSignal.timeout(8000),
        headers:{apikey:config.secretKey,'Content-Type':'application/json'},body:JSON.stringify(body)});
      if(!response.ok)throw new Error();
      const text=await response.text();if(Buffer.byteLength(text)>262144)throw new Error();
      return JSON.parse(text);
    } catch {throw new PublicPushError('DATABASE');}
  };
}
function resultFor(error) {
  const status=error?.response?.status,details=error?.response?.data?.error?.details;
  if(status===404&&Array.isArray(details)&&details.some(d=>d?.['@type']==='type.googleapis.com/google.firebase.fcm.v1.FcmError'&&d.errorCode==='UNREGISTERED'))return 'invalid';
  // Explicit retryable rejections and uncertain network outcomes retry through
  // the durable queue. An uncertain request may already have been accepted:
  // exactly-once delivery is not available from the FCM HTTP API.
  return status===400||status===401||status===403?'dead':'retry';
}
export function createPublicNotificationWorker({env=process.env,verifyIdentity=verifiedAndroidDeploymentIdentity,
  createAuth=createPublicFcmAuth,transport=createPushQueueTransport,now=Date.now}={}) {
  return async (req,res)=>{
    res.setHeader('Cache-Control','no-store');
    const reply=(status,body)=>res.status(status).json(body);
    if(req.method!=='GET'||Object.keys(req.query||{}).length||String(req.url||'').includes('?'))return reply(404,{error:'Not found.'});
    let config;
    try {config=readPublicPushConfiguration(env,req.headers?.host);}catch{return reply(503,{error:'Android notifications are temporarily unavailable.'});}
    if(!config)return reply(503,{error:'Android notifications are disabled.'});
    const expected=Buffer.from(`Bearer ${config.cronSecret}`),authorization=req.headers?.authorization;
    if(typeof authorization!=='string'||Buffer.byteLength(authorization)!==expected.length
      ||!timingSafeEqual(Buffer.from(authorization),expected))return reply(401,{error:'Unauthorized.'});
    try {
      await verifyIdentity();
      const deadline=AbortSignal.timeout(25000),started=now(),rpc=transport(config,{signal:deadline});
      const polled=await rpc('android_public_push_poll',{p_limit:200});
      if(polled?.ready!==true)return reply(200,{success:true,disabled:true});
      // One claim at a time keeps leases beyond the bounded request duration.
      // Every raw token is loaded only after federation and final source checks.
      const auth=await createAuth();await auth.getAccessToken();
      const counts={accepted:0,retried:0,skipped:0,dead:0,invalid:0};
      for(let i=0;i<20&&now()-started<17000&&!deadline.aborted;i++) {
        const lease=await rpc('android_public_push_claim',{});
        if(lease===null)break;
        if(!uuid.test(lease?.delivery_id)||!uuid.test(lease?.lease_id))throw new PublicPushError('DATABASE');
        const args={p_delivery_id:lease.delivery_id,p_lease_id:lease.lease_id};
        const row=await rpc('android_public_push_revalidate',args);
        let outcome='skipped';
        if(row!==null) {
          const payload=publicFcmMessage(row);
          try {
            const response=await auth.request({url:'https://fcm.googleapis.com/v1/projects/baristamatch/messages:send',method:'POST',
              data:payload,timeout:5000,retry:false,signal:deadline,maxRedirects:0});
            outcome=response.status===200&&typeof response.data?.name==='string'
              &&/^projects\/baristamatch\/messages\/[^\s/]{1,256}$/.test(response.data.name)?'accepted':'retry';
          } catch(error) {outcome=resultFor(error);}
        }
        const finished=await rpc('android_public_push_finish',{...args,p_outcome:outcome});
        if(finished!==true)throw new PublicPushError('LEASE');
        counts[outcome==='retry'?'retried':outcome]++;
      }
      return reply(200,{success:true,...counts});
    } catch {return reply(503,{error:'Android notifications are temporarily unavailable.'});}
  };
}
