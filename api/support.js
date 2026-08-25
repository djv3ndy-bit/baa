function clean(value, max = 5000) {
  return String(value || '').trim().slice(0, max);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function makeTicketId() {
  const date = new Date().toISOString().slice(0, 10).replaceAll('-', '');
  const suffix = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `BM-${date}-${suffix}`;
}

async function resend(payload) {
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });
  let data = {};
  try { data = await response.json(); } catch {}
  return { ok: response.ok, data };
}

function supportEmailHtml({ name, ticket, subject }) {
  return `<!doctype html>
<html><head><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light only"></head>
<body style="margin:0;padding:0;background:#f5f1ec;-webkit-text-size-adjust:100%;text-size-adjust:100%;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;background:#f5f1ec;margin:0;padding:0;">
<tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;max-width:600px;background:#fbf7f1;border-radius:18px;overflow:hidden;">
<tr><td style="padding:28px 24px 12px;font-family:Arial,sans-serif;color:#321708;">
<div style="font-size:24px;line-height:30px;font-weight:800;white-space:nowrap;">Barista<span style="color:#a95820;">Match</span> <span style="font-size:16px;color:#746a61;font-weight:700;">Support</span></div>
</td></tr>
<tr><td style="padding:8px 24px 28px;font-family:Arial,sans-serif;color:#321708;font-size:16px;line-height:25px;">
<h1 style="margin:0 0 14px;font-family:Arial,sans-serif;font-size:28px;line-height:35px;color:#321708;font-weight:800;">Thanks for contacting us${name && name !== 'there' ? `, ${name}` : ''}.</h1>
<p style="margin:0 0 18px;font-size:16px;line-height:25px;color:#4d4038;">We received your request and our team will review it.</p>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;background:#ffffff;border:1px solid #e7ddd2;border-radius:12px;">
<tr><td style="padding:17px 18px;font-family:Arial,sans-serif;font-size:15px;line-height:23px;color:#321708;word-break:break-word;">
<div style="margin:0 0 7px;"><strong>Ticket:</strong> ${ticket}</div>
<div style="margin:0 0 7px;"><strong>Status:</strong> Received</div>
<div><strong>Issue:</strong> ${subject}</div>
</td></tr></table>
<p style="margin:20px 0 0;font-size:16px;line-height:25px;color:#4d4038;">Keep this ticket number for reference. We’ll email you when there is an update.</p>
<p style="margin:24px 0 0;font-size:15px;line-height:23px;color:#746a61;">— BaristaMatch Support</p>
</td></tr>
<tr><td style="padding:18px 24px;border-top:1px solid #e7ddd2;font-family:Arial,sans-serif;font-size:12px;line-height:18px;color:#8a7d73;">baristajobmatch.com</td></tr>
</table>
</td></tr></table>
</body></html>`;
}

export default async function handler(req, res) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SECRET_KEY;
  if (!supabaseUrl || !serviceKey) return res.status(503).json({ error: 'Support service is temporarily unavailable.' });

  if (req.method === 'GET') {
    const ticket = clean(req.query?.ticket, 40);
    const email = clean(req.query?.email, 320).toLowerCase();
    if (!ticket || !email) return res.status(400).json({ error: 'Ticket number and email are required.' });
    const url = `${supabaseUrl}/rest/v1/support_tickets?ticket_id=eq.${encodeURIComponent(ticket)}&email=eq.${encodeURIComponent(email)}&select=ticket_id,status,subject,resolution_note,created_at,updated_at&limit=1`;
    const response = await fetch(url, { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } });
    if (!response.ok) { console.error('Support lookup error:', await response.text()); return res.status(500).json({ error: 'Unable to check this ticket right now.' }); }
    const rows = await response.json();
    if (!rows.length) return res.status(404).json({ error: 'Ticket not found.' });
    return res.status(200).json(rows[0]);
  }

  if (req.method !== 'POST') { res.setHeader('Allow', 'GET, POST'); return res.status(405).json({ error: 'Method not allowed.' }); }

  try {
    const body = req.body || {};
    if (clean(body.website, 200)) return res.status(200).json({ success: true });
    const name = clean(body.name, 120);
    const email = clean(body.email, 320).toLowerCase();
    const issueType = clean(body.issue_type, 60);
    const subject = clean(body.subject, 180);
    const description = clean(body.description, 5000);
    const pageUrl = clean(body.page_url, 1000);
    const browserInfo = clean(body.browser_info, 1000);
    if (!email || !email.includes('@') || !issueType || !subject || description.length < 10) return res.status(400).json({ error: 'Please complete all required fields.' });
    const allowedTypes = new Set(['bug', 'account', 'barista', 'cafe', 'billing', 'feedback', 'other']);
    if (!allowedTypes.has(issueType)) return res.status(400).json({ error: 'Please choose a valid issue type.' });

    const ticketId = makeTicketId();
    const dbResponse = await fetch(`${supabaseUrl}/rest/v1/support_tickets`, {
      method: 'POST', headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json', Prefer: 'return=representation' },
      body: JSON.stringify({ ticket_id: ticketId, email, name: name || null, issue_type: issueType, subject, description, page_url: pageUrl || null, browser_info: browserInfo || null, status: 'new' })
    });
    if (!dbResponse.ok) { console.error('Support insert error:', await dbResponse.text()); return res.status(500).json({ error: 'We could not create your support ticket. Please try again.' }); }

    const safeName = escapeHtml(name || 'there');
    const safeTicket = escapeHtml(ticketId);
    const safeSubject = escapeHtml(subject);
    const safeDescription = escapeHtml(description).replaceAll('\n', '<br>');
    const safeType = escapeHtml(issueType);
    const safePage = escapeHtml(pageUrl || 'Not provided');

    const userEmail = await resend({
      from: 'BaristaMatch Support <updates@updates.baristajobmatch.com>', to: [email], reply_to: 'hello@baristajobmatch.com',
      subject: `We received your support request — ${ticketId}`,
      html: supportEmailHtml({ name: safeName, ticket: safeTicket, subject: safeSubject })
    });

    const internalEmail = await resend({
      from: 'BaristaMatch Support <updates@updates.baristajobmatch.com>', to: ['hello@baristajobmatch.com'], reply_to: email,
      subject: `${issueType === 'bug' ? '🐞 New Bug' : 'New Support Ticket'} — ${ticketId}`,
      html: `<div style="max-width:600px;margin:0 auto;padding:24px;font-family:Arial,sans-serif;font-size:15px;line-height:1.6;color:#2b1a10"><h2 style="font-size:24px;line-height:30px">New BaristaMatch Support Ticket</h2><p><strong>Ticket:</strong> ${safeTicket}</p><p><strong>Type:</strong> ${safeType}</p><p><strong>From:</strong> ${escapeHtml(email)}</p><p><strong>Subject:</strong> ${safeSubject}</p><p><strong>Description:</strong><br>${safeDescription}</p><p><strong>Page:</strong> ${safePage}</p><p><strong>Status:</strong> New</p></div>`
    });
    if (!userEmail.ok) console.error('Support confirmation email failed:', userEmail.data);
    if (!internalEmail.ok) console.error('Support internal email failed:', internalEmail.data);
    return res.status(200).json({ success: true, ticket_id: ticketId, confirmation_sent: userEmail.ok });
  } catch (error) {
    console.error('Support API error:', error);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
}
