import { chatAuthorizationMetadata } from '../server/chat-oauth.mjs';
import { privateResponseHeaders, privateServiceUnavailable } from '../server/chat-http.js';

export default function handler(req: any, res: any) {
  privateResponseHeaders(res);
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed.' });
  }
  try { return res.status(200).json(chatAuthorizationMetadata()); }
  catch { return privateServiceUnavailable(res); }
}
