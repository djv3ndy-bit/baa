export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SECRET_KEY) {
      return res.status(503).json({ error: "Waitlist signup is temporarily unavailable." });
    }

    const { role, email, city } = req.body || {};

    const cleanRole = String(role || "").trim();
    const cleanEmail = String(email || "").trim().toLowerCase();
    const cleanCity = String(city || "").trim();

    if (!cleanRole || !cleanEmail || !cleanCity) {
      return res.status(400).json({
        error: "Please complete all fields."
      });
    }

    if (!cleanEmail.includes("@")) {
      return res.status(400).json({
        error: "Please enter a valid email address."
      });
    }
    if (!new Set(["barista", "cafe_owner_manager"]).has(cleanRole)) {
      return res.status(400).json({ error: "Please choose a valid account type." });
    }

    const adminHeaders = { apikey: process.env.SUPABASE_SECRET_KEY };
    if (!process.env.SUPABASE_SECRET_KEY.startsWith("sb_secret_")) {
      adminHeaders.Authorization = `Bearer ${process.env.SUPABASE_SECRET_KEY}`;
    }

    // 1. Check whether this email is already on the waitlist
    const existingResponse = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/waitlist_signups?email=eq.${encodeURIComponent(cleanEmail)}&select=id`,
      {
        method: "GET",
        headers: adminHeaders
      }
    );

    if (!existingResponse.ok) {
      const errorText = await existingResponse.text();
      console.error("Supabase lookup error:", errorText);

      return res.status(500).json({
        error: "We couldn't save your signup. Please try again."
      });
    }

    const existingRows = await existingResponse.json();

    if (existingRows.length > 0) {
      return res.status(200).json({
        success: true,
        alreadyJoined: true,
        message: "You're already on the BaristaMatch waitlist."
      });
    }

    // 2. Save signup to Supabase
    const databaseResponse = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/waitlist_signups`,
      {
        method: "POST",
        headers: {
          ...adminHeaders,
          "Content-Type": "application/json",
          Prefer: "return=minimal"
        },
        body: JSON.stringify({
          email: cleanEmail,
          role: cleanRole,
          city: cleanCity,
          status: "waitlisted"
        })
      }
    );

    if (!databaseResponse.ok) {
      const errorText = await databaseResponse.text();
      console.error("Supabase insert error:", errorText);

      return res.status(500).json({
        error: "We couldn't save your signup. Please try again."
      });
    }

    const safeRole = escapeHtml(cleanRole);
    const safeEmail = escapeHtml(cleanEmail);
    const safeCity = escapeHtml(cleanCity);

    // 3. Send BaristaMatch internal notification
    const internalEmail = await sendEmail({
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
    });

    if (!internalEmail.ok) {
      console.error("Internal notification failed:", internalEmail.data);
    }

    // 4. Send confirmation email to applicant
    const confirmationEmail = await sendEmail({
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
    });

    if (!confirmationEmail.ok) {
      console.error(
        "Confirmation email failed:",
        confirmationEmail.data
      );
    }

    return res.status(200).json({
      success: true,
      saved: true,
      internalEmailSent: internalEmail.ok,
      confirmationSent: confirmationEmail.ok
    });

  } catch (error) {
    console.error("Waitlist error:", error);

    return res.status(500).json({
      error: "Something went wrong. Please try again."
    });
  }
}

async function sendEmail(payload) {
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  let data = {};

  try {
    data = await response.json();
  } catch {}

  return {
    ok: response.ok,
    data
  };
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
