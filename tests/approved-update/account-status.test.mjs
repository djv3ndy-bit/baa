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
test('owner pause removes native access and purchase eligibility without inventing a canceled financial subscription',()=>{
  const unpaused=status({native:{...rows(active),ownerPaused:false},checkoutPending:true});
  const paused=status({native:{...rows(active),ownerPaused:true},checkoutPending:true});
  assert.equal(paused.access,'free');assert.equal(paused.accessPaused,true);assert.equal(paused.canPurchase,false);
  assert.equal(paused.status,unpaused.status);assert.equal(paused.autoRenews,unpaused.autoRenews);assert.equal(paused.canManage,true);
  assert.deepEqual(paused.subscriptions,[{...unpaused.subscriptions[0],access:'free'}]);
  assert.equal(unpaused.access,'pro');assert.equal(unpaused.accessPaused,false);
});
test('owner pause masks both Stripe and native rows, and unpause restores verified access without modifying financial records',()=>{
  const paidWebsite={...website,plan:'pro',status:'active',connectedToBilling:true,canManageBilling:true,currentPeriodEnd:'2099-01-01T00:00:00Z',cancelAtPeriodEnd:false};
  const source={...rows(active),ownerPaused:false};const before=JSON.stringify({paidWebsite,source});
  const original=status({website:paidWebsite,native:source});
  const paused=status({website:paidWebsite,native:{...source,ownerPaused:true}});
  assert.equal(paused.access,'free');assert.equal(paused.canPurchase,false);assert.equal(paused.canManage,true);
  assert.ok(paused.subscriptions.every(row=>row.access==='free'));
  assert.deepEqual(paused.subscriptions,original.subscriptions.map(row=>({...row,access:'free'})));
  assert.equal(paused.provider,original.provider);assert.equal(paused.status,original.status);assert.equal(paused.autoRenews,original.autoRenews);
  assert.deepEqual(status({website:paidWebsite,native:{...source,ownerPaused:false}}),original);
  assert.equal(JSON.stringify({paidWebsite,source}),before);
});
test('paused free accounts cannot purchase; absent flag is legacy-compatible and a global purchase pause does not revoke paid access',()=>{
  const legacy=status();assert.equal(Object.hasOwn(legacy,'accessPaused'),false);
  assert.equal(status({native:{...native,ownerPaused:true}}).canPurchase,false);
  assert.equal(status({native:{...native,ownerPaused:false}}).canPurchase,true);
  const globallyPaused=status({native:rows(active),website:{...website,billingPaused:true}});
  assert.equal(globallyPaused.access,'pro');assert.equal(globallyPaused.canPurchase,false);
  for(const ownerPaused of [null,1,'true',{},[]])assert.throws(()=>status({native:{...native,ownerPaused}}));
});
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
