import { randomUUID } from 'node:crypto';
import { adminHeaders, boundedFetch, consumePublicFormBudget, formBody, formEmail, formFailure, formText, PublicFormError, requestSignal, sendFormEmail } from './_public-form-guard.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');
  if (req.method !== "POST") {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const body = formBody(req, 8192);
    if (formText(body.website, 200)) return res.status(200).json({ success: true });
    const cleanRole = formText(body.role, 40, true);
    const cleanEmail = formEmail(body.email);
    const cleanCity = formText(body.city, 120, true);
    if (!new Set(["barista", "cafe_owner_manager"]).has(cleanRole)) {
      return res.status(400).json({ error: "Please choose a valid account type." });
    }

    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SECRET_KEY) {
      throw new PublicFormError(503, 'Waitlist signup is temporarily unavailable.');
    }
    const signal = requestSignal();
    await consumePublicFormBudget(req, 'waitlist', cleanEmail, signal);

    // 1. Check whether this email is already on the waitlist
    const existingResponse = await boundedFetch(
      `${process.env.SUPABASE_URL}/rest/v1/waitlist_signups?email=eq.${encodeURIComponent(cleanEmail)}&select=id`,
      {
        method: "GET",
        headers: adminHeaders()
      }, signal
    );

    if (!existingResponse.ok) {
      return res.status(503).json({
        error: "We couldn't save your signup. Please try again."
      });
    }

    const existingRows = await existingResponse.json();
    if (!Array.isArray(existingRows)) throw new Error('Invalid waitlist lookup');

    if (existingRows.length > 0) {
      return res.status(200).json({
        success: true,
        alreadyJoined: true,
        message: "You're already on the BaristaMatch waitlist."
      });
    }

    // 2. Save signup to Supabase
    const databaseResponse = await boundedFetch(
      `${process.env.SUPABASE_URL}/rest/v1/waitlist_signups`,
      {
        method: "POST",
        headers: {
          ...adminHeaders(),
          "Content-Type": "application/json",
          Prefer: "return=minimal"
        },
        body: JSON.stringify({
          email: cleanEmail,
          role: cleanRole,
          city: cleanCity,
          status: "waitlisted"
        })
      }, signal
    );

    if (!databaseResponse.ok) {
      // A concurrent signup may have inserted this address after our lookup.
      const failure = databaseResponse.status === 409 ? await databaseResponse.json().catch(() => ({})) : {};
      if (failure?.code === '23505') return res.status(200).json({ success: true, alreadyJoined: true, message: "You're already on the BaristaMatch waitlist." });
      return res.status(503).json({
        error: "We couldn't save your signup. Please try again."
      });
    }

    const safeRole = escapeHtml(cleanRole);
    const safeEmail = escapeHtml(cleanEmail);
    const safeCity = escapeHtml(cleanCity);
    const signupEvent = randomUUID();

    // 3. Send BaristaMatch internal notification
    const internalPayload = {
      from: "BaristaMatch <updates@updates.baristajobmatch.com>",
      to: ["hello@baristajobmatch.com"],
      reply_to: cleanEmail,
      subject: `New BaristaMatch Waitlist Signup — ${cleanRole}`,
      html: `
        <div style="font-family:Arial,sans-serif;line-height:1.6;color:#2b1a10">
          <h2>New BaristaMatch Waitlist Signup</h2>
          <p><strong>Role:</strong> ${safeRole}</p>
          <p><strong>Email:</strong> ${safeEmail}</p>
          <p><strong>City:</strong> ${safeCity}</p>
          <p><strong>Status:</strong> Waitlisted</p>
        </div>
      `
    };

    // 4. Send confirmation email to applicant
    const confirmationPayload = {
      from: "BaristaMatch <updates@updates.baristajobmatch.com>",
      to: [cleanEmail],
      reply_to: "hello@baristajobmatch.com",
      subject: "Welcome to the BaristaMatch waitlist ☕",
      html: `
        <div style="
          max-width:600px;
          margin:0 auto;
          padding:32px;
          background:#fbf7f1;
          border-radius:18px;
          font-family:Arial,sans-serif;
          color:#321708;
          line-height:1.6;
        ">
          <div style="font-size:30px;font-weight:800;">
            Barista<span style="color:#a95820;">Match</span>
          </div>

          <div style="color:#746a61;font-size:14px;margin:4px 0 32px;">
            Swipe. Match. Brew.
          </div>

          <h2>You're on the list! ☕</h2>

          <p>
            Thanks for joining the BaristaMatch early-access waitlist.
          </p>

          <p>
            We're building a faster and simpler way for talented baristas
            and great local coffee shops to find each other.
          </p>

          <div style="
            background:#ffffff;
            border:1px solid #e7ddd2;
            border-radius:12px;
            padding:18px;
            margin:24px 0;
          ">
            <p><strong>Signed up as:</strong> ${safeRole}</p>
            <p><strong>City:</strong> ${safeCity}</p>
          </div>

          <p>
            We'll contact you when early access becomes available in your area.
          </p>

          <p style="margin-top:30px;">
            — The BaristaMatch Team
          </p>

          <div style="
            border-top:1px solid #e7ddd2;
            margin-top:30px;
            padding-top:16px;
            color:#746a61;
            font-size:12px;
          ">
            baristajobmatch.com
          </div>
        </div>
      `
    };
    const [internalEmail, confirmationEmail] = await Promise.all([
      sendFormEmail(internalPayload, `waitlist/internal/${signupEvent}`, signal),
      sendFormEmail(confirmationPayload, `waitlist/confirmation/${signupEvent}`, signal),
    ]);
    if (!internalEmail) console.error('Waitlist internal email was not confirmed.');
    if (!confirmationEmail) console.error('Waitlist confirmation email was not confirmed.');

    return res.status(200).json({
      success: true,
      saved: true,
      internalEmailSent: internalEmail,
      confirmationSent: confirmationEmail
    });

  } catch (error) {
    return formFailure(res, error, 'Waitlist signup is temporarily unavailable. Please try again later.');
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
