import express from 'express';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMcpHandler } from '../api/mcp.js';
import protectedResourceHandler from '../api/oauth-protected-resource.js';
import authorizationMetadataHandler from '../api/oauth-authorization-server.js';
import healthHandler from '../api/health.js';
import { createOAuthRouteHandler, privateResponseHeaders, type RuntimeProvider } from './chat-http.js';
import { getChatRuntime } from './chat-runtime.mjs';

export function createChatApp(getRuntime: RuntimeProvider = getChatRuntime) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '16kb' }));
  app.use(express.urlencoded({ extended: false, limit: '16kb', parameterLimit: 32 }));

  // Discovery and interactive OAuth routes precede the private MCP boundary.
  app.all('/.well-known/oauth-protected-resource', protectedResourceHandler);
  app.all('/.well-known/oauth-protected-resource/mcp', protectedResourceHandler);
  app.all('/.well-known/oauth-authorization-server', authorizationMetadataHandler);
  app.all('/oauth/authorize', createOAuthRouteHandler('authorize', 'GET', getRuntime));
  app.all('/oauth/token', createOAuthRouteHandler('token', 'POST', getRuntime));
  app.all('/oauth/revoke', createOAuthRouteHandler('revoke', 'POST', getRuntime));
  app.all('/oauth/owner/callback', createOAuthRouteHandler('ownerCallback', 'GET', getRuntime));
  app.all('/mcp', createMcpHandler(getRuntime));

  // Public liveness only; this handler never initializes private providers.
  app.all('/health', healthHandler);
  app.use((_req, res) => {
    privateResponseHeaders(res);
    res.status(404).json({ error: 'Not found.' });
  });
  app.use((error: any, _req: any, res: any, _next: any) => {
    if (res.headersSent) { res.end(); return; }
    privateResponseHeaders(res);
    res.status(error?.type === 'entity.too.large' ? 413 : 400).json({ error: 'Invalid request.' });
  });
  return app;
}

const app = createChatApp();
if (!process.env.VERCEL && process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 8787);
  app.listen(port, () => console.log('BJM AI chat connection server ready.'));
}
export default app;
