import { protectedResourceMetadata } from '../server/chat-owner-auth.mjs';
import { privateResponseHeaders, privateServiceUnavailable } from '../server/chat-http.js';

export default function handler(req: any, res: any) {
  privateResponseHeaders(res);
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed.' });
  }
  try { return res.status(200).json(protectedResourceMetadata()); }
  catch { return privateServiceUnavailable(res); }
}
