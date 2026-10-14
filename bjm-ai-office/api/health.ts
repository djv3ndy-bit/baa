export const config = { maxDuration: 10 };

// Public liveness only; never call private providers from this route.
export default function handler(req: any, res: any) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed.' });
  }
  return res.status(200).json({ ok: true, app: 'bjm-ai-office', status: 'process_reachable' });
}
