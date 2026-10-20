import {randomUUID} from 'node:crypto';
import {AndroidPushError,androidPushIdentity,readAndroidPushConfiguration} from './configuration.mjs';
import {createAndroidFcmAuthClient} from './googleFcmAuth.mjs';

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const clean=(value,max)=>String(value??'').trim().slice(0,max);
export const validFcmToken=value=>typeof value==='string' && Buffer.byteLength(value,'utf8')>=1
  && Buffer.byteLength(value,'utf8')<=2048 && !/[\s\p{Cc}]/u.test(value);

export function androidNotificationData(data,recipientUserId) {
  if(!uuid.test(recipientUserId))throw new AndroidPushError('PAYLOAD');
  const route=data?.route,type=data?.type;
  if(!['match','interest','message','job'].includes(type))throw new AndroidPushError('PAYLOAD');
  const safeRoute=['/discover','/matches'].includes(route) || (typeof route==='string'
    && /^\/chat\/[^/?#]+\?kind=(application|discovery)$/.test(route) && uuid.test(route.split('/chat/')[1].split('?')[0]));
  if(!safeRoute || (type==='job' && !uuid.test(data.jobId)))throw new AndroidPushError('PAYLOAD');
  return {route,type,...(type==='job'?{jobId:data.jobId}:{}),recipientUserId};
}

export function androidFcmMessage(row,notification) {
  const data=androidNotificationData(notification.data,row.user_id);
  // Expo SDK 54's Android NotificationData maps this JSON string to content.data.
  // All FCM data values are strings. No private message text survives in-flight
  // OS notifications after logout; the app loads it only after session checks.
  const isMessage=data.type==='message';
  return {message:{token:row.fcm_token,
    notification:{title:isMessage?'New message':clean(notification.title,100),
      body:isMessage?'Open BaristaMatch to read it.':clean(notification.body,240)},
    data:{body:JSON.stringify(data)},
    android:{restricted_package_name:androidPushIdentity.packageName,priority:'HIGH',ttl:'300s',
      // Firebase-auto background notifications omit custom data from tray
      // extras. A unique recipient tag preserves account-scoped dismissal.
      notification:{channel_id:'baristamatch-alerts',sound:'default',visibility:'PRIVATE',
        tag:`bjm-v1:${data.recipientUserId.toLowerCase()}:${randomUUID()}`}},
  }};
}

/** Returns provider acceptance counts, never a claim of device delivery. No
 * automatic send retries: an uncertain network response may already be accepted.
 * The existing event log is claimed before delivery; durable retries are separate. */
export async function sendAndroidPushToUsers(userIds,notification,{
  env=process.env,fetchImpl=globalThis.fetch,createAuth=createAndroidFcmAuthClient,
}={}) {
  if(env.ANDROID_DIRECT_FCM_ENABLED===undefined || env.ANDROID_DIRECT_FCM_ENABLED==='false')
    return {sent:0,accepted:0,failed:0,disabled:true};
  const config=readAndroidPushConfiguration(env),id=androidPushIdentity;
  if(!Array.isArray(userIds) || userIds.length>500 || userIds.some(value=>typeof value!=='string'||!uuid.test(value)))
    throw new AndroidPushError('RECIPIENTS');
  const users=[...new Set(userIds.map(value=>value.toLowerCase()))];
  if(!users.length)return {sent:0,accepted:0,failed:0};
  // Validate routing before any provider or database work.
  androidNotificationData(notification?.data,users[0]);
  const deadline=AbortSignal.timeout(25_000);
  async function rest(query,options={}) {
    try {
      const response=await fetchImpl(`${id.supabaseUrl}/rest/v1/android_device_push_tokens?${query}`,{
        ...options,redirect:'error',signal:AbortSignal.any([deadline,AbortSignal.timeout(10_000)]),
        headers:{apikey:env.SUPABASE_SECRET_KEY,'Content-Type':'application/json',...(options.headers||{})},
      });
      if(!response.ok)throw new Error();
      return options.method==='PATCH'?null:await response.json();
    } catch {throw new AndroidPushError('DATABASE_UNAVAILABLE');}
  }
  const pins=`enabled=eq.true&platform=eq.android&firebase_project_id=eq.${id.firebaseProjectId}&package_name=eq.${id.packageName}`;
  const rows=await rest(`user_id=in.(${users.map(encodeURIComponent).join(',')})&${pins}&select=fcm_token,user_id,updated_at&limit=101`);
  if(!Array.isArray(rows)||rows.length>100)throw new AndroidPushError('RECIPIENT_LIMIT');
  if(rows.some(row=>!users.includes(row.user_id)||!validFcmToken(row.fcm_token)
    ||typeof row.updated_at!=='string'||!Number.isFinite(Date.parse(row.updated_at))))throw new AndroidPushError('REGISTRATION');
  if(!rows.length)return {sent:0,accepted:0,failed:0};
  let auth;
  try {
    auth=await createAuth(config);
    // Complete federation before the ownership recheck, narrowing the gap
    // between that final database read and the delivery request. Never expose
    // the returned short-lived access token.
    await auth.getAccessToken();
  } catch {throw new AndroidPushError('CONFIGURATION');}
  const result={sent:0,accepted:0,failed:0,invalid:0,skipped:0,cleanupFailed:0};
  let cursor=0;
  async function worker() {
    while(cursor<rows.length) {
      const row=rows[cursor++];
      if(deadline.aborted){result.failed++;continue;}
      const exact=`fcm_token=eq.${encodeURIComponent(row.fcm_token)}&user_id=eq.${encodeURIComponent(row.user_id)}&updated_at=eq.${encodeURIComponent(row.updated_at)}`;
      try {
        // Narrow the race window; identity changes or disabled/replaced rows skip.
        const current=await rest(`${exact}&${pins}&select=fcm_token,user_id,updated_at&limit=1`);
        if(!Array.isArray(current)||current.length!==1||current[0].fcm_token!==row.fcm_token
          ||current[0].user_id!==row.user_id||current[0].updated_at!==row.updated_at){result.skipped++;continue;}
        const response=await auth.request({
          url:`https://fcm.googleapis.com/v1/projects/${id.firebaseProjectId}/messages:send`,method:'POST',
          data:androidFcmMessage(row,notification),timeout:10_000,retry:false,
          signal:deadline,maxRedirects:0,
        });
        if(response.status!==200 || typeof response.data?.name!=='string'
          || !/^projects\/baristamatch\/messages\/[^\s/]{1,256}$/.test(response.data.name)) {result.failed++;continue;}
        result.accepted++;result.sent++;
      } catch(error) {
        const details=error?.response?.data?.error?.details;
        const unregistered=error?.response?.status===404 && Array.isArray(details) && details.some(detail=>
          detail?.['@type']==='type.googleapis.com/google.firebase.fcm.v1.FcmError' && detail.errorCode==='UNREGISTERED');
        if(unregistered) {
          result.invalid++;
          try {await rest(`${exact}&${pins}`,{method:'PATCH',body:JSON.stringify({enabled:false,updated_at:new Date().toISOString()})});}
          catch {result.cleanupFailed++;}
        } else result.failed++;
        // Never log provider errors: they can contain registration/OAuth tokens,
        // private payloads and SDK request objects. Counts are sufficient here.
      }
    }
  }
  await Promise.all(Array.from({length:Math.min(4,rows.length)},worker));
  return result;
}
