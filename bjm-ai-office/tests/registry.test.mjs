import test from 'node:test';
import assert from 'node:assert/strict';
import { tsImport } from 'tsx/esm/api';

const { AGENT_REGISTRY, permissionDecision, routeAgentFor, teamSnapshot } = await tsImport('../server/policy.ts', import.meta.url);

test('actual registry contains all 19 V1 operating roles without execution authority', () => {
  assert.equal(AGENT_REGISTRY.length, 19);
  assert.equal(new Set(AGENT_REGISTRY.map(agent => agent.id)).size, 19);
  for (const agent of AGENT_REGISTRY) assert.notEqual(agent.ceiling, 'execute');
});

test('actual orchestrator routes representative events', () => {
  assert.equal(routeAgentFor('production API failure on jobs'), 'engineering');
  assert.equal(routeAgentFor('suspicious login security alert'), 'security');
  assert.equal(routeAgentFor('database query is slow'), 'data');
  assert.equal(routeAgentFor('database schema migration'), 'data');
  assert.equal(routeAgentFor('SEO sitemap indexing issue'), 'seo');
  assert.equal(routeAgentFor('barista signup acquisition cohort'), 'barista-acquisition');
  assert.equal(routeAgentFor('fake job scam report'), 'trust-safety');
});

test('actual permission ceilings block overreach and unknown agents', () => {
  assert.equal(permissionDecision('owner-intelligence', 'recommend').allowed, false);
  assert.equal(permissionDecision('marketplace', 'prepare').allowed, false);
  assert.equal(permissionDecision('engineering', 'prepare').allowed, true);
  assert.equal(permissionDecision('engineering', 'execute').allowed, false);
  assert.equal(permissionDecision('unknown', 'observe').allowed, false);
});

test('team snapshot describes registration without claiming active execution', () => {
  assert.equal(teamSnapshot().length, 19);
  for (const agent of teamSnapshot()) {
    assert.equal(agent.status, 'registered');
    assert.equal(agent.execution, 'available_on_request');
    assert.equal(agent.permissionCeiling, AGENT_REGISTRY.find(entry => entry.id === agent.id).ceiling);
  }
});
