import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { tsImport } from 'tsx/esm/api';

const { Office } = await tsImport('../web/office-view.tsx', import.meta.url);
const { billingMetric, supportMetric, mergeOfficeData, structuredContent } = await tsImport('../web/office-data.ts', import.meta.url);
const render = (data = {}, extra = {}) => renderToStaticMarkup(React.createElement(Office, {
  data, loading: false, connected: true, error: null, call() {}, followUp() {}, ...extra,
}));

test('unloaded widget does not imply provider health or active work', () => {
  const html = render();
  assert.match(html, /Not loaded/);
  assert.match(html, /19 registered roles/);
  assert.match(html, /Roles are available on request/);
  assert.match(html, /Decision queue not loaded/);
  assert.doesNotMatch(html, />Ready<|>Protected<|Run AI Team/);
});

test('unavailable billing and support never render a verified zero', () => {
  assert.equal(supportMetric({ configured: false, open: 0 }).value, 'Unavailable');
  assert.equal(supportMetric({ configured: true, open: 0 }).value, 'Unavailable');
  assert.equal(supportMetric({ configured: true, availability: 'unavailable', open: null }).value, 'Unavailable');
  assert.equal(billingMetric({ configured: false, subscriptions: { past_due: 0 }, payments: { failed: 0 } }).value, 'Unavailable');
  assert.equal(billingMetric({ configured: true, subscriptions: { past_due: 0 }, payments: { failed: 0 } }).value, 'Unavailable');
  assert.equal(billingMetric({ configured: true, availability: 'partial', subscriptions: { past_due: 2 }, payments: { failed: null } }).value, 'Partial');
});

test('verified zero remains distinguishable from missing billing or support data', () => {
  assert.equal(supportMetric({ configured: true, availability: 'available', open: 0 }).value, '0');
  const billing = billingMetric({ configured: true, availability: 'available', subscriptions: { past_due: 0 }, payments: { failed: 0 } });
  assert.equal(billing.value, '0');
  assert.equal(billing.detail, 'No issues in checked data');
  assert.equal(billingMetric({ configured: true, subscriptions: { past_due: null }, payments: { failed: 0 } }).value, 'Unavailable');
});

test('updating one report preserves other reports and refreshes approval count', () => {
  const previous = { health: { overall: 'attention' }, billing: { availability: 'available' }, decisions: [{ protected: true }], approvals: { count: 1 } };
  const next = mergeOfficeData(previous, { screen: 'decisions', items: [{ protected: false }, { protected: true }, { protected: true }] });
  assert.deepEqual(next.health, previous.health);
  assert.deepEqual(next.billing, previous.billing);
  assert.equal(next.decisions.length, 3);
  assert.equal(next.approvals.count, 2);
  assert.deepEqual(mergeOfficeData(next, { items: [] }).decisions, []);
  assert.equal(mergeOfficeData(next, { items: [] }).approvals.count, 0);
});

test('empty checked decision queue explains incomplete coverage', () => {
  const html = render({ items: [] });
  assert.match(html, /No decision signals returned/);
  assert.match(html, /Verify provider availability/);
});

test('disconnected reports are disabled and report errors remain visible', () => {
  const html = render({}, { connected: false, error: 'Report access failed.' });
  assert.match(html, /role="status"/);
  assert.match(html, /role="alert">Report access failed/);
  assert.equal((html.match(/disabled=""/g) || []).length, 10);
});

test('structured content accepts bridge and legacy outputs but rejects strings', () => {
  assert.deepEqual(structuredContent({ structuredContent: { screen: 'health' } }), { screen: 'health' });
  assert.deepEqual(structuredContent({ toolOutput: { screen: 'team' } }), { screen: 'team' });
  assert.deepEqual(structuredContent({ result: { structuredContent: { items: [] } } }), { items: [] });
  assert.equal(structuredContent({ output: 'Unavailable' }), null);
});
