import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createOfficeMcpServer } from '../server/mcp.js';

export const config = { maxDuration: 60 };

export default async function handler(req: any, res: any) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  if (!['GET', 'POST', 'DELETE'].includes(String(req.method || '').toUpperCase())) {
    res.setHeader('Allow', 'GET, POST, DELETE');
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  const server = createOfficeMcpServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    try { await transport.close(); } catch {}
    try { await server.close(); } catch {}
  };
  res.on('close', close);

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.method === 'POST' ? req.body : undefined);
  } catch (error) {
    console.error('BJM AI Office Vercel MCP request failed', error);
    if (!res.headersSent) res.status(500).json({ error: 'MCP request failed.' });
  } finally {
    if (res.writableEnded) await close();
  }
}
