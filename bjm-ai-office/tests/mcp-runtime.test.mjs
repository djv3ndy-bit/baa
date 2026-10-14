import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createOfficeMcpServer } from '../server/mcp.ts';

const snapshot = {
  schema_version: 1, generated_at: new Date().toISOString(),
  metrics: { profiles: 2, cafes: 1, baristas: 1, jobs: 3, applications: 4, subscriptions: 1, payments: 2 },
  support: { total_recent: 3, open: 1 },
  billing: { subscriptions: { total: 1, active: 1, past_due: 0, canceling: 0 }, payments: { recent: 2, failed: 0, refunded: 0 } },
};
const OWNER_REQUEST_TOKEN = 'e30.e30.MOCK_TOKEN';

async function connect(token, options) {
  const server = createOfficeMcpServer(token, options);
  const client = new Client({ name: 'office-offline-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, close: async () => { await client.close(); await server.close(); } };
}

test('all five tools execute through the MCP SDK with one aggregate read and no credential disclosure', async () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = { ...process.env };
  const requests = [];
  process.env.SUPABASE_URL = 'https://project.example';
  process.env.SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_test';
  process.env.BJM_OFFICE_BASE_URL = 'https://office.example';
  delete process.env.SUPABASE_SECRET_KEY;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), init });
    if (init?.method === 'HEAD') return new Response(null, { status: 200 });
    assert.equal(String(url), 'https://project.example/rest/v1/rpc/office_read_snapshot');
    assert.equal(init.method, 'POST');
    assert.equal(init.redirect, 'error');
    assert.equal(init.headers.Authorization, `Bearer ${OWNER_REQUEST_TOKEN}`);
    return Response.json({ ...snapshot, customer_email: 'private@example.test' });
  };
  let session;
  try {
    session = await connect(OWNER_REQUEST_TOKEN);
    const { tools } = await session.client.listTools();
    assert.deepEqual(tools.map(t => t.name).sort(), ['get_ai_team_status', 'get_billing_summary', 'get_decision_queue', 'get_owner_overview', 'get_system_health']);
    for (const tool of tools) {
      assert.equal(tool.annotations.readOnlyHint, true);
      assert.equal(tool.annotations.destructiveHint, false);
      assert.deepEqual(tool._meta.securitySchemes, [{ type: 'oauth2', scopes: ['office.read'] }]);
      assert.equal(tool._meta.ui, undefined);
      assert.equal(tool._meta['openai/outputTemplate'], undefined);
      const result = await session.client.callTool({ name: tool.name, arguments: {} });
      assert.ok(result.structuredContent);
      assert.notEqual(result.isError, true, tool.name);
      assert.doesNotMatch(JSON.stringify(result), /MOCK_TOKEN|private@example\.test|sb_publishable_test/);
      if (tool.name === 'get_billing_summary') assert.equal(result.structuredContent.billing.subscriptions.active, 1);
      if (tool.name === 'get_owner_overview') assert.equal(result.structuredContent.business.metrics.profiles, 2);
    }
    assert.equal(requests.filter(r => r.init.method === 'POST').length, 1);
    assert.equal(session.client.getServerCapabilities().resources, undefined);
    assert.match(session.client.getInstructions(), /BJM AI Team works in this chat on request/);
    assert.doesNotMatch(session.client.getInstructions(), /MOCK_TOKEN/);
  } finally {
    await session?.close();
    globalThis.fetch = originalFetch;
    process.env = originalEnv;
  }
});

test('unconfigured read tools report unavailable metrics, while the registry remains descriptive', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    assert.equal(init?.method, 'HEAD', 'missing owner token must never make a database request');
    return new Response(null, { status: 503 });
  };
  let session;
  try {
    session = await connect();
    const billing = await session.client.callTool({ name: 'get_billing_summary', arguments: {} });
    assert.equal(billing.structuredContent.billing.subscriptions.active, null);
    assert.equal(billing.structuredContent.billing.payments.failed, null);
    const team = await session.client.callTool({ name: 'get_ai_team_status', arguments: {} });
    assert.equal(team.structuredContent.agents.length, 19);
    assert.ok(team.structuredContent.agents.every(agent => agent.status === 'registered'));
  } finally { await session?.close(); globalThis.fetch = originalFetch; }
});
