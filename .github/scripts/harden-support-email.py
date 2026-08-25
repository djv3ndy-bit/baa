from pathlib import Path

p=Path('api/support.js')
s=p.read_text()
old="if(!new Set(['bug','account','barista','cafe','billing','feedback','other']).has(issueType))return res.status(400).json({error:'Please choose a valid issue type.'});"
new="if(!new Set(['bug','account','barista','cafe','billing','feedback','question','other']).has(issueType))return res.status(400).json({error:'Please choose a valid issue type.'});"
if old in s:
    s=s.replace(old,new,1)
elif "'question'" not in s:
    raise SystemExit('issue type validation marker missing')
retry_fn="""
async function resendWithRetry(payload, attempts = 3) {
  let result={ok:false,data:{}};
  for(let i=0;i<attempts;i++){
    result=await resend(payload);
    if(result.ok)return result;
    if(i<attempts-1)await new Promise(resolve=>setTimeout(resolve,350*(i+1)));
  }
  return result;
}
"""
marker="function supportEmailHtml({name,ticket,subject}) {"
if 'async function resendWithRetry' not in s:
    if marker not in s: raise SystemExit('support email function marker missing')
    s=s.replace(marker,retry_fn+marker,1)
old_user="const userEmail=await resend({from:'BaristaMatch Support <updates@updates.baristajobmatch.com>',to:[email],reply_to:'hello@baristajobmatch.com',subject:`We received your support request — ${ticketId}`,html:supportEmailHtml({name:safeName,ticket:safeTicket,subject:safeSubject})});"
new_user="const userEmail=await resendWithRetry({from:'BaristaMatch Support <updates@updates.baristajobmatch.com>',to:[email],reply_to:'hello@baristajobmatch.com',subject:`We received your support request — ${ticketId}`,html:supportEmailHtml({name:safeName,ticket:safeTicket,subject:safeSubject})},3);"
if old_user in s:
    s=s.replace(old_user,new_user,1)
elif 'const userEmail=await resendWithRetry' not in s:
    raise SystemExit('user email send marker missing')
p.write_text(s)

hp=Path('support.html')
h=hp.read_text()
old_ui="successBox.style.display='block';ticketCopy.textContent=`Your ticket is ${data.ticket_id}. We also sent a confirmation email to you.`;formMessage.textContent='Support request sent successfully.';formMessage.className='message success';"
new_ui="successBox.style.display='block';ticketCopy.textContent=data.confirmation_sent?`Your ticket is ${data.ticket_id}. A confirmation email has been sent to you.`:`Your ticket is ${data.ticket_id}. Your request was saved, but the confirmation email could not be delivered right now. Please keep this ticket number.`;formMessage.textContent=data.confirmation_sent?'Support request sent successfully.':'Support request saved. Please keep your ticket number.';formMessage.className=data.confirmation_sent?'message success':'message';"
if old_ui in h:
    h=h.replace(old_ui,new_ui,1)
elif 'data.confirmation_sent?' not in h:
    raise SystemExit('support success UI marker missing')
hp.write_text(h)
