export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { role, email, city } = req.body || {};

    if (!role || !email || !city) {
      return res.status(400).json({
        error: "Please complete all fields."
      });
    }

    const safeRole = escapeHtml(role);
    const safeEmail = escapeHtml(email);
    const safeCity = escapeHtml(city);

    // 1. Send notification to BaristaMatch
    const internalEmail = await sendEmail({
      from: "BaristaMatch <updates@updates.baristajobmatch.com>",
      to: ["hello@baristajobmatch.com"],
      reply_to: email,
      subject: `New BaristaMatch Waitlist Signup — ${role}`,
      html: `
        <div style="font-family:Arial,sans-serif;line-height:1.6;color:#2b1a10">
          <h2>New BaristaMatch Waitlist Signup</h2>
          <p><strong>Role:</strong> ${safeRole}</p>
          <p><strong>Email:</strong> ${safeEmail}</p>
          <p><strong>City:</strong> ${safeCity}</p>
        </div>
      `
    });

    if (!internalEmail.ok) {
      console.error("Internal email failed:", internalEmail.data);

      return res.status(500).json({
        error: "Signup notification could not be sent."
      });
    }

    // 2. Automatically email the person who signed up
    const confirmationEmail = await sendEmail({
      from: "BaristaMatch <updates@updates.baristajobmatch.com>",
      to: [email],
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

          <div style="
            font-size:30px;
            font-weight:800;
            margin-bottom:4px;
          ">
            Barista<span style="color:#a95820;">Match</span>
          </div>

          <div style="
            color:#746a61;
            font-size:14px;
            margin-bottom:32px;
          ">
            Swipe. Match. Brew.
          </div>

          <h2 style="font-size:26px;">
            You're on the list! ☕
          </h2>

          <p>
            Thanks for joining the BaristaMatch early-access waitlist.
          </p>

          <p>
            We're building a simple way for talented baristas and
            great local coffee shops to find each other faster.
          </p>

          <div style="
            background:#ffffff;
            border:1px solid #e7ddd2;
            border-radius:12px;
            padding:18px;
            margin:24px 0;
          ">
            <p style="margin:4px 0;">
              <strong>Signed up as:</strong> ${safeRole}
            </p>

            <p style="margin:4px 0;">
              <strong>City:</strong> ${safeCity}
            </p>
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
      confirmationSent: confirmationEmail.ok
    });

  } catch (error) {
    console.error(error);

    return res.status(500).json({
      error: "Something went wrong."
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
