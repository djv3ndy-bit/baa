import { randomBytes } from 'node:crypto';
import { triageSupportTicket, supportDraft } from './_support-agent.js';
import { adminHeaders, boundedFetch, consumePublicFormBudget, formBody, formEmail, formFailure, formText, PublicFormError, requestSignal, sendFormEmail } from './_public-form-guard.js';

function escapeHtml(value) {
  return String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#039;');
}
function makeTicketId() {
  const date=new Date().toISOString().slice(0,10).replaceAll('-','');
  return `BM-${date}-${randomBytes(6).toString('hex').toUpperCase()}`;
}
function supportEmailHtml({name,ticket,subject}) {
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light only"></head>
<body style="margin:0;padding:0;background:#f4f0eb;-webkit-text-size-adjust:100%;text-size-adjust:100%;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;background:#f4f0eb;"><tr><td align="center" style="padding:20px 12px;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;max-width:560px;background:#fbf7f1;border-radius:18px;overflow:hidden;">
<tr><td style="padding:24px 22px 10px;font-family:Arial,sans-serif;color:#321708;"><div style="font-size:21px;line-height:27px;font-weight:800;">Barista<span style="color:#a95820;">Match</span> <span style="font-size:14px;color:#746a61;font-weight:700;">Support</span></div></td></tr>
<tr><td style="padding:10px 22px 26px;font-family:Arial,sans-serif;color:#321708;">
<h1 style="margin:0 0 12px;font-family:Arial,sans-serif;font-size:24px;line-height:31px;font-weight:800;color:#321708;">Thanks for contacting us${name&&name!=='there'?`, ${name}`:''}.</h1>
<p style="margin:0 0 20px;font-size:15px;line-height:23px;color:#55483f;">We’ve received your request and our team will review it.</p>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;background:#fff;border:1px solid #e7ddd2;border-radius:12px;"><tr><td style="padding:17px 18px;font-family:Arial,sans-serif;color:#321708;">
<div style="font-size:11px;line-height:16px;text-transform:uppercase;letter-spacing:1px;font-weight:800;color:#8a7566;margin-bottom:4px;">Ticket #</div>
<div style="font-family:Arial,sans-serif;font-size:14px;line-height:20px;font-weight:800;white-space:nowrap;color:#321708;margin-bottom:15px;">${ticket}</div>
<div style="font-size:11px;line-height:16px;text-transform:uppercase;letter-spacing:1px;font-weight:800;color:#8a7566;margin-bottom:4px;">Status</div>
<div style="font-size:14px;line-height:20px;font-weight:700;color:#287443;margin-bottom:15px;">● Received</div>
<div style="font-size:11px;line-height:16px;text-transform:uppercase;letter-spacing:1px;font-weight:800;color:#8a7566;margin-bottom:4px;">Issue</div>
<div style="font-size:14px;line-height:21px;color:#321708;word-break:break-word;">${subject}</div>
</td></tr></table>
<p style="margin:20px 0 0;font-size:15px;line-height:23px;color:#55483f;">Keep this ticket number for reference. We’ll email you when your request is updated.</p>
<p style="margin:22px 0 0;font-size:14px;line-height:21px;color:#746a61;">— BaristaMatch Support</p>
</td></tr><tr><td style="padding:15px 22px;border-top:1px solid #e7ddd2;font-family:Arial,sans-serif;font-size:11px;line-height:17px;color:#92857b;">baristajobmatch.com</td></tr>
</table></td></tr></table></body></html>`;
}
export default async function handler(req,res){
  res.setHeader('Cache-Control','private, no-store');
  const supabaseUrl=process.env.SUPABASE_URL,serviceKey=process.env.SUPABASE_SECRET_KEY;
  if(req.method==='GET'){
    try{
      const ticket=formText(req.query?.ticket,40,true),email=formEmail(req.query?.email);
      if(!/^[a-z0-9-]+$/i.test(ticket))throw new PublicFormError(400,'Please check the ticket number.');
      if(!supabaseUrl||!serviceKey)throw new PublicFormError(503,'Support service is temporarily unavailable.');
      const response=await boundedFetch(`${supabaseUrl}/rest/v1/support_tickets?ticket_id=eq.${encodeURIComponent(ticket)}&email=eq.${encodeURIComponent(email)}&select=ticket_id,status,subject,resolution_note,created_at,updated_at&limit=1`,{headers:adminHeaders()},requestSignal());
      if(!response.ok)throw new Error('Support lookup failed');
      const rows=await response.json();if(!Array.isArray(rows))throw new Error('Invalid support lookup');
      if(!rows.length)return res.status(404).json({error:'Ticket not found.'});return res.status(200).json(rows[0]);
    }catch(error){return formFailure(res,error,'Unable to check this ticket right now.')}
  }
  if(req.method!=='POST'){res.setHeader('Allow','GET, POST');return res.status(405).json({error:'Method not allowed.'})}
  try{
    const body=formBody(req,32768);if(formText(body.website,200))return res.status(200).json({success:true});
    const name=formText(body.name,120),email=formEmail(body.email),issueType=formText(body.issue_type,60,true),subject=formText(body.subject,180,true),description=formText(body.description,5000,true),pageUrl=formText(body.page_url,1000),browserInfo=formText(body.browser_info,1000);
    if(description.length<10)return res.status(400).json({error:'Please complete all required fields.'});
    if(!new Set(['bug','account','barista','cafe','billing','feedback','question','other']).has(issueType))return res.status(400).json({error:'Please choose a valid issue type.'});
    if(!supabaseUrl||!serviceKey)throw new PublicFormError(503,'Support service is temporarily unavailable.');
    const signal=requestSignal();await consumePublicFormBudget(req,'support',email,signal);
    const ticketId=makeTicketId();
    const ticket={ticket_id:ticketId,email,name:name||null,issue_type:issueType,subject,description,page_url:pageUrl||null,browser_info:browserInfo||null,status:'new'};
    const triage=triageSupportTicket(ticket);
    const draft=supportDraft(ticket,triage);
    const dbResponse=await boundedFetch(`${supabaseUrl}/rest/v1/support_tickets`,{method:'POST',headers:adminHeaders({Prefer:'return=minimal'}),body:JSON.stringify(ticket)},signal);
    if(!dbResponse.ok)throw new PublicFormError(503,'We could not create your support ticket. Please try again.');
    const safeName=escapeHtml(name||'there'),safeTicket=escapeHtml(ticketId),safeSubject=escapeHtml(subject),safeDescription=escapeHtml(description).replaceAll('\n','<br>'),safeType=escapeHtml(issueType),safePage=escapeHtml(pageUrl||'Not provided');
    const [userEmail,internalEmail]=await Promise.all([
      sendFormEmail({from:'BaristaMatch Support <updates@updates.baristajobmatch.com>',to:[email],reply_to:'hello@baristajobmatch.com',subject:`We received your support request — ${ticketId}`,html:supportEmailHtml({name:safeName,ticket:safeTicket,subject:safeSubject})},`support/confirmation/${ticketId}`,signal),
      sendFormEmail({from:'BaristaMatch Support <updates@updates.baristajobmatch.com>',to:['hello@baristajobmatch.com'],reply_to:email,subject:`[${triage.priority}] ${issueType==='bug'?'🐞 Bug':'Support'} — ${ticketId}`,html:`<div style="max-width:650px;margin:0 auto;padding:24px;font-family:Arial,sans-serif;font-size:15px;line-height:1.6;color:#2b1a10"><h2>New BaristaMatch Support Ticket</h2><p><strong>Ticket:</strong> ${safeTicket}</p><p><strong>Type:</strong> ${safeType}</p><p><strong>AI category:</strong> ${escapeHtml(triage.category)}</p><p><strong>Priority:</strong> ${escapeHtml(triage.priority)}</p><p><strong>Route:</strong> ${escapeHtml(triage.route)}</p><p><strong>Owner approval:</strong> ${triage.approval_required?'Required':'Not currently required'}</p><p><strong>Reason:</strong> ${escapeHtml(triage.reason)}</p><p><strong>From:</strong> ${escapeHtml(email)}</p><p><strong>Subject:</strong> ${safeSubject}</p><p><strong>Description:</strong><br>${safeDescription}</p><p><strong>Page:</strong> ${safePage}</p><hr><p><strong>Suggested reply — NOT SENT:</strong></p><pre style="white-space:pre-wrap;font-family:Arial,sans-serif">${escapeHtml(draft)}</pre></div>`},`support/internal/${ticketId}`,signal),
    ]);
    if(!userEmail)console.error('Support confirmation email was not confirmed.');if(!internalEmail)console.error('Support internal email was not confirmed.');
    return res.status(200).json({success:true,ticket_id:ticketId,confirmation_sent:userEmail,triage:{priority:triage.priority,route:triage.route}});
  }catch(error){return formFailure(res,error,'Support service is temporarily unavailable. Please try again later.')}
}
