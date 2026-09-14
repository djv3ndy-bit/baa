import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTypescript } from './load-typescript.mjs';
const coordinator = loadTypescript('mobile/features/native-subscription/purchaseCoordinator.ts');
const client = loadTypescript('mobile/features/native-subscription/nativeBillingClient.ts');
const { SubscriptionController } = loadTypescript('mobile/features/native-subscription/subscriptionController.ts', {
  './purchaseCoordinator': coordinator, './nativeBillingClient': client,
});
const { storeResponse } = loadTypescript('mobile/features/native-subscription/storeTimeout.ts');
const product = { id: 'synthetic.monthly', provider: 'apple', displayPrice: '$9.99', currency: 'USD', period: 'month' };
const purchase = { id: 'synthetic-transaction', productId: product.id, provider: 'apple', proof: 'test-only-proof' };
const free = { accountId: 'cafe-a', verified: true, access: 'free', provider: null, status: 'free', canManage: false, canPurchase: true, currentPeriodEnd: null, autoRenews: false };
const paid = { ...free, access: 'pro', provider: 'apple', status: 'active', canManage: true, canPurchase: false, autoRenews: true };
function harness(options = {}) {
  let state, account = { id: 'cafe-a', role: 'cafe_owner_manager' }, status = options.status || free;
  const calls = [], states = [];
  const store = {
    connect: async () => { calls.push('connect'); },
    product: async () => product, country: async () => 'USA',
    buy: async () => { calls.push('buy'); return { kind: 'purchased', purchase }; },
    restore: async () => { calls.push('restore'); return [purchase]; },
    finish: async () => { calls.push('finish'); },
    manage: async () => {}, dispose: async () => { calls.push('dispose'); }, ...options.store,
  };
  const c = new SubscriptionController({ accountId: 'cafe-a', account: async () => account,
    store: options.noStore ? null : store,
    call: async (path, body, method, accountId) => {
      calls.push(path); assert.equal(accountId, 'cafe-a');
      if (options.call) { const result = await options.call(path); if (result !== undefined) return result; }
      if (path.endsWith('status')) return status;
      if (path.endsWith('prepare')) return { attemptId: '10000000-0000-4000-8000-000000000001', accountBinding: '20000000-0000-4000-8000-000000000001' };
      if (path.endsWith('start')) return { started: true };
      if (path.endsWith('cancel')) return { cancelled: true };
      if (path === '/native-purchases') { status = options.verifiedStatus || paid; return { verified: true, accountId: 'cafe-a', purchase: { provider: 'apple', status: options.purchaseStatus || 'active' } }; }
      throw Error('Unexpected call');
    },
    changed: next => { state = next; states.push(next); }, accountChanged: () => calls.push('account-changed'),
    openManagement: async (provider, id) => { assert.equal(id, 'cafe-a'); calls.push(`manage-${provider}`); },
  });
  return { c, calls, states, state: () => state, setAccount: next => { account = next; }, setStatus: next => { status = next; } };
}
test('screen controller confirms server access before reporting a successful purchase', async () => {
  const h = harness(); await h.c.load(); assert.equal(h.state().product.displayPrice, '$9.99');
  await h.c.buy(); assert.equal(h.state().subscription.access, 'pro'); assert.match(h.state().notice, /confirmed/); assert.equal(h.state().busy, false);
  assert.ok(h.calls.indexOf('/native-purchases') < h.calls.indexOf('finish'));
});
test('rapid repeated screen taps cannot open checkout twice', async () => {
  let release; const h = harness({ store: { buy: async () => { h.calls.push('buy'); return new Promise(r => { release = r; }); } } });
  await h.c.load(); const first = h.c.buy(); await h.c.buy(); await h.c.restore();
  while (!release) await new Promise(r => setImmediate(r));
  release({ kind: 'cancelled' }); await first; assert.equal(h.calls.filter(v => v === 'buy').length, 1); assert.equal(h.calls.includes('restore'), false);
  assert.equal(h.state().notice, 'Purchase canceled.');
});
test('existing website subscriber can manage without loading or buying a native plan', async () => {
  const h = harness({ status: { ...paid, provider: 'stripe' }, store: { product: async () => { throw Error('must not load product'); } } });
  await h.c.load(); await h.c.buy(); await h.c.manage(); assert.equal(h.state().error, '');
  assert.equal(h.calls.includes('connect'), true); assert.equal(h.calls.includes('manage-stripe'), true); assert.equal(h.calls.includes('buy'), false);
});
test('unavailable store keeps actual subscriber status and provider management', async () => {
  const h = harness({ noStore: true, status: { ...paid, provider: 'apple' } });
  await h.c.load(); await h.c.manage(); await h.c.restore(); assert.equal(h.state().subscription.access, 'pro');
  assert.match(h.state().notice, /not available on this device/); assert.ok(h.calls.includes('manage-apple')); assert.ok(!h.calls.includes('restore'));
});
test('outside-US product error is understandable and does not prevent restoration', async () => {
  const h = harness({ store: { product: async () => { throw { reason: 'outside_us', message: 'raw provider text' }; } } });
  await h.c.load(); assert.match(h.state().error, /United States/); assert.equal(h.state().product, null);
  await h.c.restore(); assert.equal(h.state().subscription.access, 'pro'); assert.equal(h.state().error, ''); assert.ok(!h.calls.includes('buy'));
});
test('unapproved store terms explain the actual problem, block buying, and recover on retry', async () => {
  let reviewed = false;
  const h = harness({ store: { product: async () => { if (!reviewed) throw { reason: 'terms_review', message: 'raw provider text' }; return product; } } });
  await h.c.load();
  assert.match(h.state().error, /terms that need review/);
  assert.doesNotMatch(h.state().error, /connection|raw provider text/);
  assert.equal(h.state().product, null); assert.equal(h.state().subscription.access, 'free');
  await h.c.buy(); assert.ok(!h.calls.includes('buy'));
  reviewed = true; await h.c.load();
  assert.equal(h.state().error, ''); assert.equal(h.state().product.displayPrice, '$9.99');
});
test('failed refresh preserves last confirmed access without a false free downgrade', async () => {
  let fail = false; const h = harness({ status: paid, call: async path => { if (fail && path.endsWith('status')) throw Error('raw credential 500'); } });
  await h.c.load(); fail = true; await h.c.load(); assert.equal(h.state().subscription.access, 'pro'); assert.equal(h.state().busy, false);
  assert.match(h.state().error, /last confirmed status/); assert.doesNotMatch(h.state().error, /credential/);
});
test('account switching during price loading hides the old account and blocks purchase', async () => {
  const h = harness({ store: { product: async () => { h.setAccount({ id: 'cafe-b', role: 'cafe_owner_manager' }); return product; } } });
  await h.c.load(); await h.c.buy(); assert.equal(h.state().subscription, null); assert.equal(h.state().product, null); assert.ok(!h.calls.includes('buy'));
});
test('screen unmount prevents late status and product writes', async () => {
  let release; const h = harness({ call: async path => path.endsWith('status') ? new Promise(r => { release = r; }) : undefined });
  const loading = h.c.load(); while (!release) await new Promise(r => setImmediate(r));
  h.c.dispose(); const count = h.states.length; release(free); await loading;
  assert.equal(h.states.length, count); assert.ok(!h.calls.includes('connect'));
});
test('unfinished store callbacks verify once without buying or showing restore authentication', async () => {
  const h = harness(); await h.c.load(); await h.c.recover(purchase); await h.c.recover(purchase);
  assert.equal(h.calls.filter(v => v === '/native-purchases').length, 1); assert.equal(h.calls.filter(v => v === 'finish').length, 1);
  assert.ok(!h.calls.includes('buy')); assert.ok(!h.calls.includes('restore')); assert.equal(h.state().subscription.access, 'pro');
});
test('expired restoration preserves an active website subscription', async () => {
  const h = harness({ verifiedStatus: { ...paid, provider: 'stripe' }, purchaseStatus: 'expired' });
  await h.c.restore(); assert.equal(h.state().subscription.provider, 'stripe'); assert.equal(h.state().subscription.access, 'pro');
});
test('verification failure never displays success and does not finish the store purchase', async () => {
  const h = harness({ call: async path => { if (path === '/native-purchases') throw Error('offline'); } });
  await h.c.load(); await h.c.buy(); assert.match(h.state().notice, /could not be confirmed/); assert.equal(h.state().subscription.access, 'free'); assert.ok(!h.calls.includes('finish'));
});
test('a restore timeout preserves verified Pro without claiming the purchase is unconfirmed', async () => {
  const h = harness({ status: paid, store: { restore: async () => { throw Error('store authentication timed out'); } } });
  await h.c.load(); await h.c.restore();
  assert.equal(h.state().subscription.access, 'pro'); assert.equal(h.state().busy, false);
  assert.match(h.state().notice, /Pro access is active/);
  assert.match(h.state().notice, /could not finish checking/);
  assert.doesNotMatch(h.state().notice, /purchase could not be confirmed|restoration (succeeded|complete)/);
  await h.c.recover(purchase);
  assert.equal(h.state().notice, 'Your Pro access is confirmed.');
  assert.equal(h.calls.filter(v => v === '/native-purchases').length, 1);
});
test('a store finish failure after verified purchase preserves access and offers recovery', async () => {
  const h = harness({ store: { finish: async () => { throw Error('store finish failed'); } } });
  await h.c.load(); await h.c.buy();
  assert.equal(h.state().subscription.access, 'pro');
  assert.match(h.state().notice, /Pro access is active/); assert.match(h.state().notice, /Restore purchases/);
  assert.doesNotMatch(h.state().notice, /purchase could not be confirmed/);
});
test('barista sessions never request subscription status or contact the store', async () => {
  const h = harness(); h.setAccount({ id: 'barista-a', role: 'barista' });
  await h.c.load(); await h.c.buy(); await h.c.restore(); assert.equal(h.calls.some(v => v.startsWith('/')), false); assert.equal(h.calls.includes('connect'), false);
});
test('stalled store reads stop waiting; late completion is not treated as cancellation', async () => {
  let release; const late = new Promise(r => { release = r; });
  await assert.rejects(storeResponse(late, 5), /store did not respond/);
  release('late response'); assert.equal(await late, 'late response');
  assert.equal(await storeResponse(Promise.resolve('ready'), 5), 'ready');
});

test('management uses only providers still confirmed for the current account', async () => {
  const h = harness({ status: { ...paid, subscriptions: [{ provider: 'apple', access: 'pro', canManage: true }, { provider: 'stripe', access: 'free', canManage: true }] } });
  await h.c.load(); await h.c.manage('stripe'); await h.c.manage('google');
  assert.ok(h.calls.includes('manage-stripe')); assert.ok(!h.calls.includes('manage-google'));
  h.setStatus({ ...paid, subscriptions: [{ provider: 'apple', access: 'pro', canManage: true }] });
  const count = h.calls.filter(call => call === 'manage-stripe').length;
  await h.c.manage('stripe'); assert.equal(h.calls.filter(call => call === 'manage-stripe').length, count);
});
