import test from 'node:test';
import assert from 'node:assert/strict';
import { triageSupportTicket, supportDraft } from '../api/_support-agent.js';

function ticket(issue_type, subject, description='Please help me with this request.') {
  return { ticket_id:'BM-TEST-001', name:'Test User', issue_type, subject, description };
}

test('general question is P3 support', () => {
  const t=triageSupportTicket(ticket('question','How do matches work?'));
  assert.equal(t.priority,'P3'); assert.equal(t.route,'support'); assert.equal(t.approval_required,false);
});

test('technical bug routes P2 to engineering', () => {
  const t=triageSupportTicket(ticket('bug','Application button fails'));
  assert.equal(t.priority,'P2'); assert.equal(t.route,'engineering');
});

test('refund request is P1 and owner controlled', () => {
  const t=triageSupportTicket(ticket('billing','I need a refund'));
  assert.equal(t.priority,'P1'); assert.equal(t.route,'billing_owner'); assert.equal(t.approval_required,true);
});

test('account deletion is P1 owner controlled', () => {
  const t=triageSupportTicket(ticket('account','Delete my account'));
  assert.equal(t.priority,'P1'); assert.equal(t.route,'owner'); assert.equal(t.approval_required,true);
});

test('data breach language is P0', () => {
  const t=triageSupportTicket(ticket('other','Possible data breach'));
  assert.equal(t.priority,'P0'); assert.equal(t.route,'owner'); assert.equal(t.approval_required,true);
});

test('ordinary billing question is P2 but protected', () => {
  const t=triageSupportTicket(ticket('billing','Where can I see my subscription?'));
  assert.equal(t.priority,'P2'); assert.equal(t.route,'billing'); assert.equal(t.approval_required,true);
});

test('all triage results deny autonomous sensitive actions', () => {
  for (const sample of [ticket('question','Hello'),ticket('bug','Bug'),ticket('billing','Refund please'),ticket('account','Delete my account')]) {
    const t=triageSupportTicket(sample);
    assert.equal(t.autonomous_send_allowed,false);
    assert.equal(t.destructive_action_allowed,false);
    assert.equal(t.financial_action_allowed,false);
    assert.equal(t.production_write_allowed,false);
  }
});

test('draft is only text and reflects protected review', () => {
  const sample=ticket('billing','Refund please');
  const triage=triageSupportTicket(sample);
  const draft=supportDraft(sample,triage);
  assert.match(draft,/additional review/i);
  assert.match(draft,/BaristaMatch Support/);
});
