import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveOfficeStatus, integrationFromStep, normalizeRun } from '../api/reliability.js';

const now = Date.parse('2026-09-01T06:00:00Z');

function run(overrides = {}) {
  return normalizeRun({
    id: 123,
    run_number: 9,
    display_title: 'Engineering reliability monitor',
    event: 'schedule',
    head_branch: 'main',
    head_sha: 'ae4d3a3204a405f52e533f1214b2c6919f96678c',
    status: 'completed',
    conclusion: 'success',
    run_started_at: '2026-09-01T05:17:00Z',
    updated_at: '2026-09-01T05:17:21Z',
    ...overrides,
  });
}

test('normalizes workflow runs without accepting an external URL', () => {
  const value = run({ html_url: 'javascript:alert(1)' });
  assert.equal(value.url, 'https://github.com/djv3ndy-bit/baa/actions/runs/123');
  assert.equal(value.sha, 'ae4d3a3');
  assert.equal(value.duration_seconds, 21);
});

test('classifies a recent successful run as healthy P3', () => {
  assert.deepEqual(deriveOfficeStatus([run()], [], now), {
    status: 'healthy',
    severity: 'P3',
    label: 'All monitored systems healthy',
  });
});

test('does not guess an exact severity for a failed workflow', () => {
  assert.deepEqual(deriveOfficeStatus([run({ conclusion: 'failure' })], [], now), {
    status: 'review_required',
    severity: 'P0–P2',
    label: 'Incident review required',
  });
});

test('live endpoint failures take precedence over a successful prior run', () => {
  assert.equal(deriveOfficeStatus([run()], [{ status: 'down' }], now).status, 'review_required');
});

test('reports skipped approval-gated steps as inactive', () => {
  const value = integrationFromStep('email', 'Email', { status: 'completed', conclusion: 'skipped' }, 'Enabled', 'Disabled');
  assert.equal(value.status, 'inactive');
  assert.equal(value.detail, 'Disabled');
});
