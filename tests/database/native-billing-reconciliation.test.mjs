import { before, after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { createReconciler } from '../../server/native-billing/reconcile.mjs';
import { nativeBillingRepository } from '../../server/native-billing/repository.mjs';

const cafe = '00000000-0000-4000-8000-000000000001';
const other = '00000000-0000-4000-8000-000000000002';
let db, binding, repository;
const scalar = async (sql, params = []) => Object.values((await db.query(sql, params)).rows[0])[0];
before(async () => {
  db = new PGlite();
  await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
    create table public.profiles(id uuid primary key,role text,suspended_at timestamptz);
    insert into public.profiles values('${cafe}','cafe_owner_manager',null),('${other}','barista',null);`);
  await db.exec(readFileSync(new URL('../../review/native-billing-ledger.sql', import.meta.url), 'utf8'));
  binding = await scalar('select public.native_billing_account($1)', [cafe]);
  repository = nativeBillingRepository(async (path, options) => {
    if (path.startsWith('profiles?')) {
      const id = new URLSearchParams(path.split('?')[1]).get('id').slice(3);
      return (await db.query('select * from public.profiles where id=$1', [id])).rows;
    }
    const name = path.slice(4);
    assert.ok(['native_billing_owner','native_billing_read','native_billing_apply','native_billing_claim_event','native_billing_finish_event'].includes(name));
    const body = JSON.parse(options.body);
    for (const key of Object.keys(body)) assert.match(key, /^p_[a-z_]+$/);
    return scalar(`select public.${name}(${Object.keys(body).map((key, i) => `${key}=>$${i + 1}`).join(',')})`, Object.values(body));
  });
});
beforeEach(async () => {
  await db.exec(`truncate private.native_billing_subscriptions,private.native_billing_events;
    update public.profiles set suspended_at=null,role='cafe_owner_manager' where id='${cafe}';`);
});
after(async () => db?.close());

function fixture(overrides = {}) {
  let verifyCount = 0, ackCount = 0;
  const status = { provider: 'google', environment: 'Sandbox', binding, providerSubscriptionId: 'purchase-token', transactionId: 'order',
    productId: 'test.monthly', access: 'pro', status: 'active', currentPeriodEnd: '2099-01-01T00:00:00.000Z', gracePeriodEnd: null,
    autoRenews: true, needsAcknowledgement: true, canManage: true };
  const adapter = {
    identify: async () => ({ binding, providerSubscriptionId: 'purchase-token' }),
    verify: async () => { verifyCount++; return { ...status }; },
    acknowledge: async () => { ackCount++; assert.equal(await scalar('select public.native_billing_access($1,$2)', [cafe,'Sandbox']), true); },
    ...overrides,
  };
  return { status, adapter, service: createReconciler({ repository, providers: { google: adapter }, environment: 'Sandbox' }),
    counts: () => ({ verifyCount, ackCount }) };
}
const purchase = { provider: 'google', proof: 'purchase-token', accountId: cafe };
const notification = { provider: 'google', proof: 'purchase-token', eventId: 'event-1', payload: 'authenticated-test-event' };

test('purchase commits verified account access before acknowledgement and restoration is idempotent', async () => {
  const f = fixture(); assert.equal((await f.service.reconcile(purchase)).access, 'pro');
  f.status.needsAcknowledgement = false;
  await f.service.reconcile(purchase);
  assert.equal((await repository.read('google','Sandbox','purchase-token')).revision, 1);
  assert.deepEqual(f.counts(), { verifyCount: 2, ackCount: 1 });
});
test('another BaristaMatch account cannot restore the original buyer’s purchase', async () => {
  const f = fixture(); await assert.rejects(f.service.reconcile({ ...purchase, accountId: other }), { code: 'ACCOUNT_MISMATCH' });
  assert.equal(await repository.read('google','Sandbox','purchase-token'), null); assert.equal(f.counts().verifyCount, 0);
});
test('suspended or changed-role accounts cannot activate a purchase', async () => {
  const f = fixture(); await db.exec(`update profiles set suspended_at=now() where id='${cafe}'`);
  await assert.rejects(f.service.reconcile(purchase), { code: 'ACCOUNT_UNAVAILABLE' });
  await db.exec(`update profiles set suspended_at=null,role='barista' where id='${cafe}'`);
  await assert.rejects(f.service.reconcile(purchase), { code: 'ACCOUNT_UNAVAILABLE' });
  assert.equal(f.counts().verifyCount, 0);
});
test('a suspension during provider verification also prevents activation', async () => {
  const f = fixture(); f.adapter.verify = async () => { await db.exec(`update profiles set suspended_at=now() where id='${cafe}'`); return f.status; };
  await assert.rejects(f.service.reconcile(purchase), { code: 'ACCOUNT_UNAVAILABLE' });
  assert.equal(await repository.read('google','Sandbox','purchase-token'), null);
});
test('a delayed active response cannot overwrite a concurrent refund', async () => {
  const f = fixture(); await f.service.reconcile(purchase);
  let release, entered; const enteredPromise = new Promise(resolve => { entered = resolve; });
  let calls = 0;
  const stale = fixture({ verify: async () => {
    const captured = { ...f.status }; calls++;
    if (calls === 1) { entered(); await new Promise(resolve => { release = resolve; }); }
    return captured;
  } });
  const pending = stale.service.reconcile(purchase); await enteredPromise;
  f.status.status = 'revoked'; f.status.access = 'free'; f.status.needsAcknowledgement = false;
  await f.service.reconcile(purchase);
  release();
  assert.equal((await pending).status, 'revoked'); assert.equal(calls,2,'stale response must trigger a fresh provider request');
  assert.equal(await scalar('select public.native_billing_access($1,$2)', [cafe,'Sandbox']), false);
});
test('provider outages preserve a previously verified valid entitlement and remain retryable', async () => {
  const f = fixture(); await f.service.reconcile(purchase);
  f.adapter.verify = async () => { throw Error('provider unavailable'); };
  await assert.rejects(f.service.reconcile(purchase));
  assert.equal(await scalar('select public.native_billing_access($1,$2)', [cafe,'Sandbox']), true);
  assert.equal((await repository.read('google','Sandbox','purchase-token')).revision, 1);
});
test('acknowledgement failure keeps durable access and retries the same purchase', async () => {
  const f = fixture({ acknowledge: async () => { throw Error('network interrupted'); } });
  await assert.rejects(f.service.notification(notification));
  assert.equal(await scalar('select public.native_billing_access($1,$2)', [cafe,'Sandbox']), true);
  let retried = false; f.adapter.acknowledge = async proof => { assert.equal(proof,'purchase-token'); retried = true; };
  assert.equal((await f.service.notification(notification)).kind, 'processed'); assert.equal(retried,true);
  assert.equal((await repository.read('google','Sandbox','purchase-token')).revision, 1);
});
test('duplicate store notifications do not repeat acknowledgements or grants', async () => {
  const f = fixture(); assert.equal((await f.service.notification(notification)).kind,'processed');
  assert.equal((await f.service.notification(notification)).kind,'duplicate');
  assert.deepEqual(f.counts(), { verifyCount: 1, ackCount: 1 });
});
test('event ID reuse with a changed payload is rejected', async () => {
  const f = fixture(); await f.service.notification(notification);
  await assert.rejects(f.service.notification({ ...notification, payload:'different authenticated payload' }), /identity conflict/);
});
test('unknown owners and unexpected environments never create entitlements', async () => {
  const f = fixture({ identify: async () => ({ binding:'00000000-0000-4000-8000-000000000009', providerSubscriptionId:'purchase-token' }) });
  await assert.rejects(f.service.reconcile(purchase), { code:'ACCOUNT_MISMATCH' });
  const wrong = fixture(); wrong.status.environment = 'Production';
  await assert.rejects(wrong.service.reconcile(purchase), { code:'PURCHASE_MISMATCH' });
  assert.equal(await repository.read('google','Sandbox','purchase-token'),null);
});
test('verified provider test notifications do not call purchase verification', async () => {
  const f = fixture(); assert.equal((await f.service.notification({ ...notification, test:true })).kind,'processed');
  assert.deepEqual(f.counts(), { verifyCount:0,ackCount:0 });
});

test('deleted account ownership survives for verified financial events without restoring access or transferring purchases', async () => {
  const f = fixture(); await f.service.reconcile(purchase);
  await db.query('delete from profiles where id=$1', [cafe]);
  f.status.needsAcknowledgement = false;
  assert.equal((await f.service.notification(notification)).kind, 'processed');
  assert.equal(await scalar('select public.native_billing_access($1,$2)', [cafe, 'Sandbox']), false);
  f.status.status = 'revoked'; f.status.access = 'free';
  assert.equal((await f.service.notification({ ...notification, eventId: 'refund-after-deletion', payload: 'verified-refund-event' })).kind, 'processed');
  assert.equal((await repository.read('google', 'Sandbox', 'purchase-token')).userId, cafe);
  assert.equal(await scalar('select public.native_billing_access($1,$2)', [cafe, 'Sandbox']), false);
  await assert.rejects(f.service.reconcile(purchase), { code: 'ACCOUNT_UNAVAILABLE' });
  await assert.rejects(f.service.reconcile({ ...purchase, accountId: other }), { code: 'ACCOUNT_MISMATCH' });
  await db.query("insert into profiles values($1,'cafe_owner_manager',null)", [cafe]);
});
