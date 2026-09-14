import test from 'node:test';
import assert from 'node:assert/strict';
import { accountBillingHandler, accountBillingView, nativeManagementUrls } from '../../server/native-billing/accountBillingHandler.mjs';
import { combinedAccountStatus } from '../../server/native-billing/accountStatus.mjs';
const account = { id: 'cafe-a', role: 'cafe_owner_manager' };
const free = { plan: 'free', status: 'free', connectedToBilling: false, canManageBilling: false, billingPaused: false, monthlyPriceCents: 999, maxActiveJobs: 3, currentPeriodEnd: null, cancelAtPeriodEnd: false };
const websitePro = { ...free, plan: 'pro', status: 'active', connectedToBilling: true, canManageBilling: true, currentPeriodEnd: '2099-01-01T00:00:00Z' };
const apple = { provider: 'apple', status: 'active', currentPeriodEnd: '2099-01-01T00:00:00Z', gracePeriodEnd: null, autoRenews: true };
function combined(website = free, rows = [], checkoutPending = false) {
  return combinedAccountStatus({ account, website, native: { accountId: account.id, environment: 'Production', subscriptions: rows }, environment: 'Production', checkoutPending });
}
test('all legacy Stripe fields and original price/benefits remain unchanged without native history', () => {
  for (const website of [free, websitePro, { ...websitePro, status: 'trialing' }, { ...free, billingPaused: true }]) {
    assert.equal(accountBillingView(website, combined(website)), website);
  }
});
test('verified Apple access satisfies existing website Pro checks without inventing Stripe IDs', () => {
  const result = accountBillingView(free, combined(free, [apple]));
  assert.equal(result.plan, 'pro'); assert.equal(result.status, 'active');
  assert.equal(result.connectedToBilling, true); assert.equal(result.canManageBilling, true);
  assert.equal(result.monthlyPriceCents, 999); assert.equal(result.maxActiveJobs, 3);
  assert.equal(result.nativeStatus.provider, 'apple');
  assert.ok(!JSON.stringify(result).includes('stripe_subscription_id'));
});
test('expired Apple history neither removes valid Stripe access nor permanently prevents website resubscription', () => {
  const expired = { ...apple, status: 'expired', autoRenews: false, currentPeriodEnd: '2020-01-01T00:00:00Z' };
  const paid = accountBillingView(websitePro, combined(websitePro, [expired]));
  assert.equal(paid.plan, 'pro'); assert.equal(paid.currentPeriodEnd, websitePro.currentPeriodEnd);
  const ended = accountBillingView(free, combined(free, [expired]));
  assert.equal(ended.plan, 'free'); assert.equal(ended.canManageBilling, false);
  assert.equal(ended.nativeStatus.canManage, true);
});
test('an unfinished purchase blocks legacy web checkout even before a receipt exists', () => {
  const result = accountBillingView(free, combined(free, [], true));
  assert.equal(result.plan, 'free'); assert.equal(result.canManageBilling, true);
  assert.equal(result.nativeStatus.status, 'pending');
});
test('grace uses the verified access deadline and keeps renewal status explicit', () => {
  const row = { ...apple, status: 'grace', currentPeriodEnd: '2020-01-01T00:00:00Z', gracePeriodEnd: '2099-01-04T00:00:00Z' };
  const result = accountBillingView(free, combined(free, [row]));
  assert.equal(result.plan, 'pro'); assert.equal(result.currentPeriodEnd, row.gracePeriodEnd);
  assert.equal(result.nativeStatus.status, 'grace');
});
async function http({ action = 'status', method = action === 'status' ? 'GET' : 'POST', body = {}, website = free, rows = [apple], pending = false,
  configured = true, user = { id: account.id, profile: { role: account.role } }, failed = false, wrongAccount = false } = {}) {
  const calls = [];
  const existingBilling = async (req, res) => {
    calls.push(req.query.action);
    return res.status(200).json(req.query.action === 'status' ? website : { url: 'https://billing.stripe.com/preserved' });
  };
  const handler = accountBillingHandler({ existingBilling, configured: () => configured, authenticateCafe: async () => user,
    statusFor: async (a, w) => { assert.equal(a.id, account.id); if (failed) throw Error('private provider details'); return { ...combined(w, rows, pending), ...(wrongAccount ? { accountId: 'other' } : {}) }; } });
  const res = { headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(v) { this.code = v; return this; }, json(v) { this.body = v; return this; } };
  await handler({ method, query: { action }, body }, res); return { ...res, calls };
}
test('disabled integration delegates directly to original billing without reading native data', async () => {
  const result = await http({ configured: false, failed: true }); assert.equal(result.body, free); assert.deepEqual(result.calls, ['status']);
});
test('Apple and Google management use fixed provider URLs and retain expired management', async () => {
  for (const provider of ['apple', 'google']) {
    const result = await http({ action: 'portal', rows: [{ ...apple, provider, status: 'expired', autoRenews: false }], body: { provider } });
    assert.equal(result.code, 200); assert.equal(result.body.url, nativeManagementUrls[provider]);
    assert.equal(result.body.systemManagement, true); assert.deepEqual(result.calls, ['status']);
  }
});
test('existing website subscriptions continue through the original Stripe portal handler', async () => {
  const result = await http({ action: 'portal', website: websitePro });
  assert.deepEqual(result.calls, ['status', 'portal']); assert.equal(result.body.url, 'https://billing.stripe.com/preserved');
});
test('clients cannot select another account or manage an unowned provider', async () => {
  assert.equal((await http({ action: 'portal', body: { provider: 'google', accountId: 'other' } })).code, 409);
  assert.equal((await http({ action: 'portal', body: { provider: 'https://evil.invalid' } })).code, 400);
  assert.equal((await http({ wrongAccount: true })).code, 503);
});
test('pending purchases provide a recovery error instead of starting another checkout', async () => {
  const result = await http({ action: 'portal', rows: [], pending: true });
  assert.equal(result.code, 409); assert.match(result.body.error, /Restore purchases/);
});
test('authorization, method, malformed request, and outage errors never appear as Free access', async () => {
  assert.equal((await http({ method: 'POST' })).code, 405);
  assert.equal((await http({ user: null })).code, 401);
  assert.equal((await http({ user: { id: 'b', profile: { role: 'barista' } } })).code, 403);
  assert.equal((await http({ user: { id: account.id, profile: { role: account.role, suspended_at: 'now' } } })).code, 403);
  assert.equal((await http({ action: 'portal', body: '{' })).code, 400);
  const outage = await http({ failed: true }); assert.equal(outage.code, 503);
  assert.ok(!JSON.stringify(outage.body).includes('private')); assert.equal(outage.headers['Cache-Control'], 'no-store');
});

test('default management opens owned Apple history when an expired Stripe record cannot be managed', async () => {
  const endedWebsite = { ...free, status: 'canceled', connectedToBilling: true };
  const expiredApple = { ...apple, status: 'expired', autoRenews: false, currentPeriodEnd: '2020-01-01T00:00:00Z' };
  const result = await http({ action: 'portal', website: endedWebsite, rows: [expiredApple] });
  assert.equal(result.code, 200);
  assert.equal(result.body.provider, 'apple');
  assert.equal(result.body.url, nativeManagementUrls.apple);
  assert.deepEqual(result.calls, ['status']);
  const selectedStripe = await http({ action: 'portal', website: endedWebsite, rows: [expiredApple], body: { provider: 'stripe' } });
  assert.equal(selectedStripe.code, 409);
});
