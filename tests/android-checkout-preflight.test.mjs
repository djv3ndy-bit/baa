import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeCheckoutService } from '../server/native-billing/checkoutService.mjs';
import { createNativeAccountService } from '../server/native-billing/checkoutRuntime.mjs';
import { nativeBillingRepository } from '../server/native-billing/repository.mjs';

const id = '10000000-0000-4000-8000-000000000001';
const binding = '20000000-0000-4000-8000-000000000001';
const account = { id: 'cafe-a', role: 'cafe_owner_manager' };
const google = { enabled: true, productId: 'synthetic.monthly', basePlanId: 'synthetic-monthly' };
const request = { provider: 'google', productId: google.productId, storefront: 'US' };
function harness(overrides = {}) {
  const calls = [];
  let provider = null;
  const repository = {
    checkoutProvider: async (...args) => { calls.push(['provider', ...args]); return provider; },
    claimCheckout: async (...args) => { calls.push(['claim', ...args]); provider = args[1]; return { attemptId: id, accountBinding: binding }; },
    startCheckout: async (...args) => { calls.push(['legacy-start', ...args]); return provider === 'apple'; },
    startCheckoutForProvider: async (...args) => { calls.push(['start', ...args]); return args[3] === provider; },
    cancelCheckout: async (...args) => { calls.push(['cancel', ...args]); return true; },
    settleVerifiedCheckout: async () => true, checkoutPending: async () => false,
    summary: async () => ({ accountId: account.id, environment: 'Sandbox', subscriptions: [] }),
    ...overrides.repository,
  };
  const service = nativeCheckoutService({ repository, environment: 'Sandbox', enabled: true,
    productId: 'apple.monthly', google, createId: () => id,
    ready: async value => calls.push(['ready', value]),
    inspectWebsiteBilling: async () => { calls.push(['inspect']); return true; },
    ...overrides, repository,
  });
  return { service, calls, repository };
}
test('Google preflight confirms selected runtime and migrated RPC before provider-bound claim', async () => {
  const h = harness();
  assert.deepEqual(await h.service.prepare(account, request), { attemptId: id, accountBinding: binding });
  assert.deepEqual(h.calls, [['ready', 'google'], ['provider', account.id, 'Sandbox', id],
    ['claim', account.id, 'google', 'Sandbox', id], ['inspect']]);
  await h.service.start(account, id);
  assert.deepEqual(h.calls.slice(-3), [['provider', account.id, 'Sandbox', id], ['ready', 'google'], ['start', account.id, 'Sandbox', id, 'google']]);
});
test('Google defaults closed and requires an explicit boolean gate plus both catalog IDs', async () => {
  for (const value of [undefined, { ...google, enabled: false }, { ...google, enabled: 'true' },
    { ...google, productId: '' }, { ...google, basePlanId: '' }]) {
    const h = harness({ google: value });
    await assert.rejects(h.service.prepare(account, request));
    assert.deepEqual(h.calls, []);
  }
  const h = harness({ enabled: false }); await assert.rejects(h.service.prepare(account, request)); assert.deepEqual(h.calls, []);
});
test('wrong role, suspension, product, provider and storefront cannot reserve Google checkout', async () => {
  for (const [member, input] of [[{ ...account, role: 'barista' }, request], [{ ...account, suspendedAt: 'now' }, request],
    [account, { ...request, productId: 'annual' }], [account, { ...request, provider: 'stripe' }],
    [account, { ...request, storefront: 'USA' }], [account, { ...request, storefront: 'CA' }]]) {
    const h = harness(); await assert.rejects(h.service.prepare(member, input)); assert.deepEqual(h.calls, []);
  }
});
test('Google runtime or missing migration fails before a reservation exists', async () => {
  for (const overrides of [{ ready: async () => { throw Error('missing Google configuration'); } },
    { repository: { checkoutProvider: async () => { throw Error('missing RPC'); } } }]) {
    const h = harness(overrides); await assert.rejects(h.service.prepare(account, request));
    assert.ok(!h.calls.some(row => row[0] === 'claim'));
  }
});
test('Google-enabled deployments without the new SQL also reject Apple before reserving', async () => {
  const h = harness({ repository: { checkoutProvider: async () => { throw Error('missing RPC'); } } });
  await assert.rejects(h.service.prepare(account, { provider: 'apple', productId: 'apple.monthly', storefront: 'USA' }));
  assert.deepEqual(h.calls, [['ready', 'apple']]);
});
test('website conflict releases only the unused Google reservation', async () => {
  const h = harness({ inspectWebsiteBilling: async () => false });
  await assert.rejects(h.service.prepare(account, request), { code: 'WEBSITE_BILLING_EXISTS' });
  assert.deepEqual(h.calls.at(-1), ['cancel', account.id, 'Sandbox', id, true]);
});
test('turning Google off after prepare prevents start while explicit cancellation stays available', async () => {
  const gate = { ...google }; const h = harness({ google: gate });
  await h.service.prepare(account, request); gate.enabled = false;
  await assert.rejects(h.service.start(account, id), { code: 'CHECKOUT_BLOCKED' });
  assert.ok(!h.calls.some(row => row[0] === 'start'));
  await h.service.cancel(account, id, 'user-cancelled');
  assert.deepEqual(h.calls.at(-1), ['cancel', account.id, 'Sandbox', id, false]);
  await assert.rejects(h.service.cancel(account, id, 'network-error'));
});
test('durable provider wins over any extra caller provider hint and invalid lookup cannot launch', async () => {
  const h = harness({ repository: { checkoutProvider: async () => 'google', startCheckoutForProvider: async (...args) => { h.calls.push(['start', ...args]); return true; } } });
  await h.service.start(account, id, 'apple');
  assert.deepEqual(h.calls, [['ready', 'google'], ['start', account.id, 'Sandbox', id, 'google']]);
  for (const provider of [null, 'stripe', 'APPLE', {}, true]) {
    const bad = harness({ repository: { checkoutProvider: async () => provider } });
    await assert.rejects(bad.service.start(account, id), { code: 'CHECKOUT_BLOCKED' }); assert.deepEqual(bad.calls, []);
  }
});
test('Google start readiness failure and atomic start rejection never authorize a launch', async () => {
  for (const overrides of [{ ready: async () => { throw Error('offline'); } }, { repository: { startCheckoutForProvider: async () => false } }]) {
    const h = harness({ ...overrides, repository: { checkoutProvider: async () => 'google', ...overrides.repository } });
    await assert.rejects(h.service.start(account, id));
  }
});
test('Apple prepare/start/resume retain their provider and never load Google configuration', async () => {
  const h = harness({ google: { enabled: false }, repository: { recoverAppleCheckout: async () => ({ attemptId: id, accountBinding: binding }) } });
  const input = { provider: 'apple', productId: 'apple.monthly', storefront: 'USA' };
  await h.service.prepare(account, input); await h.service.start(account, id);
  await h.service.resume(account, input, { plan: 'free', billingPaused: false });
  assert.ok(h.calls.filter(row => row[0] === 'ready').every(row => row[1] === 'apple'));
  assert.deepEqual(h.calls.find(row => row[0] === 'legacy-start'), ['legacy-start', account.id, 'Sandbox', id]);
  await assert.rejects(h.service.resume(account, request, { plan: 'free', billingPaused: false }));
});
test('default-off Apple checkout still works before any new provider RPC is deployed', async () => {
  const h = harness({ google: undefined, repository: {
    checkoutProvider: async () => { throw Error('new RPC is not installed'); },
    startCheckoutForProvider: async () => { throw Error('new RPC is not installed'); },
  } });
  await h.service.prepare(account, { provider: 'apple', productId: 'apple.monthly', storefront: 'USA' });
  assert.deepEqual(await h.service.start(account, id), { started: true });
  assert.deepEqual(h.calls.find(row => row[0] === 'legacy-start'), ['legacy-start', account.id, 'Sandbox', id]);
});
test('turning the global sales gate off blocks start but keeps explicit cancellation available', async () => {
  const h = harness({ enabled: false });
  await assert.rejects(h.service.start(account, id), { code: 'CHECKOUT_BLOCKED' });
  assert.deepEqual(await h.service.cancel(account, id, 'user-cancelled'), { cancelled: true });
  assert.deepEqual(h.calls, [['cancel', account.id, 'Sandbox', id, false]]);
});

const baseEnv = { NATIVE_BILLING_ENVIRONMENT: 'Sandbox', VERCEL_ENV: 'preview',
  NATIVE_PURCHASES_ENABLED: 'true', BILLING_ENABLED: 'true', NATIVE_GOOGLE_PURCHASES_ENABLED: 'true',
  GOOGLE_PLAY_PRODUCT_ID: google.productId, GOOGLE_PLAY_BASE_PLAN_ID: google.basePlanId };
function runtimeHarness(overrides = {}) {
  const h = harness(); const calls = [];
  const create = createNativeAccountService({ repository: h.repository, inspectWebsiteBilling: async () => true,
    environment: () => ({ ...baseEnv, ...overrides.env }),
    readConfiguration: (provider, env) => {
      calls.push(['config', provider]);
      if (overrides.failConfig === provider) throw Error('missing provider credentials');
      return { provider, environment: env.NATIVE_BILLING_ENVIRONMENT,
        productId: provider === 'apple' ? 'com.baristajobmatch.cafe.pro.monthly' : env.GOOGLE_PLAY_PRODUCT_ID,
        basePlanId: provider === 'google' ? env.GOOGLE_PLAY_BASE_PLAN_ID : undefined };
    },
    createRuntime: async config => { calls.push(['runtime', config.provider]); if (overrides.createRuntime) return overrides.createRuntime(config); return {}; },
  });
  return { service: create(), calls, create };
}
test('runtime requires global, website and Google gates together without initializing a provider when blocked', async () => {
  for (const env of [{ NATIVE_GOOGLE_PURCHASES_ENABLED: undefined }, { NATIVE_GOOGLE_PURCHASES_ENABLED: 'false' },
    { NATIVE_PURCHASES_ENABLED: 'false' }, { BILLING_ENABLED: 'false' }]) {
    const h = runtimeHarness({ env }); await assert.rejects(h.service.prepare(account, request)); assert.deepEqual(h.calls, []);
  }
});
test('Google-only setup does not require Apple credentials and uses a Google runtime', async () => {
  const h = runtimeHarness({ failConfig: 'apple' }); await h.service.prepare(account, request); await h.service.start(account, id);
  assert.ok(h.calls.every(row => row[1] === 'google'));
  assert.equal(h.calls.filter(row => row[0] === 'runtime').length, 1);
});
test('unconfigured Google does not break Apple readiness or shared status', async () => {
  const h = runtimeHarness({ failConfig: 'google', env: { GOOGLE_PLAY_PRODUCT_ID: '', GOOGLE_PLAY_BASE_PLAN_ID: '' } });
  const status = await h.service.status(account, { plan: 'free', billingPaused: false, connectedToBilling: false, canManageBilling: false });
  assert.equal(status.verified, true); assert.deepEqual(h.calls, []);
  await h.service.prepare(account, { provider: 'apple', productId: 'com.baristajobmatch.cafe.pro.monthly', storefront: 'USA' });
  assert.ok(h.calls.every(row => row[1] === 'apple'));
});
test('failed runtime initialization is evicted for a later safe preflight retry', async () => {
  let count = 0;
  const h = runtimeHarness({ createRuntime: async () => { if (++count === 1) throw Error('temporary startup failure'); return {}; } });
  await assert.rejects(h.service.prepare(account, request)); await h.service.prepare(account, request); assert.equal(count, 2);
});
test('repository routes lookup and atomic start with exact account/environment/provider and never retries start', async () => {
  const calls = [];
  const repository = nativeBillingRepository(async (path, options) => { calls.push([path, JSON.parse(options.body)]); if (path.endsWith('start_for_provider')) throw Error('Database request failed (503).'); return 'google'; });
  assert.equal(await repository.checkoutProvider(account.id, 'Sandbox', id), 'google');
  await assert.rejects(repository.startCheckoutForProvider(account.id, 'Sandbox', id, 'google'));
  assert.deepEqual(calls, [
    ['rpc/native_checkout_provider', { p_user_id: account.id, p_environment: 'Sandbox', p_attempt_id: id }],
    ['rpc/native_checkout_start_for_provider', { p_user_id: account.id, p_environment: 'Sandbox', p_attempt_id: id, p_provider: 'google' }],
  ]);
});
