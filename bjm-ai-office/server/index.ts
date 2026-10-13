import express from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createOfficeMcpServer } from './mcp.js';
import { protectedResourceMetadata, requireOfficeOwner } from './owner-auth.mjs';

const app = express();
app.use(express.json({ limit: '1mb' }));

app.get('/.well-known/oauth-protected-resource', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try { res.json(protectedResourceMetadata()); }
  catch { res.status(503).json({ error: 'Office authentication is not configured' }); }
});

app.all('/mcp', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (!['GET', 'POST', 'DELETE'].includes(req.method)) {
    res.setHeader('Allow', 'GET, POST, DELETE');
    return res.status(405).json({ error: 'Method not allowed.' });
  }
  const owner = await requireOfficeOwner(req, res);
  if (!owner) return;

  const server = createOfficeMcpServer(owner.accessToken);
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
  } catch {
    console.error('BJM AI Office MCP request failed');
    if (!res.headersSent) res.status(500).json({ error: 'MCP request failed.' });
  } finally {
    if (res.writableEnded) await close();
  }
});

// Public liveness only. Provider/business health belongs behind owner authentication.
app.get('/health', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ ok: true, app: 'bjm-ai-office', status: 'process_reachable' });
});

if (!process.env.VERCEL) {
  const port = Number(process.env.PORT || 8787);
  app.listen(port, () => console.log(`BJM AI Office MCP server ready on ${port}`));
}
export default app;
