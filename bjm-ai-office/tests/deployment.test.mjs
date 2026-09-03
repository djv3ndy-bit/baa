import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('Vercel routes expose /mcp and /health without touching the customer project', () => {
  const config = JSON.parse(read('vercel.json'));
  assert.deepEqual(config.rewrites, [
    { source: '/mcp', destination: '/api/mcp' },
    { source: '/health', destination: '/api/health' },
  ]);
  assert.equal(config.functions['api/mcp.ts'].maxDuration, 60);
});

test('Vercel MCP endpoint is stateless and has no autonomous business actions', () => {
  const source = read('api/mcp.ts');
  assert.match(source, /sessionIdGenerator:\s*undefined/);
  assert.doesNotMatch(source, /refund|charge customer|delete user|publish/i);
});

test('widget resource uses a deployment-aware absolute asset URL', () => {
  const source = read('server/mcp.ts');
  assert.match(source, /VERCEL_URL/);
  assert.match(source, /new URL\('\/assets\/office\.js'/);
  assert.match(source, /resourceDomains/);
});

test('private Office project has a deterministic widget build', () => {
  const vite = read('vite.config.ts');
  assert.match(vite, /entryFileNames:\s*'assets\/office\.js'/);
});
