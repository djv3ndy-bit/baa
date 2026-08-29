const clean=(value,max=500)=>String(value??'').trim().slice(0,max);

function adminHeaders(extra={}){
  const key=process.env.SUPABASE_SECRET_KEY;
  const headers={apikey:key,'Content-Type':'application/json',...extra};
  if(key&&!key.startsWith('sb_secret_'))headers.Authorization=`Bearer ${key}`;
  return headers;
}

async function adminRest(path,options={}){
  return fetch(`${process.env.SUPABASE_URL}${path}`,{...options,headers:{...adminHeaders(),...(options.headers||{})}});
}

export async function getAuthenticatedUser(req){
  const token=String(req.headers.authorization||'').replace(/^Bearer\s+/i,'');
  if(!token)return null;
  const response=await fetch(`${process.env.SUPABASE_URL}/auth/v1/user`,{headers:{apikey:process.env.SUPABASE_PUBLISHABLE_KEY,Authorization:`Bearer ${token}`}});
  return response.ok?response.json():null;
}

export async function getRows(path){
  const response=await adminRest(`/rest/v1/${path}`);
  if(!response.ok)throw new Error(`Database request failed (${response.status})`);
  return response.json();
}

export async function claimPushEvent(eventKey){
  const response=await adminRest('/rest/v1/push_event_log?on_conflict=event_key',{method:'POST',headers:{Prefer:'resolution=ignore-duplicates,return=representation'},body:JSON.stringify({event_key:clean(eventKey,240)})});
  if(!response.ok)throw new Error(`Notification deduplication failed (${response.status})`);
  return (await response.json()).length>0;
}

async function disableInvalidTokens(tokens){
  if(!tokens.length)return;
  await Promise.all(tokens.map(token=>adminRest(`/rest/v1/device_push_tokens?expo_push_token=eq.${encodeURIComponent(token)}`,{method:'PATCH',body:JSON.stringify({enabled:false,updated_at:new Date().toISOString()})})));
}

export async function sendPushToUsers(userIds,notification){
  const uniqueUsers=[...new Set(userIds.filter(Boolean))];
  if(!uniqueUsers.length)return {sent:0};
  const encoded=uniqueUsers.map(id=>encodeURIComponent(id)).join(',');
  const rows=await getRows(`device_push_tokens?user_id=in.(${encoded})&enabled=eq.true&select=expo_push_token,user_id`);
  const tokens=[...new Set(rows.map(row=>row.expo_push_token).filter(token=>/^Expo(nent)?PushToken\[[A-Za-z0-9_-]+\]$/.test(token)))];
  if(!tokens.length)return {sent:0};
  const messages=tokens.map(to=>({to,sound:'default',title:clean(notification.title,100),body:clean(notification.body,240),data:notification.data||{},channelId:'baristamatch-alerts'}));
  const invalid=[];
  for(let index=0;index<messages.length;index+=100){
    const batch=messages.slice(index,index+100);
    const response=await fetch('https://exp.host/--/api/v2/push/send',{method:'POST',headers:{Accept:'application/json','Content-Type':'application/json'},body:JSON.stringify(batch)});
    if(!response.ok)throw new Error(`Expo Push Service failed (${response.status})`);
    const payload=await response.json();
    (payload.data||[]).forEach((ticket,i)=>{if(ticket?.details?.error==='DeviceNotRegistered')invalid.push(batch[i].to)});
  }
  try{await disableInvalidTokens(invalid)}catch(error){console.error('Could not disable invalid push tokens',error?.message||error)}
  return {sent:tokens.length-invalid.length};
}

export async function profileName(userId){
  const rows=await getRows(`profiles?id=eq.${encodeURIComponent(userId)}&select=display_name,cafe_name&limit=1`);
  return rows[0]?.cafe_name||rows[0]?.display_name||'Someone';
}

export function locationMatches(job,profile){
  const value=v=>clean(v,120).toLowerCase();
  const jobState=value(job.state),jobCity=value(job.city),jobZip=value(job.postal_code);
  const profileState=value(profile.preferred_state),profileCity=value(profile.preferred_city),profileZip=value(profile.preferred_postal_code);
  if(profileState&&jobState&&profileState!==jobState)return false;
  if(profileZip&&jobZip)return profileZip===jobZip;
  if(profileCity&&jobCity)return profileCity===jobCity;
  return Boolean(jobState&&profileState===jobState);
}
