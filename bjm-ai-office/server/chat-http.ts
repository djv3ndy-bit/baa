import { getChatRuntime } from './chat-runtime.mjs';

export type RuntimeProvider = () => ReturnType<typeof getChatRuntime> | Promise<Awaited<ReturnType<typeof getChatRuntime>>>;

export function privateResponseHeaders(res: any) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
}

export function privateServiceUnavailable(res: any) {
  if (!res.headersSent) return res.status(503).json({ error: 'temporarily_unavailable', error_description: 'Office is temporarily unavailable.' });
}

export function createOAuthRouteHandler(action: 'authorize' | 'ownerCallback' | 'token' | 'revoke', method: 'GET' | 'POST', getRuntime: RuntimeProvider = getChatRuntime) {
  return async (req: any, res: any) => {
    privateResponseHeaders(res);
    if (String(req.method || '').toUpperCase() !== method) {
      res.setHeader('Allow', method);
      return res.status(405).json({ error: 'invalid_request', error_description: 'The method is not supported.' });
    }
    try {
      const { oauth } = await getRuntime();
      await oauth[action](req, res);
    } catch {
      return privateServiceUnavailable(res);
    }
  };
}
