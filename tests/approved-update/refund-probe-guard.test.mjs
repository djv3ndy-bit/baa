import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTypescript } from './load-typescript.mjs';
const { assertRefundTestContext, assertSandboxRefundPurchase, sandboxRefundProduct, sandboxRefundAccount } = loadTypescript('tests/native/apple-refund/guard.ts');
const context = { platform: 'ios', flag: 'isolated-apple-sandbox', api: 'https://testing.baristajobmatch.com/api', database: 'https://iqtpsxxlpncaeabbcxht.supabase.co', accountId: sandboxRefundAccount, role: 'cafe_owner_manager' };
const purchase = { store: 'apple', environmentIOS: 'Sandbox', productId: sandboxRefundProduct, purchaseState: 'purchased', purchaseToken: 'test-proof', appBundleIdIOS: 'com.baristajobmatch.app' };
test('refund probe rejects every non-test context before native access', () => {
  assert.doesNotThrow(() => assertRefundTestContext(context));
  for (const change of [{ platform: 'android' }, { flag: undefined }, { api: 'https://www.baristajobmatch.com/api' }, { database: 'https://lmwqrxoitraofaftpwhe.supabase.co' }, { accountId: 'other' }, { role: 'barista' }]) {
    assert.throws(() => assertRefundTestContext({ ...context, ...change }));
  }
});
test('refund probe requires the correct verified Sandbox purchase and bundle', () => {
  assert.doesNotThrow(() => assertSandboxRefundPurchase(purchase));
  for (const change of [{ store: 'google' }, { environmentIOS: 'Production' }, { environmentIOS: undefined }, { productId: 'other' }, { purchaseState: 'pending' }, { purchaseToken: '' }, { appBundleIdIOS: 'other' }]) {
    assert.throws(() => assertSandboxRefundPurchase({ ...purchase, ...change }));
  }
});
