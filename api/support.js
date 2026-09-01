import { randomBytes } from 'node:crypto';
import { triageSupportTicket, supportDraft } from './_support-agent.js';

function clean(value, max = 5000) { return String(value || '').trim().slice(0, max); }
function escapeHtml(value) { return String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#039;'); }
function makeTicketId() { const date=new Date().toISOString().slice(0,10).replaceAll('-',''); return `BM-${date}-${randomBytes(6).toString('hex').toUpperCase()}`; }
async function resend(payload) { const response=await fetch('https://api.resend.com/emails',{method:'POST',headers:{Authorization:`Bearer ${process.env.RESEND_API_KEY}`,'Content-Type':'application/json'},body:JSON.stringify(payload)}); let data={}; try{data=await response.json()}catch{} return {ok:response.ok,data}; }
async function resendWithRetry(payload, attempts = 3) { let result={ok:false,data:{}}; for(let i=0;i<attempts;i++){ result=await resend(payload); if(result.ok)return result; if(i<attempts-1)await new Promise(resolve=>setTimeout(resolve,350*(i+1))); } return result; }
function adminHeaders(extra={}) { const key=process.env.SUPABASE_SECRET_KEY; const headers={apikey:key,'Content-Type':'application/json',...extra}; if(key&&!key.startsWith('sb_secret_'))headers.Authorization=`Bearer ${key}`; return headers; }
function supportEmailHtml({name,ticket,subject}) { return `<!doctype html><html><body style="margin:0;background:#f4f0eb;font-family:Arial,sans-serif;color:#321708"><table width="100%" role="presentation"><tr><td align="center" style="padding:24px 12px"><table width="100%" role="presentation" style="max-width:560px;background:#fbf7f1;border-radius:18px"><tr><td style="padding:26px 24px"><div style="font-size:21px;font-weight:800">Barista<span style="color:#a95820">Match</span> <span style="font-size:14px;color:#746a61">Support</span></div><h1 style="font-size:25px;line-height:32px;margin:24px 0 10px">Thanks for contacting us${name&&name!=='there'?`, ${name}`:''}.</h1><p style="color:#55483f;font-size:15px;line-height:23px">We’ve received your request and our team will review it.</p><div style="background:#fff;border:1px solid #e7ddd2;border-radius:12px;padding:17px;margin:18px 0"><div style="font-size:12px;color:#8a7566;font-weight:800;text-transform:uppercase">Ticket #</div><div style="font-size:15px;font-weight:800;margin:5px 0 14px">${ticket}</div><div style="font-size:12px;color:#8a7566;font-weight:800;text-transform:uppercase">Issue</div><div style="font-size:15px;line-height:23px;margin-top:5px">${subject}</div></div><p style="font-size:14px;color:#746a61">— BaristaMatch Support</p></td></tr></table></td></tr></table></body></html>`; }

export default async function handler(req,res){
  const supabaseUrl=process.env.SUPABASE_URL,serviceKey=process.env.SUPABASE_SECRET_KEY;
  if(!supabaseUrl||!serviceKey)return res.status(503).json({error:'Support service is temporarily unavailable.'});
  if(req.method==='GET'){
    const ticket=clean(req.query?.ticket,40),email=clean(req.query?.email,320).toLowerCase();
    if(!ticket||!email)return res.status(400).json({error:'Ticket number and email are required.'});
    const response=await fetch(`${supabaseUrl}/rest/v1/support_tickets?ticket_id=eq.${encodeURIComponent(ticket)}&email=eq.${encodeURIComponent(email)}&select=ticket_id,status,subject,resolution_note,created_at,updated_at&limit=1`,{headers:adminHeaders()});
    if(!response.ok)return res.status(500).json({error:'Unable to check this ticket right now.'});
    const rows=await response.json(); if(!rows.length)return res.status(404).json({error:'Ticket not found.'}); return res.status(200).json(rows[0]);
  }
  if(req.method!=='POST'){res.setHeader('Allow','GET, POST');return res.status(405).json({error:'Method not allowed.'});}
  try{
    const body=req.body||{}; if(clean(body.website,200))return res.status(200).json({success:true});
    const name=clean(body.name,120),email=clean(body.email,320).toLowerCase(),issueType=clean(body.issue_type,60),subject=clean(body.subject,180),description=clean(body.description,5000),pageUrl=clean(body.page_url,1000),browserInfo=clean(body.browser_info,1000);
    if(!email||!email.includes('@')||!issueType||!subject||description.length<10)return res.status(400).json({error:'Please complete all required fields.'});
    if(!new Set(['bug','account','barista','cafe','billing','feedback','question','other']).has(issueType))return res.status(400).json({error:'Please choose a valid issue type.'});
    const ticketId=makeTicketId();
    const ticket={ticket_id:ticketId,email,name:name||null,issue_type:issueType,subject,description,page_url:pageUrl||null,browser_info:browserInfo||null,status:'new'};
    const triage=triageSupportTicket(ticket);
    const draft=supportDraft(ticket,triage);
    const dbResponse=await fetch(`${supabaseUrl}/rest/v1/support_tickets`,{method:'POST',headers:adminHeaders({Prefer:'return=representation'}),body:JSON.stringify(ticket)});
    if(!dbResponse.ok){console.error('Support insert error:',await dbResponse.text());return res.status(500).json({error:'We could not create your support ticket. Please try again.'});}
    const safeName=escapeHtml(name||'there'),safeTicket=escapeHtml(ticketId),safeSubject=escapeHtml(subject),safeDescription=escapeHtml(description).replaceAll('\n','<br>'),safeType=escapeHtml(issueType),safePage=escapeHtml(pageUrl||'Not provided');
    const userEmail=await resendWithRetry({from:'BaristaMatch Support <updates@updates.baristajobmatch.com>',to:[email],reply_to:'hello@baristajobmatch.com',subject:`We received your support request — ${ticketId}`,html:supportEmailHtml({name:safeName,ticket:safeTicket,subject:safeSubject})},3);
    const internalEmail=await resend({from:'BaristaMatch Support <updates@updates.baristajobmatch.com>',to:['hello@baristajobmatch.com'],reply_to:email,subject:`[${triage.priority}] ${issueType==='bug'?'🐞 Bug':'Support'} — ${ticketId}`,html:`<div style="max-width:650px;margin:0 auto;padding:24px;font-family:Arial,sans-serif;font-size:15px;line-height:1.6;color:#2b1a10"><h2>New BaristaMatch Support Ticket</h2><p><strong>Ticket:</strong> ${safeTicket}</p><p><strong>Type:</strong> ${safeType}</p><p><strong>AI category:</strong> ${escapeHtml(triage.category)}</p><p><strong>Priority:</strong> ${escapeHtml(triage.priority)}</p><p><strong>Route:</strong> ${escapeHtml(triage.route)}</p><p><strong>Owner approval:</strong> ${triage.approval_required?'Required':'Not currently required'}</p><p><strong>Reason:</strong> ${escapeHtml(triage.reason)}</p><p><strong>From:</strong> ${escapeHtml(email)}</p><p><strong>Subject:</strong> ${safeSubject}</p><p><strong>Description:</strong><br>${safeDescription}</p><p><strong>Page:</strong> ${safePage}</p><hr><p><strong>Suggested reply — NOT SENT:</strong></p><pre style="white-space:pre-wrap;font-family:Arial,sans-serif">${escapeHtml(draft)}</pre></div>`});
    if(!userEmail.ok)console.error('Support confirmation email failed:',userEmail.data); if(!internalEmail.ok)console.error('Support internal email failed:',internalEmail.data);
    return res.status(200).json({success:true,ticket_id:ticketId,confirmation_sent:userEmail.ok,triage:{priority:triage.priority,route:triage.route}});
  }catch(error){console.error('Support API error:',error);return res.status(500).json({error:'Something went wrong. Please try again.'});}
}
