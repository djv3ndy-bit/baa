import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTypescript, plain } from './load-typescript.mjs';

function catalog(env = {}) {
  return loadTypescript('mobile/features/native-subscription/storeCatalog.ts', {}, { process: { env } });
}
const configured = {
  EXPO_PUBLIC_GOOGLE_PLAY_PRODUCT_ID: 'synthetic.pro.monthly',
  EXPO_PUBLIC_GOOGLE_PLAY_BASE_PLAN_ID: 'monthly-standard',
};

test('Android purchases remain disabled when either real Play catalog ID is missing', () => {
  for (const env of [{}, { EXPO_PUBLIC_GOOGLE_PLAY_PRODUCT_ID: configured.EXPO_PUBLIC_GOOGLE_PLAY_PRODUCT_ID },
    { EXPO_PUBLIC_GOOGLE_PLAY_BASE_PLAN_ID: configured.EXPO_PUBLIC_GOOGLE_PLAY_BASE_PLAN_ID }]) {
    assert.equal(catalog(env).approvedStorePlan('android'), null);
  }
});

test('invalid, reserved or padded Google IDs cannot enable Android purchases', () => {
  for (const productId of ['', 'YOUR_PRODUCT_ID', 'product-with-hyphens', '.product', ' product', 'product ', 'a'.repeat(41), 'android.test', 'android.test.purchased']) {
    assert.equal(catalog({ ...configured, EXPO_PUBLIC_GOOGLE_PLAY_PRODUCT_ID: productId }).approvedStorePlan('android'), null);
  }
  for (const basePlanId of ['', 'Monthly', 'monthly_plan', '-monthly', 'monthly-', 'monthly plan', 'monthly ', 'a'.repeat(64)]) {
    assert.equal(catalog({ ...configured, EXPO_PUBLIC_GOOGLE_PLAY_BASE_PLAN_ID: basePlanId }).approvedStorePlan('android'), null);
  }
});

test('a configured Google catalog retains real IDs and the approved U.S. monthly price', () => {
  const { approvedStorePlan } = catalog(configured);
  assert.deepEqual(plain(approvedStorePlan('android')), {
    id: configured.EXPO_PUBLIC_GOOGLE_PLAY_PRODUCT_ID, basePlanId: configured.EXPO_PUBLIC_GOOGLE_PLAY_BASE_PLAN_ID,
    provider: 'google', storefront: 'US', prices: { USD: 9.99 },
  });
  const mutable = approvedStorePlan('android'); mutable.prices.USD = 99; mutable.basePlanId = 'annual';
  assert.equal(approvedStorePlan('android').prices.USD, 9.99);
  assert.equal(approvedStorePlan('android').basePlanId, configured.EXPO_PUBLIC_GOOGLE_PLAY_BASE_PLAN_ID);
  assert.equal(approvedStorePlan('web'), null);
});

test('Google configuration never changes the verified Apple catalog', () => {
  for (const env of [{}, configured, { ...configured, EXPO_PUBLIC_GOOGLE_PLAY_BASE_PLAN_ID: 'INVALID' }]) {
    assert.deepEqual(plain(catalog(env).approvedStorePlan('ios')), {
      id: 'com.baristajobmatch.cafe.pro.monthly', provider: 'apple', storefront: 'US', prices: { USD: 9.99 },
    });
  }
});
