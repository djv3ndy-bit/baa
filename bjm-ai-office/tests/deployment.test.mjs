import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('Vercel routes expose MCP, liveness, and OAuth discovery without touching the customer project', () => {
  const config = JSON.parse(read('vercel.json'));
  assert.deepEqual(config.rewrites, [
    { source: '/mcp', destination: '/api/mcp' },
    { source: '/health', destination: '/api/health' },
    { source: '/.well-known/oauth-protected-resource', destination: '/api/oauth-protected-resource' },
    { source: '/.well-known/oauth-protected-resource/mcp', destination: '/api/oauth-protected-resource' },
    { source: '/.well-known/oauth-authorization-server', destination: '/api/oauth-authorization-server' },
    { source: '/oauth/authorize', destination: '/api/oauth-authorize' },
    { source: '/oauth/token', destination: '/api/oauth-token' },
    { source: '/oauth/revoke', destination: '/api/oauth-revoke' },
    { source: '/oauth/owner/callback', destination: '/api/owner-callback' },
  ]);
  assert.equal(config.functions['api/mcp.ts'].maxDuration, 60);
  assert.equal(config.framework, null);
  assert.equal(config.buildCommand, 'pnpm run build:chat');
  assert.equal(config.outputDirectory, 'dist-chat');
});

test('Vercel MCP endpoint is stateless and has no autonomous business actions', () => {
  const source = read('api/mcp.ts');
  assert.match(source, /sessionIdGenerator:\s*undefined/);
  assert.doesNotMatch(source, /refund|charge customer|delete user|publish/i);
});

test('chat MCP has no widget resource or automatic UI linkage', () => {
  const source = read('server/mcp.ts');
  assert.doesNotMatch(source, /registerResource|outputTemplate|resourceUri|widgetHtml/);
  assert.match(source, /instructions:\s*teamWorkflowInstructions\(\)/);
});

test('private Office project has a deterministic widget build', () => {
  const vite = read('vite.config.ts');
  assert.match(vite, /entryFileNames:\s*'assets\/office\.js'/);
});
