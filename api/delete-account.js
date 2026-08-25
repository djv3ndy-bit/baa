const jsonHeaders = { "Cache-Control": "no-store", "Content-Type": "application/json" };

export default async function handler(req, res) {
  Object.entries(jsonHeaders).forEach(([name, value]) => res.setHeader(name, value));
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed." });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY;
  const secretKey = process.env.SUPABASE_SECRET_KEY;
  if (!supabaseUrl || !publishableKey || !secretKey) {
    return res.status(503).json({ error: "Account management is temporarily unavailable." });
  }
  if (req.body?.confirmation !== "DELETE") {
    return res.status(400).json({ error: "Account deletion was not confirmed." });
  }

  const authorization = String(req.headers.authorization || "");
  const accessToken = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
  if (!accessToken) return res.status(401).json({ error: "Your session expired. Please log in again." });

  try {
    const userResponse = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: { apikey: publishableKey, Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(10000)
    });
    if (!userResponse.ok) return res.status(401).json({ error: "Your session expired. Please log in again." });

    const user = await userResponse.json();
    if (!user?.id) return res.status(401).json({ error: "Your session expired. Please log in again." });
    const adminHeaders = { apikey: secretKey };
    if (!secretKey.startsWith("sb_secret_")) adminHeaders.Authorization = `Bearer ${secretKey}`;

    const profileResponse = await fetch(`${supabaseUrl}/rest/v1/profiles?id=eq.${encodeURIComponent(user.id)}&select=video_path`, {
      headers: adminHeaders,
      signal: AbortSignal.timeout(10000)
    });
    if (profileResponse.ok) {
      const profiles = await profileResponse.json();
      const videoPath = profiles?.[0]?.video_path;
      if (videoPath) {
        const encodedPath = String(videoPath).split("/").map(encodeURIComponent).join("/");
        await fetch(`${supabaseUrl}/storage/v1/object/coffee-videos/${encodedPath}`, {
          method: "DELETE",
          headers: adminHeaders,
          signal: AbortSignal.timeout(10000)
        });
      }
    }

    const deleteResponse = await fetch(`${supabaseUrl}/auth/v1/admin/users/${encodeURIComponent(user.id)}`, {
      method: "DELETE",
      headers: adminHeaders,
      signal: AbortSignal.timeout(15000)
    });
    if (!deleteResponse.ok) {
      console.error("Account deletion failed with status", deleteResponse.status);
      return res.status(502).json({ error: "We could not delete your account. Please try again." });
    }
    return res.status(200).json({ success: true });
  } catch (error) {
    console.error("Account deletion request failed", error?.name || "Error");
    return res.status(504).json({ error: "Account deletion took too long. Please try again." });
  }
}
