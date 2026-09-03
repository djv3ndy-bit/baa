import express from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createOfficeMcpServer } from './mcp.js';
import { getSystemHealth } from './providers.js';

const app = express();
app.use(express.json({ limit: '1mb' }));

app.all('/mcp', async (req, res) => {
  if (!['GET', 'POST', 'DELETE'].includes(req.method)) {
    res.setHeader('Allow', 'GET, POST, DELETE');
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  const server = createOfficeMcpServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  const close = async () => {
    try { await transport.close(); } catch {}
    try { await server.close(); } catch {}
  };
  res.on('close', close);

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.method === 'POST' ? req.body : undefined);
  } catch (error) {
    console.error('BJM AI Office MCP request failed', error);
    if (!res.headersSent) res.status(500).json({ error: 'MCP request failed.' });
  }
});

app.get('/health', async (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ ok: true, app: 'bjm-ai-office', version: '0.3.0', health: await getSystemHealth() });
});

if (!process.env.VERCEL) {
  const port = Number(process.env.PORT || 8787);
  app.listen(port, () => console.log(`BJM AI Office MCP server ready on ${port}`));
}

export default app;
