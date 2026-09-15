import test from 'node:test';
import assert from 'node:assert/strict';
import { combinedAccountStatus } from '../../server/native-billing/accountStatus.mjs';
const account = { id: 'cafe-a', role: 'cafe_owner_manager' };
const website = { plan: 'free', connectedToBilling: false, canManageBilling: false, billingPaused: false };
const native = { accountId: account.id, environment: 'Production', subscriptions: [] };
const active = { provider: 'apple', status: 'active', currentPeriodEnd: '2099-01-01T00:00:00Z', gracePeriodEnd: null, autoRenews: true };
const input = { account, website, native, environment: 'Production', checkoutPending: false, now: Date.parse('2026-09-11T00:00:00Z') };
const status = changes => combinedAccountStatus({ ...input, ...changes });
const rows = (...subscriptions) => ({ ...native, subscriptions });
test('new café has free access and may start the separate atomic checkout process', () => {
  const result = status(); assert.equal(result.access, 'free'); assert.equal(result.canPurchase, true); assert.equal(result.provider, null);
});
test('existing website subscriber retains access when an expired app purchase is restored', () => {
  const result = status({ website: { ...website, plan: 'pro', connectedToBilling: true, canManageBilling: true }, native: rows({ ...active, status: 'expired' }) });
  assert.equal(result.access, 'pro'); assert.equal(result.provider, 'stripe'); assert.equal(result.canPurchase, false); assert.equal(result.subscriptions.length, 2);
});
test('verified app subscriber has shared pro status without invented Stripe identifiers', () => {
  const result = status({ native: rows(active) }); assert.equal(result.access, 'pro'); assert.equal(result.provider, 'apple'); assert.equal(result.canPurchase, false); assert.equal(result.canManage, true);
  assert.equal(JSON.stringify(result).includes('stripe_customer'), false);
});
test('an expired non-renewing app subscription can be replaced; a renewable overdue one must be resolved', () => {
  const expired = { ...active, currentPeriodEnd: '2001-01-01T00:00:00Z' };
  assert.equal(status({ native: rows(expired) }).canPurchase, false);
  const result = status({ native: rows({ ...expired, autoRenews: false }) });
  assert.equal(result.access, 'free'); assert.equal(result.status, 'expired'); assert.equal(result.canPurchase, true);
});
test('grace access uses its verified deadline without treating pending or revoked records as paid', () => {
  const grace = { ...active, status: 'grace', currentPeriodEnd: '2001-01-01T00:00:00Z', gracePeriodEnd: '2099-01-01T00:00:00Z' };
  assert.equal(status({ native: rows(grace) }).access, 'pro');
  for (const state of ['pending', 'payment_required', 'expired', 'revoked']) assert.equal(status({ native: rows({ ...active, status: state }) }).access, 'free');
  assert.equal(status({ native: rows({ ...grace, gracePeriodEnd: '2002-01-01T00:00:00Z' }) }).access, 'free');
});
test('billing recovery, an open checkout, and an owner billing pause block another purchase', () => {
  assert.equal(status({ checkoutPending: true }).canPurchase, false);
  assert.equal(status({ website: { ...website, billingPaused: true } }).canPurchase, false);
  assert.equal(status({ website: { ...website, connectedToBilling: true, canManageBilling: true } }).canPurchase, false);
  assert.equal(status({ native: rows({ ...active, status: 'pending' }) }).canPurchase, false);
});
test('multiple existing billing providers remain visible; no subscription is canceled or hidden', () => {
  const result = status({ native: rows(active, { ...active, provider: 'google' }) });
  assert.equal(result.subscriptions.length, 2); assert.equal(result.canPurchase, false); assert.equal(result.access, 'pro');
});
test('wrong role, suspension, account mismatch, sandbox mismatch, and missing source fail closed', () => {
  for (const changes of [
    { account: { ...account, role: 'barista' } }, { account: { ...account, suspendedAt: '2026-09-10' } },
    { native: { ...native, accountId: 'other' } }, { native: { ...native, environment: 'Sandbox' } },
    { native: null }, { website: null }, { checkoutPending: undefined }, { native: rows({ ...active, currentPeriodEnd: 'invalid' }) },
  ]) assert.throws(() => status(changes), /temporarily unavailable/);
});
test('only sanitized provider status leaves the server composition', () => {
  const result = status({ native: rows({ ...active, proof: 'private-proof', store_binding: 'private-binding', provider_subscription_id: 'private-token' }) });
  assert.equal(JSON.stringify(result).includes('private-'), false);
});
test('an old expired subscription cannot hide a new unfinished checkout', () => {
  const result = status({ checkoutPending: true, native: rows({ ...active, status: 'expired', autoRenews: false }) });
  assert.equal(result.status, 'pending'); assert.equal(result.canPurchase, false); assert.equal(result.canManage, true);
});
