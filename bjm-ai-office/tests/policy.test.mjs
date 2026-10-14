import test from 'node:test';
import assert from 'node:assert/strict';
import { tsImport } from 'tsx/esm/api';

const { ownerApprovalFor, modelTierFor, retryDecision, handoffDecision, canonicalEventKey, duplicateDecision, usageSpike } = await tsImport('../server/policy.ts', import.meta.url);

test('protected owner actions require approval', () => {
  for (const action of ['deploy production', 'merge PR', 'refund customer', 'publish Instagram post', 'delete user', 'change RLS security', 'send email campaign', 'rotate credential', 'App Store release', 'plan upgrade']) {
    assert.equal(ownerApprovalFor(action).approvalRequired, true, action);
  }
});

test('internal analysis stays routine', () => {
  for (const action of ['analyze signup funnel', 'draft captions', 'summarize support trends', 'prepare owner brief']) {
    assert.equal(ownerApprovalFor(action).approvalRequired, false, action);
  }
});

test('actual model routing starts cheap and escalates for justified work', () => {
  assert.equal(modelTierFor('scheduled healthy check'), 'routine');
  assert.equal(modelTierFor('growth analysis'), 'standard');
  assert.equal(modelTierFor('production outage difficult debugging'), 'escalated');
});

test('automatic retry ceiling stops the fourth attempt', () => {
  assert.equal(retryDecision(2).allowed, true);
  assert.equal(retryDecision(3).allowed, false);
  assert.equal(retryDecision(4).escalate, true);
});

test('specialist handoff ceiling requires orchestrator review except during active incidents', () => {
  assert.equal(handoffDecision(1).allowed, true);
  assert.equal(handoffDecision(2).allowed, false);
  assert.equal(handoffDecision(2).orchestratorReview, true);
  assert.equal(handoffDecision(2, true).allowed, true);
});

test('canonical event keys deduplicate equivalent incidents', () => {
  const key = canonicalEventKey(' ENGINEERING ', 'API Failure', 'jobs');
  assert.equal(key, 'engineering:api failure:jobs');
  assert.equal(duplicateDecision(key, ['engineering:api failure:jobs']).createTask, false);
  assert.equal(duplicateDecision(key, ['billing:payment:jobs']).createTask, true);
});

test('simulated runaway loop is stopped by the actual retry policy', () => {
  let attempts = 0;
  while (attempts < 10 && retryDecision(attempts).allowed) attempts++;
  assert.equal(attempts, 3);
});

test('usage spike policy compares against a nonzero recent baseline', () => {
  assert.equal(usageSpike(20, 10).spike, true);
  assert.equal(usageSpike(19, 10).spike, false);
  assert.equal(usageSpike(20, 0).spike, false);
});
