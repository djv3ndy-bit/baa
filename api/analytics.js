const clean = (value, max) => String(value ?? '').trim().slice(0, max);

function serverHeaders(extra = {}) {
  const key = process.env.SUPABASE_SECRET_KEY;
  const headers = { apikey: key, 'Content-Type': 'application/json', ...extra };
  if (key && !key.startsWith('sb_secret_')) headers.Authorization = `Bearer ${key}`;
  return headers;
}

function rest(path, options = {}) {
  return fetch(`${process.env.SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: { ...serverHeaders(), ...(options.headers || {}) },
  });
}

function deviceType(userAgent) {
  const ua = String(userAgent || '');
  if (/iPad|Tablet|PlayBook|Silk/i.test(ua)) return 'tablet';
  if (/Mobi|Android|iPhone|iPod/i.test(ua)) return 'mobile';
  return 'desktop';
}

async function owner(req) {
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) return null;
  const auth = await fetch(`${process.env.SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: process.env.SUPABASE_PUBLISHABLE_KEY, Authorization: `Bearer ${token}` },
  });
  if (!auth.ok) return null;
  const user = await auth.json();
  const check = await rest(`support_admins?user_id=eq.${encodeURIComponent(user.id)}&select=user_id&limit=1`);
  if (!check.ok) return null;
  return (await check.json()).length ? user : null;
}

async function authenticatedUser(req) {
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) return null;
  const response = await fetch(`${process.env.SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: process.env.SUPABASE_PUBLISHABLE_KEY, Authorization: `Bearer ${token}` },
  });
  return response.ok ? response.json() : null;
}

async function record(req, res) {
  const channel = req.body?.channel === 'app' ? 'app' : 'web';
  if (channel === 'app' && !await authenticatedUser(req)) return res.status(204).end();
  const fetchSite = clean(req.headers['sec-fetch-site'], 30);
  if (channel === 'web' && fetchSite && fetchSite !== 'same-origin') return res.status(204).end();
  const path = clean(req.body?.path, 300);
  if (!path.startsWith('/') || path.startsWith('/owner-dashboard') || path.startsWith('/support-admin')) return res.status(204).end();
  const payload = {
    path,
    referrer_host: channel === 'web' ? (clean(req.body?.referrer_host, 200) || null) : null,
    device_type: channel === 'app' ? (req.body?.platform === 'android' ? 'android' : 'ios') : deviceType(req.headers['user-agent']),
    channel,
  };
  try {
    await rest('traffic_pageviews', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(payload) });
  } catch (error) {
    console.error('Analytics event failed', error?.message || error);
  }
  return res.status(204).end();
}

function locationParts(value) {
  const location = clean(value, 160);
  const postalCode = location.match(/\b\d{5}(?:-\d{4})?\b/)?.[0] || '';
  const parts = location.replace(postalCode, '').split(',').map((part) => part.trim()).filter(Boolean);
  const stateMatch = (parts[1] || '').match(/\b[A-Za-z]{2}\b/);
  return { city: parts[0] || '', state: stateMatch?.[0]?.toUpperCase() || '', postal_code: postalCode };
}

export function buildAccountDirectory(profiles = [], jobs = [], subscriptions = []) {
  const latestJobByOwner = new Map();
  [...jobs].sort((a, b) => Date.parse(b.created_at || '') - Date.parse(a.created_at || '')).forEach((job) => {
    if (job.owner_id && !latestJobByOwner.has(job.owner_id)) latestJobByOwner.set(job.owner_id, job);
  });
  const subscriptionByUser = new Map(subscriptions.map((subscription) => [subscription.user_id, subscription]));
  return profiles.filter((profile) => ['barista', 'cafe_owner_manager'].includes(profile.role)).map((profile) => {
    const parsed = locationParts(profile.location);
    const latestJob = latestJobByOwner.get(profile.id) || {};
    const isCafe = profile.role === 'cafe_owner_manager';
    const subscription = isCafe ? subscriptionByUser.get(profile.id) : null;
    return {
      user_id: profile.id,
      role: profile.role,
      name: clean(isCafe ? (profile.cafe_name || profile.display_name || 'Unnamed café') : (profile.display_name || 'Unnamed barista'), 160),
      city: clean(isCafe ? (latestJob.city || parsed.city) : (profile.preferred_city || parsed.city), 80),
      state: clean(isCafe ? (latestJob.state || parsed.state) : (profile.preferred_state || parsed.state), 2).toUpperCase(),
      postal_code: clean(isCafe ? (latestJob.postal_code || parsed.postal_code) : (profile.preferred_postal_code || parsed.postal_code), 10),
      created_at: profile.created_at || null,
      subscription: isCafe ? {
        exists: Boolean(subscription),
        status: subscription?.status || 'none',
        complimentary_access: Boolean(subscription?.complimentary_access),
        connected_to_billing: Boolean(subscription?.stripe_subscription_id),
        owner_paused_at: subscription?.owner_paused_at || null,
        pause_supported: Boolean(subscription && Object.prototype.hasOwnProperty.call(subscription, 'owner_paused_at')),
      } : null,
    };
  }).sort((a, b) => Date.parse(b.created_at || '') - Date.parse(a.created_at || ''));
}

async function report(req, res) {
  if (!process.env.SUPABASE_PUBLISHABLE_KEY || !await owner(req)) return res.status(403).json({ error: 'Owner access required' });
  try {
    const rpcNames = ['owner_business_analytics', 'owner_subscription_analytics', 'owner_membership_controls', 'owner_demographic_analytics'];
    const [rpcResponses, profilesResponse, jobsResponse, subscriptionRowsResponse] = await Promise.all([
      Promise.all(rpcNames.map((name) => fetch(`${process.env.SUPABASE_URL}/rest/v1/rpc/${name}`, { method: 'POST', headers: serverHeaders(), body: '{}' }))),
      rest('profiles?select=id,role,display_name,cafe_name,location,preferred_city,preferred_state,preferred_postal_code,created_at&role=in.(barista,cafe_owner_manager)&order=created_at.desc&limit=1000'),
      rest('jobs?select=owner_id,city,state,postal_code,created_at&order=created_at.desc&limit=1000'),
      rest('cafe_subscriptions?select=*&order=created_at.desc&limit=1000'),
    ]);
    const responses = [...rpcResponses, profilesResponse, subscriptionRowsResponse];
    if (responses.some((response) => !response.ok)) throw new Error(`Analytics query failed (${responses.map((response) => response.status).join('/')})`);
    const [business, subscriptions, controls, demographics] = await Promise.all(rpcResponses.map((response) => response.json()));
    const [profiles, jobs, subscriptionRows] = await Promise.all([
      profilesResponse.json(),
      jobsResponse.ok ? jobsResponse.json() : Promise.resolve([]),
      subscriptionRowsResponse.json(),
    ]);
    const subscriptionByUser = new Map(subscriptionRows.map((row) => [row.user_id, row]));
    const subscriptionAccounts = (controls.accounts || []).map((account) => ({
      ...account,
      owner_paused_at: subscriptionByUser.get(account.user_id)?.owner_paused_at || null,
    }));
    const activeComplimentary = subscriptionRows.filter((row) => row.complimentary_access && !row.owner_paused_at).length;
    return res.status(200).json({
      ...business,
      demographics,
      account_directory: buildAccountDirectory(profiles, jobs, subscriptionRows),
      subscriptions: {
        ...subscriptions,
        ...controls,
        accounts: subscriptionAccounts,
        metrics: { ...subscriptions.metrics, complimentary: activeComplimentary },
      },
    });
  } catch (error) {
    console.error('Owner analytics failed', error?.message || error);
    return res.status(500).json({ error: 'Could not load business analytics' });
  }
}

async function access(req, res) {
  if (!process.env.SUPABASE_PUBLISHABLE_KEY || !await owner(req)) return res.status(403).end();
  return res.status(204).end();
}

async function membership(req, res) {
  if (!process.env.SUPABASE_PUBLISHABLE_KEY || !await owner(req)) return res.status(403).json({ error: 'Owner access required' });
  if (req.body?.action !== 'set_cafe_subscription_access' || typeof req.body?.enabled !== 'boolean') {
    return res.status(400).json({ error: 'Invalid subscription action' });
  }
  const userId = clean(req.body?.user_id, 80);
  if (!/^[0-9a-f-]{36}$/i.test(userId)) return res.status(400).json({ error: 'Invalid café account' });
  try {
    const currentResponse = await rest(`cafe_subscriptions?user_id=eq.${encodeURIComponent(userId)}&select=*&limit=1`);
    if (!currentResponse.ok) return res.status(500).json({ error: 'Could not check café access' });
    const current = (await currentResponse.json())[0];
    if (!current) return res.status(404).json({ error: 'Café subscription not found' });
    if (!Object.prototype.hasOwnProperty.call(current, 'owner_paused_at')) {
      return res.status(503).json({ error: 'The reviewed subscription-pause update must be applied before this control can be used.' });
    }
    if (current.stripe_subscription_id) {
      return res.status(409).json({ error: 'This café has Stripe billing. Pause payment collection in Stripe before changing platform access.' });
    }
    if (req.body.enabled && !current.owner_paused_at) {
      return res.status(409).json({ error: 'This café subscription was not paused by the owner.' });
    }
    if (!req.body.enabled && !current.complimentary_access) {
      return res.status(409).json({ error: 'Only complimentary café access can be paused here.' });
    }
    const ownerPausedAt = req.body.enabled ? null : (current.owner_paused_at || new Date().toISOString());
    const values = req.body.enabled ? { owner_paused_at: null, complimentary_access: true } : { owner_paused_at: ownerPausedAt };
    const updateResponse = await rest(`cafe_subscriptions?user_id=eq.${encodeURIComponent(userId)}&select=user_id,status,complimentary_access,owner_paused_at`, {
      method: 'PATCH',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify(values),
    });
    if (!updateResponse.ok) return res.status(500).json({ error: 'Could not update café access' });
    const updated = await updateResponse.json();
    if (updated.length !== 1) return res.status(404).json({ error: 'Café subscription not found' });
    return res.status(200).json({
      success: true,
      complimentary_access: Boolean(updated[0].complimentary_access),
      owner_paused_at: updated[0].owner_paused_at || null,
    });
  } catch (error) {
    console.error('Owner café access update failed', error?.message || error);
    return res.status(500).json({ error: 'Could not update café access' });
  }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SECRET_KEY) {
    return req.method === 'POST' ? res.status(204).end() : res.status(503).json({ error: 'Analytics unavailable' });
  }
  if (req.method === 'POST') return record(req, res);
  if (req.method === 'HEAD') return access(req, res);
  if (req.method === 'GET') return report(req, res);
  if (req.method === 'PATCH') return membership(req, res);
  res.setHeader('Allow', 'GET, HEAD, POST, PATCH');
  return res.status(405).end();
}
