import { cafeForConversation, conversationForUser, userRequest } from './_application-conversation.js';
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return res.status(405).json({ error: 'Method not allowed.' }); }
  const applicationId = req.query?.application_id;
  if (typeof applicationId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(applicationId)) return res.status(400).json({ error: 'Conversation is unavailable.' });
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) return res.status(401).json({ error: 'Please sign in again.' });
  try {
    const auth = await userRequest('/auth/v1/user', token);
    if (auth.status >= 500) throw new Error('Authentication unavailable');
    if (!auth.ok) return res.status(401).json({ error: 'Please sign in again.' });
    const user = await auth.json();
    if (!user?.id) return res.status(401).json({ error: 'Please sign in again.' });
    const app = await conversationForUser(applicationId, user.id, token);
    if (!app) return res.status(403).json({ error: 'This conversation is not available.' });
    return res.status(200).json({ cafe: await cafeForConversation(app), job: { id: app.job.id, title: app.job.title } });
  } catch {
    return res.status(502).json({ error: 'Could not load this conversation. Please try again.' });
  }
}
