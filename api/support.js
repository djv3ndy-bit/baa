function clean(value, max = 5000) {
  return String(value || '').trim().slice(0, max);
}
function escapeHtml(value) {
  return String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#039;');
}
function makeTicketId() {
  const date=new Date().toISOString().slice(0,10).replaceAll('-','');
  return `BM-${date}-${Math.random().toString(36).slice(2,8).toUpperCase()}`;
}
async function resend(payload) {
  const response=await fetch('https://api.resend.com/emails',{method:'POST',headers:{Authorization:`Bearer ${process.env.RESEND_API_KEY}`,'Content-Type':'application/json'},body:JSON.stringify(payload)});
  let data={}; try{data=await response.json()}catch{} return {ok:response.ok,data};
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
  const supabaseUrl=process.env.SUPABASE_URL,serviceKey=process.env.SUPABASE_SECRET_KEY;
  if(!supabaseUrl||!serviceKey)return res.status(503).json({error:'Support service is temporarily unavailable.'});
  if(req.method==='GET'){
    const ticket=clean(req.query?.ticket,40),email=clean(req.query?.email,320).toLowerCase();
    if(!ticket||!email)return res.status(400).json({error:'Ticket number and email are required.'});
    const response=await fetch(`${supabaseUrl}/rest/v1/support_tickets?ticket_id=eq.${encodeURIComponent(ticket)}&email=eq.${encodeURIComponent(email)}&select=ticket_id,status,subject,resolution_note,created_at,updated_at&limit=1`,{headers:{apikey:serviceKey,Authorization:`Bearer ${serviceKey}`}});
    if(!response.ok){console.error('Support lookup error:',await response.text());return res.status(500).json({error:'Unable to check this ticket right now.'})}
    const rows=await response.json();if(!rows.length)return res.status(404).json({error:'Ticket not found.'});return res.status(200).json(rows[0]);
  }
  if(req.method!=='POST'){res.setHeader('Allow','GET, POST');return res.status(405).json({error:'Method not allowed.'})}
  try{
    const body=req.body||{};if(clean(body.website,200))return res.status(200).json({success:true});
    const name=clean(body.name,120),email=clean(body.email,320).toLowerCase(),issueType=clean(body.issue_type,60),subject=clean(body.subject,180),description=clean(body.description,5000),pageUrl=clean(body.page_url,1000),browserInfo=clean(body.browser_info,1000);
    if(!email||!email.includes('@')||!issueType||!subject||description.length<10)return res.status(400).json({error:'Please complete all required fields.'});
    if(!new Set(['bug','account','barista','cafe','billing','feedback','other']).has(issueType))return res.status(400).json({error:'Please choose a valid issue type.'});
    const ticketId=makeTicketId();
    const dbResponse=await fetch(`${supabaseUrl}/rest/v1/support_tickets`,{method:'POST',headers:{apikey:serviceKey,Authorization:`Bearer ${serviceKey}`,'Content-Type':'application/json',Prefer:'return=representation'},body:JSON.stringify({ticket_id:ticketId,email,name:name||null,issue_type:issueType,subject,description,page_url:pageUrl||null,browser_info:browserInfo||null,status:'new'})});
    if(!dbResponse.ok){console.error('Support insert error:',await dbResponse.text());return res.status(500).json({error:'We could not create your support ticket. Please try again.'})}
    const safeName=escapeHtml(name||'there'),safeTicket=escapeHtml(ticketId),safeSubject=escapeHtml(subject),safeDescription=escapeHtml(description).replaceAll('\n','<br>'),safeType=escapeHtml(issueType),safePage=escapeHtml(pageUrl||'Not provided');
    const userEmail=await resend({from:'BaristaMatch Support <updates@updates.baristajobmatch.com>',to:[email],reply_to:'hello@baristajobmatch.com',subject:`We received your support request — ${ticketId}`,html:supportEmailHtml({name:safeName,ticket:safeTicket,subject:safeSubject})});
    const internalEmail=await resend({from:'BaristaMatch Support <updates@updates.baristajobmatch.com>',to:['hello@baristajobmatch.com'],reply_to:email,subject:`${issueType==='bug'?'🐞 New Bug':'New Support Ticket'} — ${ticketId}`,html:`<div style="max-width:600px;margin:0 auto;padding:24px;font-family:Arial,sans-serif;font-size:15px;line-height:1.6;color:#2b1a10"><h2 style="font-size:24px;line-height:30px">New BaristaMatch Support Ticket</h2><p><strong>Ticket:</strong> ${safeTicket}</p><p><strong>Type:</strong> ${safeType}</p><p><strong>From:</strong> ${escapeHtml(email)}</p><p><strong>Subject:</strong> ${safeSubject}</p><p><strong>Description:</strong><br>${safeDescription}</p><p><strong>Page:</strong> ${safePage}</p><p><strong>Status:</strong> New</p></div>`});
    if(!userEmail.ok)console.error('Support confirmation email failed:',userEmail.data);if(!internalEmail.ok)console.error('Support internal email failed:',internalEmail.data);
    return res.status(200).json({success:true,ticket_id:ticketId,confirmation_sent:userEmail.ok});
  }catch(error){console.error('Support API error:',error);return res.status(500).json({error:'Something went wrong. Please try again.'})}
}
