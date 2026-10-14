import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createOfficeMcpServer } from '../server/mcp.js';
import { requireChatOfficeOwner } from '../server/chat-owner-auth.mjs';
import { getChatRuntime } from '../server/chat-runtime.mjs';
import { createChatOfficeProviders } from '../server/chat-data.mjs';
import { privateResponseHeaders, privateServiceUnavailable, type RuntimeProvider } from '../server/chat-http.js';

export const config = { maxDuration: 60 };

export function createMcpHandler(getRuntime: RuntimeProvider = getChatRuntime) {
  return async function handler(req: any, res: any) {
    privateResponseHeaders(res);
    if (!['GET', 'POST', 'DELETE'].includes(String(req.method || '').toUpperCase())) {
      res.setHeader('Allow', 'GET, POST, DELETE');
      return res.status(405).json({ error: 'Method not allowed.' });
    }
    let close: (() => Promise<void>) | undefined;
    try {
      let runtime: Awaited<ReturnType<typeof getChatRuntime>> | undefined;
      // The owner gate checks public discovery, origin and credential syntax
      // before consulting verification. Anonymous discovery must not open a
      // database pool or depend on private OAuth activation/configuration.
      const oauth = {
        verifyAccessToken: async (accessToken: string) => {
          runtime = await getRuntime();
          return runtime.oauth.verifyAccessToken(accessToken);
        },
      } as Awaited<ReturnType<typeof getChatRuntime>>['oauth'];
      const owner = await requireChatOfficeOwner(req, res, { oauth });
      if (!owner) return;
      const { store } = runtime ?? await getRuntime();
      const providers = createChatOfficeProviders(owner, { store });
      const server = createOfficeMcpServer(undefined, { providers });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      let closed = false;
      close = async () => {
        if (closed) return;
        closed = true;
        try { await transport.close(); } catch {}
        try { await server.close(); } catch {}
      };
      res.on('close', close);
      await server.connect(transport);
      await transport.handleRequest(req, res, req.method === 'POST' ? req.body : undefined);
    } catch {
      return privateServiceUnavailable(res);
    } finally {
      if (res.writableEnded) await close?.();
    }
  };
}

export default createMcpHandler();
