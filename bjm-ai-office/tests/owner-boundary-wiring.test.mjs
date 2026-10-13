import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
const source = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
for (const path of ['api/mcp.ts', 'server/index.ts']) {
  test(`${path} requires owner before constructing or invoking MCP`, () => {
    const text = source(path);
    const validation = text.indexOf('const owner = await requireOfficeOwner(req, res);');
    const gate = text.indexOf('if (!owner) return;');
    assert.ok(validation > 0 && validation < gate);
    assert.ok(gate < text.indexOf('const server = createOfficeMcpServer(owner.accessToken)'));
    assert.ok(gate < text.indexOf('transport.handleRequest('));
  });
}
test('public health never invokes private providers', () => {
  assert.doesNotMatch(source('api/health.ts'), /getSystemHealth|providers\./);
  const healthBody = source('server/index.ts').split("app.get('/health'")[1].split('if (!process.env.VERCEL)')[0];
  assert.doesNotMatch(healthBody, /getSystemHealth|SUPABASE|notionConfigured/);
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
