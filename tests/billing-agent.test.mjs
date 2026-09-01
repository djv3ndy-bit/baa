import test from 'node:test';
import assert from 'node:assert/strict';
import { BILLING_AGENT_POLICY, analyzeSubscription, analyzePayments, analyzeWebhookEvents, billingBrief } from '../api/_billing-agent.js';

test('healthy active subscription is P3',()=>{const r=analyzeSubscription({status:'active',stripe_subscription_id:'sub_1'});assert.equal(r.priority,'P3');});
test('past due subscription is P1',()=>{const r=analyzeSubscription({status:'past_due',stripe_subscription_id:'sub_1'});assert.equal(r.priority,'P1');});
test('scheduled cancellation is P2',()=>{const r=analyzeSubscription({status:'active',cancel_at_period_end:true});assert.equal(r.priority,'P2');});
test('refund record is P2',()=>{const r=analyzePayments([{provider_payment_id:'refund:ch_1',status:'refunded',amount_cents:999,currency:'usd'}]);assert.equal(r.priority,'P2');});
test('failed payment is P1',()=>{const r=analyzePayments([{provider_payment_id:'in_1',status:'failed',amount_cents:999,currency:'usd'}]);assert.equal(r.priority,'P1');});
test('duplicate-looking successful payments are P1 but not declared duplicates',()=>{const r=analyzePayments([{provider_payment_id:'in_1',status:'succeeded',amount_cents:999,currency:'usd',paid_at:'2026-09-01T10:00:00Z'},{provider_payment_id:'in_2',status:'succeeded',amount_cents:999,currency:'usd',paid_at:'2026-09-01T11:00:00Z'}]);assert.equal(r.priority,'P1');assert.equal(r.counts.duplicate_looking,1);assert.match(r.recommendation,/Verify suspected duplicates/i);});
test('duplicate webhook IDs are flagged P2',()=>{const r=analyzeWebhookEvents([{event_id:'evt_1',event_type:'invoice.paid'},{event_id:'evt_1',event_type:'invoice.paid'}]);assert.equal(r.priority,'P2');});
test('all financial write permissions remain disabled',()=>{assert.equal(BILLING_AGENT_POLICY.stripe_write_allowed,false);assert.equal(BILLING_AGENT_POLICY.refund_allowed,false);assert.equal(BILLING_AGENT_POLICY.charge_allowed,false);assert.equal(BILLING_AGENT_POLICY.cancellation_allowed,false);assert.equal(BILLING_AGENT_POLICY.subscription_change_allowed,false);assert.equal(BILLING_AGENT_POLICY.pricing_change_allowed,false);assert.equal(BILLING_AGENT_POLICY.database_write_allowed,false);assert.equal(BILLING_AGENT_POLICY.owner_approval_required_for_financial_action,true);});
test('brief escalates highest severity',()=>{const r=billingBrief({subscription:{status:'active'},payments:[{provider_payment_id:'in_1',status:'failed',amount_cents:999}]});assert.equal(r.priority,'P1');assert.equal(r.owner_approval_required,true);});
