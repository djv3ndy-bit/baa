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

    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        from: "BaristaMatch <updates@updates.baristajobmatch.com>",
        to: ["hello@baristajobmatch.com"],
        reply_to: email,
        subject: `New BaristaMatch Waitlist Signup — ${role}`,
        html: `
          <h2>New BaristaMatch Waitlist Signup</h2>
          <p><strong>Role:</strong> ${escapeHtml(role)}</p>
          <p><strong>Email:</strong> ${escapeHtml(email)}</p>
          <p><strong>City:</strong> ${escapeHtml(city)}</p>
        `
      })
    });

    const data = await response.json();

    if (!response.ok) {
      console.error("Resend error:", data);
      return res.status(500).json({
        error: "Email could not be sent."
      });
    }

    return res.status(200).json({
      success: true
    });

  } catch (error) {
    console.error(error);

    return res.status(500).json({
      error: "Something went wrong."
    });
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
