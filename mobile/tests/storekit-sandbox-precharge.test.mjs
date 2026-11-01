import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

// Execute the actual copied TS modules. Every dependency/native/network boundary
// is explicit; this suite never contacts a provider or opens a purchase sheet.
const require = createRequire(new URL('../package.json', import.meta.url));
const ts = require('typescript');
function load(path, mocks = {}) {
  const filename = fileURLToPath(new URL(`${process.env.BJM_TEST_SOURCE_ROOT || new URL('../', import.meta.url).href}${path}`));
  const module = { exports: {} };
  const js = ts.transpileModule(readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(js, { module, exports: module.exports, setTimeout, clearTimeout, Promise,
    fetch() { throw new Error('Unexpected network request'); },
    require(name) { if (Object.hasOwn(mocks, name)) return mocks[name]; throw new Error(`Unexpected dependency: ${name}`); },
  }, { filename });
  return module.exports;
}
const timeout = load('features/native-subscription/storeTimeout.ts');
const { ExpoStoreGateway } = load('features/native-subscription/expoStoreGateway.ts', { './storeTimeout': timeout });
const { nativePurchaseDependencies, checkedStoreContext, checkedSubscription } = load('features/native-subscription/nativeBillingClient.ts');
const { PurchaseCoordinator } = load('features/native-subscription/purchaseCoordinator.ts');
const plain = value => JSON.parse(JSON.stringify(value));
const sandbox = { storeEnvironment: 'Sandbox', appleSandboxTester: true };
const production = { storeEnvironment: 'Production', appleSandboxTester: false };
const account = { id: 'synthetic-cafe-a', role: 'cafe_owner_manager' };
const binding = '10000000-0000-4000-8000-000000000001';
const attemptId = '20000000-0000-4000-8000-000000000002';
const nativeSandbox = { environment: 'Sandbox', bundleId: 'com.baristajobmatch.app' };
const plan = { id: 'synthetic.monthly', provider: 'apple', storefront: 'US', prices: { USD: 9.99 } };
const row = { id: plan.id, platform: 'ios', type: 'subs', price: 9.99, currency: 'USD', displayPrice: '$9.99', subscriptionPeriodNumberIOS: '1', subscriptionPeriodUnitIOS: 'month' };
const receipt = { id: 'synthetic-transaction', productId: plan.id, store: 'apple', purchaseState: 'purchased', purchaseToken: 'synthetic-proof', appAccountToken: binding };
const free = { accountId: account.id, verified: true, provider: null, access: 'free', status: 'free', canManage: false, canPurchase: true, autoRenews: false, currentPeriodEnd: null };
function harness(options = {}) {
  const events = []; let current = account, verified = false, lookupCount = 0, storefrontCount = 0, requestCount = 0, errorListener;
  const context = options.context ?? sandbox;
  const api = {
    initConnection: async () => true, endConnection: async () => {},
    getStorefront: async () => options.storefront ? options.storefront(++storefrontCount) : 'USA', fetchProducts: async () => [row],
    purchaseUpdatedListener() { return { remove() {} }; },
    purchaseErrorListener(fn) { errorListener = fn; return { remove() {} }; },
    getAppTransactionIOS: options.missingNative ? undefined : async () => {
      events.push('native-guard');
      return options.native ? options.native(++lookupCount, value => { current = value; }) : nativeSandbox;
    },
    requestPurchase: async input => {
      events.push('sdk-purchase'); requestCount++;
      assert.equal(input.request.apple.appAccountToken, binding);
      return options.request ? options.request(requestCount, errorListener) : receipt;
    },
    restorePurchases: async () => { events.push('restore'); }, getAvailablePurchases: async () => [],
    finishTransaction: async () => { events.push('finish'); }, deepLinkToSubscriptions: async () => {},
  };
  const Gateway = options.Gateway || ExpoStoreGateway;
  const gateway = new Gateway(api, plan, () => {}, 500);
  const transport = [];
  const call = async (path, body, method, accountId, requestOptions) => {
    events.push(path.split('action=')[1] || 'verify');
    transport.push({ path, body: plain(body), method, accountId, requestOptions: requestOptions && plain(requestOptions) });
    assert.equal(accountId, account.id);
    if (path.endsWith('status')) return { ...free, ...(options.recovery ? { status: 'pending', canPurchase: false, canResumeAppleCheckout: true } : {}), ...(verified ? { provider: 'apple', access: 'pro', status: 'active', canPurchase: false } : {}), ...context };
    if (path.endsWith('prepare') || path.endsWith('resume')) return { attemptId, accountBinding: binding, ...context, ...options.prepareContext };
    if (path.endsWith('start')) {
      if (options.startError) throw new Error('Synthetic lost start response');
      return { started: true, ...context, ...options.startContext };
    }
    if (path.endsWith('cancel')) {
      if (options.cancelError) throw new Error('Synthetic cancellation failure');
      return { cancelled: options.cancelled !== false };
    }
    if (path === '/native-purchases') { verified = true; return { accountId: account.id, verified: true, purchase: { provider: 'apple', status: 'active' } }; }
    throw new Error('Unexpected API route');
  };
  const deps = nativePurchaseDependencies({ account: async () => current, call, store: gateway });
  const coordinator = new PurchaseCoordinator(deps);
  return { gateway, deps, coordinator, events, transport,
    async run() { const product = await gateway.product(); return options.recovery ? coordinator.resume(product) : coordinator.buy(product); },
    get requestCount() { return requestCount; },
  };
}
async function run(options, check) {
  const h = harness(options);
  try { await check(h, await h.run()); } finally { await h.gateway.dispose(); }
}

test('authenticated Sandbox path checks before start and again immediately before SDK purchase', async () => {
  await run({}, async (h, result) => {
    assert.equal(result.kind, 'verified');
    assert.deepEqual(h.events, ['status', 'prepare', 'native-guard', 'start', 'native-guard', 'sdk-purchase', 'verify', 'status', 'finish']);
    for (const request of h.transport.filter(value => /action=(prepare|start)$/.test(value.path))) assert.deepEqual(request.requestOptions, { storeGuard: 'apple-app-transaction-v1' });
    assert.equal(h.transport.some(value => value.body.storeEnvironment || value.body.appleSandboxTester), false);
  });
});
for (const [name, native, missingNative] of [
  ['missing API', undefined, true], ['unverified/nil', async () => null],
  ['Production installation', async () => ({ ...nativeSandbox, environment: 'Production' })],
  ['local Xcode StoreKit environment', async () => ({ ...nativeSandbox, environment: 'Xcode' })],
  ['wrong bundle', async () => ({ ...nativeSandbox, bundleId: 'invalid.other.app' })],
  ['native lookup rejects', async () => { throw new Error('Synthetic native error'); }],
]) test(`pre-start ${name} fails before start/purchase and cancels only never-started reservation`, async () => {
  await run({ native, missingNative }, async (h, result) => {
    assert.equal(result.kind, 'cancelled'); assert.equal(h.requestCount, 0);
    assert.equal(h.events.includes('start'), false);
    assert.deepEqual(h.transport.find(value => value.path.endsWith('cancel')).body, { attemptId, reason: 'store-guard-failed' });
  });
});
test('unconfirmed never-started cancellation remains pending', async () => {
  for (const option of [{ cancelled: false }, { cancelError: true }]) await run({ ...option, missingNative: true }, async (h, result) => {
    assert.equal(result.kind, 'pending'); assert.equal(h.requestCount, 0); assert.equal(h.events.includes('start'), false);
  });
});
test('native environment change after start blocks purchase and retains uncertain reservation', async () => {
  await run({ native: async count => count === 1 ? nativeSandbox : { ...nativeSandbox, environment: 'Production' } }, async (h, result) => {
    assert.equal(result.kind, 'pending'); assert.equal(h.requestCount, 0); assert.equal(h.events.includes('start'), true); assert.equal(h.events.includes('cancel'), false);
  });
});
test('post-start native user-cancelled lookup is never treated as canceled purchase', async () => {
  await run({ native: async count => { if (count > 1) throw { code: 'user-cancelled' }; return nativeSandbox; } }, async (h, result) => {
    assert.equal(result.kind, 'pending'); assert.equal(h.requestCount, 0); assert.equal(h.events.includes('cancel'), false);
  });
});
test('account switches during native lookup block SDK purchase and avoid cancellation as a new account', async () => {
  for (const at of [1, 2]) await run({ native: async (count, switchAccount) => { if (count === at) switchAccount({ ...account, id: 'synthetic-cafe-b' }); return nativeSandbox; } }, async (h, result) => {
    assert.equal(result.kind, 'pending'); assert.equal(h.requestCount, 0); assert.equal(h.events.includes('cancel'), false);
    assert.equal(h.events.includes('start'), at === 2);
  });
});
test('lost start response never opens SDK or guesses cancellation', async () => {
  await run({ startError: true }, async (h, result) => {
    assert.equal(result.kind, 'pending'); assert.equal(h.requestCount, 0); assert.equal(h.events.includes('cancel'), false);
  });
});
test('changed authenticated start context cannot downgrade Sandbox guard or launch purchase', async () => {
  await run({ startContext: production }, async (h, result) => {
    assert.equal(result.kind, 'pending'); assert.equal(h.requestCount, 0); assert.equal(h.events.includes('cancel'), false);
  });
});
test('prepare context downgrade fails closed before any native or start request', async () => {
  await run({ prepareContext: production }, async (h, result) => {
    assert.equal(result.kind, 'failed'); assert.equal(h.requestCount, 0); assert.equal(h.events.includes('start'), false); assert.equal(h.events.includes('native-guard'), false);
  });
});
test('inactive subscription retry rechecks native environment before each SDK request', async () => {
  for (const native of [
    async count => count < 3 ? nativeSandbox : { ...nativeSandbox, environment: 'Production' },
    async count => { if (count === 3) throw { code: 'user-cancelled' }; return nativeSandbox; },
  ]) await run({ native, request: async () => {
    throw { code: 'purchase-error', productId: plan.id, message: 'Finished an inactive subscription transaction. Please retry the purchase.' };
  } }, async (h, result) => {
    assert.equal(result.kind, 'pending'); assert.equal(h.requestCount, 1);
    assert.equal(h.events.filter(value => value === 'native-guard').length, 3); assert.equal(h.events.includes('cancel'), false);
  });
});
test('inactive retry storefront cancellation error is not a purchase cancellation', async () => {
  await run({ storefront: async count => { if (count === 4) throw { code: 'user-cancelled' }; return 'USA'; }, request: async () => {
    throw { code: 'purchase-error', productId: plan.id, message: 'Finished an inactive subscription transaction. Please retry the purchase.' };
  } }, async (h, result) => {
    assert.equal(result.kind, 'pending'); assert.equal(h.requestCount, 1); assert.equal(h.events.includes('cancel'), false);
  });
});
test('resume sends header, checks native environment and never cancels prior uncertain checkout', async () => {
  for (const native of [async () => null, async () => { throw { code: 'user-cancelled' }; }]) await run({ recovery: true, native }, async (h, result) => {
    assert.equal(result.kind, 'pending'); assert.equal(h.requestCount, 0); assert.equal(h.events.includes('start'), false); assert.equal(h.events.includes('cancel'), false);
    assert.deepEqual(h.transport.find(value => value.path.endsWith('resume')).requestOptions, { storeGuard: 'apple-app-transaction-v1' });
  });
});
test('actual SDK user cancellation after verified guard uses existing user-cancelled reservation path', async () => {
  await run({ request: async (_count, errorListener) => { errorListener({ code: 'user-cancelled' }); } }, async (h, result) => {
    assert.equal(result.kind, 'cancelled'); assert.equal(h.requestCount, 1);
    assert.equal(h.transport.find(value => value.path.endsWith('cancel')).body.reason, 'user-cancelled');
  });
});
test('legacy and explicit ordinary Production purchases never request AppTransaction (iOS15.1 compatible)', async () => {
  for (const context of [{}, production]) await run({ context, native: async () => { throw new Error('Must not run on ordinary Production'); } }, async (h, result) => {
    assert.equal(result.kind, 'verified'); assert.equal(h.requestCount, 1); assert.equal(h.events.includes('native-guard'), false);
  });
});
test('isolated QA Sandbox/false retains native Sandbox verification', async () => {
  await run({ context: { ...sandbox, appleSandboxTester: false } }, async (h, result) => {
    assert.equal(result.kind, 'verified'); assert.equal(h.events.filter(value => value === 'native-guard').length, 2);
  });
});
test('timed-out native app transaction blocks launch and cannot clear a started reservation', async () => {
  // Use the real timeout implementation with a short clock; no 20-second wait.
  const { ExpoStoreGateway: Gateway } = load('features/native-subscription/expoStoreGateway.ts', { './storeTimeout': { storeResponse: request => timeout.storeResponse(request, 5) } });
  for (const stuckAt of [1, 2]) await run({ Gateway, native: async count => count === stuckAt ? new Promise(() => {}) : nativeSandbox }, async (h, result) => {
    assert.equal(h.requestCount, 0); assert.equal(result.kind, stuckAt === 1 ? 'cancelled' : 'pending');
    assert.equal(h.events.includes('cancel'), stuckAt === 1);
  });
});
test('disposing while native guard is awaiting never issues a late SDK request', async () => {
  let entered, release;
  const waiting = new Promise(resolve => { entered = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  const h = harness({ native: async count => { if (count === 2) { entered(); return blocked; } return nativeSandbox; } });
  const result = h.run(); await waiting; await h.gateway.dispose(); release(nativeSandbox);
  assert.equal((await result).kind, 'pending');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.requestCount, 0); assert.equal(h.events.includes('cancel'), false);
});
test('Android gateway and transport retain original behavior without Apple guard or header', async () => {
  const googlePlan = { ...plan, provider: 'google', basePlanId: 'monthly' };
  const googleProduct = { ...row, platform: 'android', subscriptionOffers: [{ id: 'monthly', type: 'introductory', basePlanIdAndroid: 'monthly', offerTokenAndroid: 'synthetic-offer', pricingPhasesAndroid: { pricingPhaseList: [{ billingPeriod: 'P1M', recurrenceMode: 1, formattedPrice: '$9.99', priceAmountMicros: '9990000', priceCurrencyCode: 'USD' }] } }] };
  let count = 0;
  const gateway = new ExpoStoreGateway({
    initConnection: async () => true, endConnection: async () => {}, getStorefront: async () => 'US', fetchProducts: async () => [googleProduct],
    purchaseUpdatedListener: () => ({ remove() {} }), purchaseErrorListener: () => ({ remove() {} }),
    getAppTransactionIOS() { throw new Error('Android must never request Apple AppTransaction'); },
    requestPurchase: async input => { count++; assert.equal(input.request.google.obfuscatedAccountId, 'synthetic_google_binding'); return { ...receipt, store: 'google', appAccountToken: undefined, obfuscatedAccountIdAndroid: 'synthetic_google_binding' }; },
  }, googlePlan, () => {}, 500);
  try {
    const product = await gateway.product(); assert.equal((await gateway.buy(product, 'synthetic_google_binding', sandbox)).kind, 'purchased'); assert.equal(count, 1);
    const calls = [];
    const deps = nativePurchaseDependencies({ account: async () => account, store: { country: async () => 'USA', buy: async () => ({ kind: 'cancelled' }) },
      call: async (path, _body, _method, _accountId, options) => { calls.push(options); return path.endsWith('prepare') ? { attemptId, accountBinding: binding } : path.endsWith('start') ? { started: true } : { cancelled: true }; },
    });
    await deps.preflight(account.id, product); await deps.purchase(product, binding); assert.deepEqual(calls, [undefined, undefined, undefined]);
  } finally { await gateway.dispose(); }
});
test('context parser fails closed for partial, malformed, contradictory or downgraded responses', () => {
  for (const context of [{ storeEnvironment: 'Sandbox' }, { appleSandboxTester: true }, { storeEnvironment: null, appleSandboxTester: false }, { storeEnvironment: 'Other', appleSandboxTester: false }, { storeEnvironment: 'Sandbox', appleSandboxTester: 'yes' }, { ...production, appleSandboxTester: true }]) {
    assert.throws(() => checkedStoreContext(context)); assert.throws(() => checkedSubscription({ ...free, ...context }, account.id));
  }
  assert.throws(() => checkedStoreContext({}, sandbox)); assert.throws(() => checkedStoreContext(production, sandbox));
});
test('real authenticatedApi transports fixed header while retaining originating-session authorization', async () => {
  const calls = []; let current = account.id;
  const { authenticatedApi } = load('lib/api.ts', {
    './supabase': { APP_API_BASE: 'https://synthetic.invalid/api', supabase: { auth: { getSession: async () => ({ data: { session: { access_token: 'synthetic-session', user: { id: current } } } }) } } },
    './request': { requestJson: async (url, input) => { calls.push({ url, input }); return {}; } },
  });
  await authenticatedApi('/native-billing?action=prepare', {}, 'POST', account.id, { storeGuard: 'apple-app-transaction-v1', Authorization: 'forbidden-override' });
  assert.equal(calls[0].input.headers['X-BJM-Store-Guard'], 'apple-app-transaction-v1');
  assert.equal(calls[0].input.headers.Authorization, 'Bearer synthetic-session');
  await authenticatedApi('/native-billing?action=status', {}, 'GET', account.id);
  assert.equal(calls[1].input.headers['X-BJM-Store-Guard'], undefined);
  current = 'synthetic-cafe-b';
  await assert.rejects(authenticatedApi('/native-billing?action=start', {}, 'POST', account.id, { storeGuard: 'apple-app-transaction-v1' }), /account changed/);
  assert.equal(calls.length, 2);
});
