import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTypescript } from './load-typescript.mjs';
const { PurchaseCoordinator } = loadTypescript('mobile/features/native-subscription/purchaseCoordinator.ts');
const product = { id: 'sandbox-product', displayPrice: '$9.99', currency: 'USD', period: 'month', provider: 'apple' };
const receipt = { id: 'sandbox-transaction', productId: product.id, provider: 'apple', proof: 'test-only-proof' };
const free = { accountId: 'cafe-a', verified: true, access: 'free', provider: null, canPurchase: true, canManage: false, status: 'free', currentPeriodEnd: null, autoRenews: false };
const paid = { ...free, provider: 'apple', access: 'pro', canPurchase: false, canManage: true, status: 'active', autoRenews: true };
function harness(overrides = {}) {
  const calls = [];
  let account = { id: 'cafe-a', role: 'cafe_owner_manager' };
  const deps = {
    account: async () => account,
    status: async () => free,
    preflight: async () => { calls.push('preflight'); return { attemptId: 'attempt-a', accountBinding: 'binding-a' }; },
    purchase: async (_product, binding) => { assert.equal(binding, 'binding-a'); calls.push('purchase'); return { kind: 'purchased', purchase: receipt }; },
    verify: async id => { assert.equal(id, 'cafe-a'); calls.push('verify'); return paid; },
    finish: async () => { calls.push('finish'); },
    restore: async () => { calls.push('restore'); return [receipt]; }, ...overrides,
  };
  return { coordinator: new PurchaseCoordinator(deps), calls, deps, setAccount(value) { account = value; } };
}
test('purchase requires server verification before store finishing', async () => {
  const h = harness(); const result = await h.coordinator.buy(product);
  assert.equal(result.kind, 'verified'); assert.equal(result.subscription.access, 'pro');
  assert.deepEqual(h.calls, ['preflight', 'purchase', 'verify', 'finish']);
});
test('concurrent taps open at most one store purchase', async () => {
  let release; const h = harness({ purchase: () => new Promise(resolve => { release = resolve; }) });
  const first = h.coordinator.buy(product);
  assert.equal((await h.coordinator.buy(product)).kind, 'busy');
  while (!release) await new Promise(resolve => setImmediate(resolve));
  release({ kind: 'cancelled' }); assert.equal((await first).kind, 'cancelled');
  assert.equal(h.calls.filter(x => x === 'preflight').length, 1);
});
for (const provider of ['stripe', 'apple', 'google']) test(`existing ${provider} subscription cannot buy duplicate access`, async () => {
  const h = harness({ status: async () => ({ ...paid, provider }) });
  assert.equal((await h.coordinator.buy(product)).kind, 'blocked'); assert.deepEqual(h.calls, []);
});
for (const kind of ['cancelled', 'pending']) test(`${kind} checkout does not activate access or finish an unverified transaction`, async () => {
  const h = harness({ purchase: async () => ({ kind }) });
  assert.equal((await h.coordinator.buy(product)).kind, kind); assert.deepEqual(h.calls, ['preflight']);
});
test('barista cannot reach a purchase or restoration adapter', async () => {
  const h = harness(); h.setAccount({ id: 'barista-a', role: 'barista' });
  assert.equal((await h.coordinator.buy(product)).kind, 'account_changed');
  assert.equal((await h.coordinator.restore()).kind, 'account_changed'); assert.deepEqual(h.calls, []);
});
test('verification failure retries the same transaction without purchasing again', async () => {
  let failures = 1; const h = harness({ verify: async () => { if (failures--) throw Error('Network interrupted'); return paid; } });
  assert.equal((await h.coordinator.buy(product)).kind, 'verification_pending');
  assert.equal((await h.coordinator.buy(product)).kind, 'verified');
  assert.equal(h.calls.filter(x => x === 'purchase').length, 1);
});
test('account switch during checkout cannot attach the receipt to another account', async () => {
  const h = harness({ purchase: async () => { h.setAccount({ id: 'cafe-b', role: 'cafe_owner_manager' }); return { kind: 'purchased', purchase: receipt }; } });
  assert.equal((await h.coordinator.buy(product)).kind, 'account_changed');
  assert.equal((await h.coordinator.buy(product)).kind, 'account_changed');
  assert.deepEqual(h.calls, ['preflight']);
});
test('mismatched backend account confirmation never finishes a purchase', async () => {
  const h = harness({ verify: async () => ({ ...paid, accountId: 'cafe-b' }) });
  assert.equal((await h.coordinator.buy(product)).kind, 'verification_pending');
  assert.ok(!h.calls.includes('finish'));
});
test('restoration verifies the receipt again and never invokes purchase', async () => {
  const h = harness(); assert.equal((await h.coordinator.restore()).kind, 'verified');
  assert.deepEqual(h.calls, ['restore', 'verify', 'finish']);
});
for (const status of ['expired', 'revoked']) test(`restored ${status} subscription does not receive paid access`, async () => {
  const h = harness({ verify: async () => ({ ...free, provider: 'apple', status }) });
  const result = await h.coordinator.restore(); assert.equal(result.kind, 'verified'); assert.equal(result.subscription.access, 'free');
});
test('grace access from verified backend is retained', async () => {
  const h = harness({ status: async () => ({ ...paid, status: 'grace' }) });
  const result = await h.coordinator.buy(product); assert.equal(result.kind, 'blocked'); assert.equal(result.subscription.access, 'pro');
});
test('payment failure on an existing subscription directs recovery instead of another subscription', async () => {
  const h = harness({ status: async () => ({ ...free, provider: 'stripe', status: 'payment_required', canPurchase: false }) });
  assert.equal((await h.coordinator.buy(product)).kind, 'blocked'); assert.deepEqual(h.calls, []);
});
test('backend-approved repurchase after expiration is possible', async () => {
  const h = harness({ status: async () => ({ ...free, provider: 'apple', status: 'expired' }) });
  assert.equal((await h.coordinator.buy(product)).kind, 'verified'); assert.ok(h.calls.includes('purchase'));
});
test('failure to finish a verified transaction can recover without a second charge', async () => {
  let fails = true; const h = harness({ finish: async () => { if (fails) { fails = false; throw Error('Disconnected'); } } });
  assert.equal((await h.coordinator.buy(product)).kind, 'verification_pending');
  assert.equal((await h.coordinator.restore()).kind, 'verified');
  assert.equal(h.calls.filter(x => x === 'purchase').length, 1);
});
test('changed proof for a previously finished transaction is verified again for revocation', async () => {
  let revoked = false;
  const h = harness({ verify: async () => revoked ? { ...free, provider: 'apple', status: 'revoked' } : paid });
  assert.equal((await h.coordinator.recover(receipt)).subscription.access, 'pro');
  revoked = true;
  const result = await h.coordinator.recover({ ...receipt, proof: 'new-synthetic-revocation-proof' });
  assert.equal(result.kind, 'verified'); assert.equal(result.subscription.access, 'free');
});
