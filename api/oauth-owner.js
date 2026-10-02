const clean = value => String(value ?? '').trim();

async function authenticatedUser(req) {
  const token = clean(req.headers.authorization).replace(/^Bearer\s+/i, '');
  const url = clean(process.env.SUPABASE_URL).replace(/\/$/, '');
  const publishableKey = clean(process.env.SUPABASE_PUBLISHABLE_KEY);
  if (!token || !url || !publishableKey) return null;

  const response = await fetch(`${url}/auth/v1/user`, {
    headers: { apikey: publishableKey, Authorization: `Bearer ${token}` },
  });
  if (!response.ok) return null;
  return response.json();
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const ownerUserId = clean(process.env.BJM_AI_OFFICE_OWNER_USER_ID);
  if (!ownerUserId) return res.status(503).json({ error: 'Owner authorization is not configured' });

  const user = await authenticatedUser(req);
  if (!user) return res.status(401).json({ error: 'Authentication required' });
  if (clean(user.id) !== ownerUserId) return res.status(403).json({ error: 'Owner access required' });

  return res.status(200).json({ authorized: true });
}
