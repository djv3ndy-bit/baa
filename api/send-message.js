import {profileName,sendPushToUsers} from './_push.js';
import { conversationForUser } from './_application-conversation.js';

const clean=(v,max=5000)=>String(v??'').trim().slice(0,max);
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const request=(url,options={})=>fetch(url,{...options,signal:AbortSignal.timeout(10000)});
const esc=v=>String(v??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#039;');
function adminHeaders(extra={}){const key=process.env.SUPABASE_SECRET_KEY;const h={apikey:key,'Content-Type':'application/json',...extra};if(key&&!key.startsWith('sb_secret_'))h.Authorization=`Bearer ${key}`;return h}
async function currentUser(req){const token=String(req.headers.authorization||'').replace(/^Bearer\s+/i,'');if(!token)return null;const r=await request(`${process.env.SUPABASE_URL}/auth/v1/user`,{headers:{apikey:process.env.SUPABASE_PUBLISHABLE_KEY,Authorization:`Bearer ${token}`}});if(r.status>=500)throw new Error('Authentication unavailable');return r.ok?await r.json():null}
async function rest(path,options={}){return request(`${process.env.SUPABASE_URL}${path}`,{...options,headers:{...adminHeaders(),...(options.headers||{})}})}
async function userRest(path,token,options={}){return request(`${process.env.SUPABASE_URL}${path}`,{...options,headers:{apikey:process.env.SUPABASE_PUBLISHABLE_KEY,Authorization:`Bearer ${token}`,'Content-Type':'application/json',...(options.headers||{})}})}
async function emailFor(id){const r=await request(`${process.env.SUPABASE_URL}/auth/v1/admin/users/${encodeURIComponent(id)}`,{headers:adminHeaders()});if(!r.ok)return null;return (await r.json())?.email||null}
async function sendEmail(to,subject,html){if(!to||!process.env.RESEND_API_KEY)return false;const r=await request('https://api.resend.com/emails',{method:'POST',headers:{Authorization:`Bearer ${process.env.RESEND_API_KEY}`,'Content-Type':'application/json'},body:JSON.stringify({from:'BaristaMatch <updates@updates.baristajobmatch.com>',to:[to],reply_to:'hello@baristajobmatch.com',subject,html})});return r.ok}
async function sendMessage(req,res){
  res.setHeader('Cache-Control','no-store');if(req.method!=='POST')return res.status(405).json({error:'Method not allowed'});
  if(!process.env.SUPABASE_URL||!process.env.SUPABASE_PUBLISHABLE_KEY)return res.status(503).json({error:'Messaging is temporarily unavailable.'});
  const token=String(req.headers.authorization||'').replace(/^Bearer\s+/i,'');const user=await currentUser(req);if(!user?.id)return res.status(401).json({error:'Please log in again.'});
  const applicationId=clean(req.body?.application_id,80),body=clean(req.body?.body,2000);if(!applicationId||!body)return res.status(400).json({error:'Message is required.'});
  const requestId=req.body?.client_message_id;
  if(requestId!==undefined&&(typeof requestId!=='string'||!UUID.test(requestId)))return res.status(400).json({error:'Invalid message request. Please reopen this conversation.'});
  const app=await conversationForUser(applicationId,user.id,token);
  if(!app)return res.status(403).json({error:'This conversation is not available.'});
  const ir=await userRest('/rest/v1/messages',token,{method:'POST',headers:{Prefer:'return=representation'},body:JSON.stringify({...(requestId?{id:requestId}:{}),application_id:applicationId,sender_id:user.id,body})});
  if(!ir.ok){
    const failure=await ir.json().catch(()=>({}));
    // The caller retains its ID after an uncertain network response. Read back
    // only an identical message under the caller's RLS before acknowledging it.
    if(requestId&&ir.status===409&&failure.code==='23505'){
      const previous=await userRest(`/rest/v1/messages?id=eq.${encodeURIComponent(requestId)}&application_id=eq.${encodeURIComponent(applicationId)}&sender_id=eq.${encodeURIComponent(user.id)}&select=id,application_id,sender_id,body,created_at,read_at&limit=1`,token);
      const rows=previous.ok?await previous.json():[];
      if(Array.isArray(rows)&&rows.length===1&&rows[0].body===body)return res.status(200).json({success:true,message:rows[0],replayed:true,email_sent:false,push_sent:0});
      return res.status(409).json({error:'This message request has changed. Please review your draft.'});
    }
    console.error('Message insert failed',ir.status,failure.code);
    return res.status(500).json({error:'Message could not be sent.'});
  }
  const message=(await ir.json())[0];
  const recipientId=user.id===app.barista_id?app.job.owner_id:app.barista_id;let emailSent=false;
  try{const [pr,sr]=await Promise.all([rest(`/rest/v1/notification_preferences?user_id=eq.${encodeURIComponent(recipientId)}&select=email_messages&limit=1`),rest(`/rest/v1/profiles?id=eq.${encodeURIComponent(user.id)}&select=display_name,cafe_name&limit=1`)]);const prefs=pr.ok?(await pr.json())[0]:null;const sender=sr.ok?(await sr.json())[0]:null;if(prefs?.email_messages!==false){const to=await emailFor(recipientId);const senderName=sender?.display_name||sender?.cafe_name||'Your match';emailSent=await sendEmail(to,`New BaristaMatch message from ${senderName}`,`<div style="max-width:560px;margin:auto;padding:28px;font-family:Arial,sans-serif;color:#321708;background:#fbf7f1;border-radius:18px"><h2>New message from ${esc(senderName)}</h2><p style="color:#746a61">About ${esc(app.job?.title||'your match')}</p><div style="background:white;border:1px solid #e7ddd2;border-radius:12px;padding:16px;line-height:1.55">${esc(body)}</div><p><a href="https://www.baristajobmatch.com/dashboard.html" style="color:#a95820;font-weight:700">Open BaristaMatch Messages</a></p></div>`)} }catch(e){console.error('Message email notification failed',e?.message||e)}
  let pushSent=0;try{const senderName=await profileName(user.id);pushSent=(await sendPushToUsers([recipientId],{title:`New message from ${senderName}`,body,data:{route:`/chat/${applicationId}?kind=application`,type:'message'}})).sent}catch(e){console.error('Message push notification failed',e?.message||e)}
  return res.status(200).json({success:true,message,email_sent:emailSent,push_sent:pushSent});
}

export default async function handler(req,res){
  try{return await sendMessage(req,res)}catch(error){
    console.error('Messaging request failed',error?.name||'Error');
    return res.status(error?.name==='TimeoutError'?504:502).json({error:'Messaging is temporarily unavailable. Check your connection and try again.'});
  }
}
