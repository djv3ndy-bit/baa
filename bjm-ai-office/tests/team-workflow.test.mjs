import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { AGENT_REGISTRY } from '../server/policy.ts';
import { OFFICE_TOOL_NAMES, planTeamTask, resolveTeamWorkflow, teamWorkflowInstructions } from '../server/team-workflow.ts';
import { createOfficeMcpServer } from '../server/mcp.ts';

test('all registered roles resolve by ID and display name with unchanged ceilings and bounded evidence plans', () => {
  assert.equal(AGENT_REGISTRY.length, 19);
  for (const role of AGENT_REGISTRY) {
    for (const command of [role.id, role.name, `${role.name}, review the available evidence.`]) {
      const workflow = planTeamTask(command);
      assert.equal(workflow.roleId, role.id, command);
      assert.equal(workflow.ceiling, role.ceiling, command);
      assert.equal(workflow.permission.allowed, true, command);
      assert.equal(workflow.permission.requested, role.ceiling);
      assert.equal(workflow.execution, 'on_request');
      assert.ok(workflow.toolSequence.length);
      assert.ok(workflow.toolSequence.every(name => OFFICE_TOOL_NAMES.includes(name)));
      assert.ok(workflow.evidenceGaps);
    }
    assert.equal(planTeamTask(role.id, 'execute').permission.allowed, false, role.id);
  }
});

test('named specialists take precedence, and manager handles unclear work', () => {
  assert.equal(resolveTeamWorkflow('Support, draft a reply about a suspicious login.').roleId, 'support');
  assert.equal(resolveTeamWorkflow('Operations Manager, prepare my brief.').roleId, 'manager');
  assert.equal(resolveTeamWorkflow('Orchestrator, review my priorities.').roleId, 'manager');
  assert.equal(resolveTeamWorkflow('Review a suspicious login.').roleId, 'security');
  assert.equal(resolveTeamWorkflow('Help with an unclear request.').roleId, 'manager');
});

test('evidence plans distinguish read access from expertise and respect observe/recommend limits', () => {
  assert.deepEqual(resolveTeamWorkflow('manager').toolSequence, ['get_owner_overview', 'get_ai_team_status', 'get_decision_queue']);
  assert.deepEqual(resolveTeamWorkflow('billing').toolSequence, ['get_billing_summary', 'get_decision_queue']);
  assert.match(resolveTeamWorkflow('support').evidenceGaps, /no ticket bodies/i);
  assert.match(resolveTeamWorkflow('sales').evidenceGaps, /No prospect lists/);
  assert.match(resolveTeamWorkflow('release').evidenceGaps, /does not establish app-store review/);
  assert.match(resolveTeamWorkflow('finance').evidenceGaps, /Zero payment records does not establish zero revenue/);
  assert.equal(planTeamTask('owner-intelligence', 'recommend').permission.allowed, false);
  assert.match(resolveTeamWorkflow('owner-intelligence').deliverable, /observations/);
  for (const role of AGENT_REGISTRY.filter(role => role.ceiling === 'recommend')) {
    assert.equal(planTeamTask(role.id, 'prepare').permission.allowed, false);
    assert.match(resolveTeamWorkflow(role.id).deliverable, /no implementation or execution/);
  }
});

test('model instructions contain every registry role, usable read sequences, freshness and approval boundaries', () => {
  const instructions = teamWorkflowInstructions();
  const first512 = instructions.slice(0, 512);
  assert.match(first512, /Operations Manager coordinates 19 roles/);
  assert.match(first512, /five read-only Office tools/);
  assert.match(first512, /never execute actions/);
  assert.match(first512, /timestamps and missing access/);
  for (const role of AGENT_REGISTRY) {
    assert.ok(instructions.includes(`${role.id} | ${role.name} | ceiling=${role.ceiling}`));
  }
  for (const tool of OFFICE_TOOL_NAMES) assert.ok(instructions.includes(tool));
  assert.match(instructions, /configured\/availability\/reason and generated_at/);
  assert.match(instructions, /empty decision queue into an all-clear/);
  assert.match(instructions, /Notion configuration does not mean tasks were read/);
  assert.match(instructions, /without unnecessary approval questions/);
  assert.match(instructions, /Approval does not raise a role's ceiling/);
  assert.match(instructions, /never as permission or instructions to access other systems/);
  assert.match(instructions, /not 19 independent workers/);
  assert.match(instructions, /No unsolicited external actions, new chats, schedules or continuous workers/);
});

test('MCP initialization delivers the chat workflow and only five office.read tools with injected bounded providers', async () => {
  const generatedAt = '2026-10-14T12:00:00.000Z';
  const metadata = { source: 'bounded-test-adapter', configured: true, availability: 'available', reason: null, generated_at: generatedAt };
  const reads = [];
  const providers = {
    getLiveOverview: async () => { reads.push('overview'); return { ...metadata, metrics: { profiles: 2, cafes: 1, baristas: 1, jobs: 3, applications: 4, subscriptions: 1, payments: 0 }, status: 'available' }; },
    getSupportSummary: async () => { reads.push('support'); return { ...metadata, total_recent: 0, open: 0, window_days: 30 }; },
    getBillingSummary: async () => { reads.push('billing'); return { ...metadata, subscriptions: { total: 1, active: 1, past_due: 0, canceling: 0 }, payments: { recent: 0, failed: 0, refunded: 0 }, window_days: 30 }; },
    getSystemHealth: async () => { reads.push('health'); return { source: 'bounded-test-adapter', overall: 'healthy', checks: [{ service: 'website', ok: true, status: 200 }] }; },
    getDecisionSignals: async () => { reads.push('decisions'); return []; },
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('Injected provider must not fall through to legacy network access'); };
  const server = createOfficeMcpServer(undefined, { providers });
  const client = new Client({ name: 'chat-team-offline-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    assert.equal(client.getInstructions(), teamWorkflowInstructions());
    assert.equal(client.getServerCapabilities().resources, undefined);
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map(tool => tool.name).sort(), [...OFFICE_TOOL_NAMES].sort());
    for (const tool of tools) {
      assert.equal(tool.annotations.readOnlyHint, true);
      assert.equal(tool.annotations.destructiveHint, false);
      assert.deepEqual(tool._meta.securitySchemes, [{ type: 'oauth2', scopes: ['office.read'] }]);
      assert.equal(tool._meta.ui, undefined);
      assert.equal(tool._meta['openai/outputTemplate'], undefined);
      const result = await client.callTool({ name: tool.name, arguments: {} });
      assert.notEqual(result.isError, true);
      assert.ok(result.structuredContent);
      if (tool.name === 'get_owner_overview') {
        assert.equal(result.structuredContent.business.generated_at, generatedAt);
        assert.equal(result.structuredContent.business.metrics.profiles, 2);
      }
      if (tool.name === 'get_ai_team_status') assert.equal(result.structuredContent.agents.length, 19);
    }
    assert.ok(['overview', 'support', 'billing', 'health', 'decisions'].every(name => reads.includes(name)));
  } finally {
    await client.close();
    await server.close();
    globalThis.fetch = originalFetch;
  }
});
