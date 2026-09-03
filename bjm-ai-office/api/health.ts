import { getSystemHealth } from '../server/providers.js';

export const config = { maxDuration: 10 };

export default async function handler(req: any, res: any) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed.' });
  }
  try {
    return res.status(200).json({ ok: true, app: 'bjm-ai-office', version: '0.3.0', health: await getSystemHealth() });
  } catch (error) {
    console.error('BJM AI Office health check failed', error);
    return res.status(503).json({ ok: false, app: 'bjm-ai-office', error: 'Health check failed.' });
  }
}
