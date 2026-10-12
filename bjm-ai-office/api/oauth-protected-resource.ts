import { protectedResourceMetadata } from '../server/owner-auth.mjs';

export default function handler(req: any, res: any) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed.' });
  }
  try { return res.status(200).json(protectedResourceMetadata()); }
  catch { return res.status(503).json({ error: 'Office authentication is not configured' }); }
}
