import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
const source = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
test('hosted and local entrypoints share the opaque Office boundary without importing legacy JWT authorization', () => {
  assert.match(source('api/mcp.ts'), /chat-owner-auth\.mjs/);
  assert.match(source('server/index.ts'), /createMcpHandler/);
  for(const path of ['api/mcp.ts','server/index.ts']) assert.doesNotMatch(source(path), /from ['"][^'"]*\/owner-auth\.mjs/);
});
test('public health never invokes private providers', () => {
  assert.doesNotMatch(source('api/health.ts'), /getSystemHealth|providers\./);
  assert.match(source('server/index.ts'), /app\.all\('\/health', healthHandler\)/);
  assert.doesNotMatch(source('api/health.ts'), /getChatRuntime|chat-data|SUPABASE|notionConfigured/);
});
test('read-only factory registers only five read tools and no Notion writes', () => {
  const text = source('server/mcp.ts');
  const names = [...text.matchAll(/server\.registerTool\('([^']+)'/g)].map(match => match[1]);
  assert.deepEqual(names.sort(), ['get_ai_team_status','get_billing_summary','get_decision_queue','get_owner_overview','get_system_health']);
  assert.doesNotMatch(text, /createNotionAgentTask|readOnlyHint:\s*false/);
});
test('both protected-resource discovery paths are routed', () => {
  const config = JSON.parse(source('vercel.json'));
  for (const path of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
    assert.ok(config.rewrites.some(rule => rule.source === path && rule.destination === '/api/oauth-protected-resource'));
  }
});
