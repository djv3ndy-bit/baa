const headers = (token) => ({ apikey: process.env.SUPABASE_PUBLISHABLE_KEY, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });
export async function userRequest(path, token, options = {}) {
  return fetch(`${process.env.SUPABASE_URL}${path}`, { ...options, headers: { ...headers(token), ...options.headers }, signal: AbortSignal.timeout(10000) });
}
async function adminRows(path) {
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!key) throw new Error('Conversation service unavailable');
  const response = await fetch(`${process.env.SUPABASE_URL}/rest/v1/${path}`, { headers: { apikey: key, ...(key.startsWith('sb_secret_') ? {} : { Authorization: `Bearer ${key}` }) }, signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error('Conversation lookup failed');
  const rows = await response.json();
  if (!Array.isArray(rows)) throw new Error('Conversation lookup failed');
  return rows;
}
export async function conversationForUser(applicationId, userId, token) {
  const response = await userRequest(`/rest/v1/applications?id=eq.${encodeURIComponent(applicationId)}&select=id,status,job_id,barista_id,job:jobs!applications_job_id_fkey(id,title,owner_id)`, token);
  if (!response.ok) throw new Error('Conversation lookup failed');
  const app = (await response.json())[0];
  // Establish membership under the caller's RLS before any privileged lookup.
  if (!app || app.status !== 'matched' || ![app.barista_id, app.job?.owner_id].includes(userId)) return null;
  if (!app.job) {
    if (!app.job_id) return null;
    app.job = (await adminRows(`jobs?id=eq.${encodeURIComponent(app.job_id)}&select=id,title,owner_id&limit=1`))[0];
  }
  if (!app.job?.owner_id) return null;
  const pair = [app.barista_id, app.job.owner_id].map(encodeURIComponent).join(',');
  const blocks = await adminRows(`user_blocks?blocker_id=in.(${pair})&blocked_id=in.(${pair})&select=blocker_id&limit=1`);
  if (blocks.length) return null;
  return app;
}
export async function cafeForConversation(app) {
  const cafe = (await adminRows(`profiles?id=eq.${encodeURIComponent(app.job.owner_id)}&select=id,cafe_name,display_name&limit=1`))[0];
  return { id: app.job.owner_id, name: cafe?.cafe_name || cafe?.display_name || 'Café' };
}
