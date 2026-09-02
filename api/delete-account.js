const jsonHeaders = { "Cache-Control": "no-store", "Content-Type": "application/json" };
const DELETE_CONFIRMATION = "DELETE";

function ownedObjectPath(value, userId) {
  const path = String(value || "").trim();
  if (!path.startsWith(`${userId}/`)) return null;
  const parts = path.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) return null;
  return path;
}

export function storedObjectsForProfile(profile, userId, supabaseUrl) {
  const objects = new Map();
  const add = (bucket, path) => {
    const ownedPath = ownedObjectPath(path, userId);
    if (ownedPath) objects.set(`${bucket}:${ownedPath}`, [bucket, ownedPath]);
  };

  add("coffee-videos", profile?.video_path);
  for (const imageUrl of [profile?.avatar_url, profile?.bar_picture_url]) {
    if (!imageUrl) continue;
    try {
      const parsed = new URL(imageUrl);
      if (parsed.origin !== new URL(supabaseUrl).origin) continue;
      const marker = "/storage/v1/object/public/cafe-images/";
      const markerIndex = parsed.pathname.indexOf(marker);
      if (markerIndex === -1) continue;
      add("cafe-images", decodeURIComponent(parsed.pathname.slice(markerIndex + marker.length)));
    } catch {
      // Invalid or non-Supabase URLs are not trusted as storage deletion targets.
    }
  }
  return [...objects.values()];
}

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
  if (String(req.body?.confirmation || "").trim() !== DELETE_CONFIRMATION) {
    return res.status(400).json({ error: `Type ${DELETE_CONFIRMATION} exactly to confirm account deletion.` });
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

    const profileResponse = await fetch(`${supabaseUrl}/rest/v1/profiles?id=eq.${encodeURIComponent(user.id)}&select=video_path,avatar_url,bar_picture_url`, {
      headers: adminHeaders,
      signal: AbortSignal.timeout(10000)
    });
    if (profileResponse.ok) {
      const profiles = await profileResponse.json();
      const storedObjects = storedObjectsForProfile(profiles?.[0], user.id, supabaseUrl);
      for (const [bucket, objectPath] of storedObjects) {
        const encodedPath = objectPath.split("/").map(encodeURIComponent).join("/");
        const storageResponse = await fetch(`${supabaseUrl}/storage/v1/object/${bucket}/${encodedPath}`, {
          method: "DELETE",
          headers: adminHeaders,
          signal: AbortSignal.timeout(10000)
        });
        if (!storageResponse.ok && storageResponse.status !== 404) {
          console.error("Account storage cleanup failed with status", storageResponse.status);
          return res.status(502).json({ error: "We could not safely remove your account files. Please try again." });
        }
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
