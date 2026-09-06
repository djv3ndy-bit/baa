const jsonHeaders = { "Cache-Control": "no-store", "Content-Type": "application/json" };
const DELETE_CONFIRMATION = "DELETE";
const UPLOAD_BUCKETS = ["coffee-videos", "cafe-images"];
const PAGE_SIZE = 100;
const MAX_OBJECTS = 5000;
const MAX_FOLDERS = 100;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function ownedObjectPath(value, userId) {
  const path = String(value || "").trim();
  if (!path.startsWith(`${userId}/`) || /[\\\u0000-\u001f]/.test(path)) return null;
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
      if (!parsed.pathname.startsWith(marker)) continue;
      add("cafe-images", decodeURIComponent(parsed.pathname.slice(marker.length)));
    } catch {
      // Never trust external URLs or another member's paths as deletion targets.
    }
  }
  return [...objects.values()];
}

class CleanupError extends Error {
  constructor(message = "We could not safely remove your account data. Please try again or contact support.") {
    super(message);
    this.name = "CleanupError";
  }
}

// Enumerate before deleting: mutating a paginated list while reading it skips files.
// Prefix ownership is checked again even though the listing is server-authenticated.
export async function listOwnedUploads(userId, request) {
  const objects = [];
  let folderCount = 0;
  for (const bucket of UPLOAD_BUCKETS) {
    const folders = [`${userId}/`];
    for (let index = 0; index < folders.length; index += 1) {
      if (++folderCount > MAX_FOLDERS) throw new CleanupError();
      const prefix = folders[index];
      for (let offset = 0; offset <= MAX_OBJECTS; offset += PAGE_SIZE) {
        const response = await request(`/storage/v1/object/list/${bucket}`, {
          method: "POST",
          body: JSON.stringify({ prefix, limit: PAGE_SIZE, offset, sortBy: { column: "name", order: "asc" } })
        });
        if (!response.ok) throw new CleanupError();
        const rows = await response.json();
        if (!Array.isArray(rows) || rows.length > PAGE_SIZE) throw new CleanupError();
        for (const row of rows) {
          if (!row || typeof row.name !== "string" || !row.name || /[/\\\u0000-\u001f]/.test(row.name)) throw new CleanupError();
          const path = ownedObjectPath(`${prefix}${row.name}`, userId);
          if (!path) throw new CleanupError();
          if (row.id === null && row.metadata === null) {
            const folder = `${path}/`;
            if (folders.includes(folder)) throw new CleanupError();
            folders.push(folder);
          } else if (typeof row.id === "string" && row.id) {
            objects.push([bucket, path]);
            if (objects.length > MAX_OBJECTS) throw new CleanupError();
          } else {
            throw new CleanupError();
          }
        }
        if (rows.length < PAGE_SIZE) break;
        if (offset === MAX_OBJECTS) throw new CleanupError();
      }
    }
  }
  return objects;
}

export default async function handler(req, res) {
  Object.entries(jsonHeaders).forEach(([name, value]) => res.setHeader(name, value));
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed." });
  }
  const supabaseUrl = process.env.SUPABASE_URL?.replace(/\/$/, "");
  const publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY;
  const secretKey = process.env.SUPABASE_SECRET_KEY;
  if (!supabaseUrl || !publishableKey || !secretKey) {
    return res.status(503).json({ error: "Account management is temporarily unavailable." });
  }
  if (String(req.body?.confirmation || "").trim() !== DELETE_CONFIRMATION) {
    return res.status(400).json({ error: `Type ${DELETE_CONFIRMATION} exactly to confirm account deletion.` });
  }
  const authorization = String(req.headers?.authorization || "");
  const accessToken = /^Bearer\s+(\S+)$/i.exec(authorization)?.[1];
  if (!accessToken) return res.status(401).json({ error: "Your session expired. Please log in again." });

  const deadline = AbortSignal.timeout(25000);
  try {
    const userResponse = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: { apikey: publishableKey, Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.any([deadline, AbortSignal.timeout(10000)])
    });
    if (userResponse.status === 401 || userResponse.status === 403) {
      return res.status(401).json({ error: "Your session expired. Please log in again." });
    }
    if (!userResponse.ok) throw new CleanupError();
    const user = await userResponse.json();
    if (!UUID.test(String(user?.id || ""))) throw new CleanupError();

    const adminHeaders = { apikey: secretKey, "Content-Type": "application/json" };
    if (!secretKey.startsWith("sb_secret_")) adminHeaders.Authorization = `Bearer ${secretKey}`;
    const request = (path, options = {}) => fetch(`${supabaseUrl}${path}`, {
      ...options,
      headers: adminHeaders,
      signal: AbortSignal.any([deadline, AbortSignal.timeout(10000)])
    });
    const profileResponse = await request(`/rest/v1/profiles?id=eq.${encodeURIComponent(user.id)}&select=video_path,avatar_url,bar_picture_url&limit=1`);
    // A failed lookup is not an empty profile. Never delete the identity on error.
    if (!profileResponse.ok) throw new CleanupError();
    const profiles = await profileResponse.json();
    if (!Array.isArray(profiles) || profiles.length > 1) throw new CleanupError();

    const objects = new Map();
    for (const item of [...await listOwnedUploads(user.id, request), ...storedObjectsForProfile(profiles[0], user.id, supabaseUrl)]) {
      objects.set(`${item[0]}:${item[1]}`, item);
    }
    for (const bucket of UPLOAD_BUCKETS) {
      const paths = [...objects.values()].filter(([name]) => name === bucket).map(([, path]) => path);
      for (let offset = 0; offset < paths.length; offset += PAGE_SIZE) {
        // Storage API removes physical objects, not just storage.objects SQL rows.
        const response = await request(`/storage/v1/object/${bucket}`, {
          method: "DELETE", body: JSON.stringify({ prefixes: paths.slice(offset, offset + PAGE_SIZE) })
        });
        if (!response.ok) throw new CleanupError();
      }
    }
    // Confirm cleanup. This also catches uploads arriving during enumeration.
    if ((await listOwnedUploads(user.id, request)).length) throw new CleanupError();
    const deleteResponse = await request(`/auth/v1/admin/users/${encodeURIComponent(user.id)}`, { method: "DELETE" });
    if (!deleteResponse.ok) throw new CleanupError("We could not delete your account. Please try again or contact support.");
    return res.status(200).json({ success: true });
  } catch (error) {
    const timeout = error?.name === "TimeoutError" || error?.name === "AbortError";
    console.error("Account deletion request failed", error?.name || "Error");
    return res.status(timeout ? 504 : 502).json({
      error: timeout ? "Account deletion took too long. Please try again." : error instanceof CleanupError ? error.message : "We could not safely remove your account data. Please try again."
    });
  }
}
