import test from 'node:test';
import assert from 'node:assert/strict';
import {
  APPLE_STORE_GUARD,
  checkedBillingContext,
  requireStoreGuard,
  storeContextView,
} from '../../server/native-billing/billingContext.mjs';
import { nativeCheckoutService } from '../../server/native-billing/checkoutService.mjs';
import { verifiedAppleEvent } from '../../server/native-billing/appleEventRouter.mjs';

const mapped = { environment: 'Sandbox', appleSandboxTester: true };
const ordinary = { environment: 'Production', appleSandboxTester: false };
const isolatedQa = { environment: 'Sandbox', appleSandboxTester: false };

test('the mapped Apple guard protocol is an exact versioned contract', () => {
  assert.equal(APPLE_STORE_GUARD, 'apple-app-transaction-v1');
});

test('trusted contexts preserve ordinary Production, isolated Sandbox QA, and mapped Apple Sandbox', () => {
  for (const value of [ordinary, isolatedQa, mapped]) {
    const checked = checkedBillingContext({ ...value });
    assert.equal(checked.environment, value.environment);
    assert.equal(checked.appleSandboxTester, value.appleSandboxTester);
  }
});

test('a mapped tester can never resolve to Production', () => {
  assert.throws(() => checkedBillingContext({ environment: 'Production', appleSandboxTester: true }));
});

test('malformed environment contexts fail closed instead of defaulting to Production or Sandbox', () => {
  const invalid = [
    undefined, null, false, true, 0, '', 'Sandbox', [], [mapped],
    Object.assign([], mapped),
    {}, { environment: 'Sandbox' }, { appleSandboxTester: false },
    { environment: '', appleSandboxTester: false },
    { environment: 'sandbox', appleSandboxTester: false },
    { environment: 'production', appleSandboxTester: false },
    { environment: 'Xcode', appleSandboxTester: false },
    { environment: ['Sandbox'], appleSandboxTester: false },
    { environment: new String('Production'), appleSandboxTester: false },
    ...['false', 'true', 0, 1, null, undefined, [], {}].map(appleSandboxTester => ({ environment: 'Sandbox', appleSandboxTester })),
  ];
  for (const value of invalid) assert.throws(() => checkedBillingContext(value));
});

test('the client context view exposes only the store environment and tester boolean', () => {
  for (const value of [ordinary, isolatedQa, mapped]) {
    const view = storeContextView({ ...value, accountBinding: 'internal-binding', canPurchase: true });
    assert.deepEqual(view, { storeEnvironment: value.environment, appleSandboxTester: value.appleSandboxTester });
  }
});

test('mapped Apple checkout accepts only the exact guard protocol string', () => {
  assert.doesNotThrow(() => requireStoreGuard(mapped, APPLE_STORE_GUARD));
  const rejected = [
    undefined, null, '', false, true, 0, 1,
    'apple-app-transaction-v0', 'apple-app-transaction-v2',
    ` ${APPLE_STORE_GUARD}`, `${APPLE_STORE_GUARD} `,
    APPLE_STORE_GUARD.toUpperCase(),
    [], [APPLE_STORE_GUARD], { protocol: APPLE_STORE_GUARD },
    new String(APPLE_STORE_GUARD),
  ];
  for (const protocol of rejected) {
    assert.throws(() => requireStoreGuard(mapped, protocol), { code: 'STORE_GUARD_REQUIRED' });
  }
});

test('unmapped Production and isolated Sandbox QA retain their existing protocol behavior', () => {
  for (const context of [ordinary, isolatedQa]) {
    for (const protocol of [undefined, null, '', 'older-client', APPLE_STORE_GUARD, [APPLE_STORE_GUARD]]) {
      assert.doesNotThrow(() => requireStoreGuard(context, protocol));
    }
    assert.equal(checkedBillingContext(context).appleSandboxTester, false);
  }
});

const account = { id: '30000000-0000-4000-8000-000000000001', role: 'cafe_owner_manager' };
const attemptId = '10000000-0000-4000-8000-000000000001';
const accountBinding = '20000000-0000-4000-8000-000000000001';
const attempt = { attemptId, accountBinding };
const request = { provider: 'apple', productId: 'approved.monthly', storefront: 'USA' };
const website = { plan: 'free', connectedToBilling: false, canManageBilling: false, billingPaused: false };

function checkoutHarness(options = {}) {
  const calls = [];
  const context = options.context || mapped;
  let reads = 0;
  const repository = {
    async claimCheckout(...args) { calls.push(['claim', ...args]); return attempt; },
    async recoverAppleCheckout(...args) { calls.push(['recover', ...args]); return attempt; },
    async startCheckout(...args) { calls.push(['start', ...args]); return options.startResult !== false; },
    async cancelCheckout(...args) { calls.push(['cancel', ...args]); return options.cancelResult !== false; },
    async attemptContext(...args) {
      calls.push(['attempt', ...args]);
      return Object.hasOwn(options, 'recorded') ? options.recorded
        : { environment: context.environment, provider: 'apple', guardProtocol: context.appleSandboxTester ? APPLE_STORE_GUARD : null };
    },
    async settleVerifiedCheckout(...args) { calls.push(['settle', ...args]); return true; },
    async summary(userId, environment) {
      calls.push(['summary', userId, environment]);
      return { accountId: userId, environment: options.summaryEnvironment || environment, subscriptions: options.nativeRows || [] };
    },
    async checkoutPending(...args) { calls.push(['pending', ...args]); return options.checkoutPending === true; },
  };
  if (options.legacyRepository) delete repository.attemptContext;
  const service = nativeCheckoutService({
    repository,
    environment: options.environment || 'Production',
    ...(options.withContext === false ? {} : { contextFor: async (userId, provider) => {
      calls.push(['context', userId, provider]);
      reads++;
      return options.resolve ? options.resolve(reads, userId, provider) : { ...context };
    } }),
    enabled: true,
    productId: request.productId,
    createId: () => attemptId,
    ready: async selected => { calls.push(['ready', selected]); },
    inspectWebsiteBilling: async userId => { calls.push(['inspect', userId]); return options.websiteAllowed !== false; },
  });
  return { service, calls };
}

const launch = {
  prepare: (service, protocol, body = request) => service.prepare(account, body, protocol),
  resume: (service, protocol, body = request) => service.resume(account, body, website, protocol),
  start: (service, protocol) => service.start(account, attemptId, protocol),
};

for (const [name, invoke] of Object.entries(launch)) {
  test(`mapped ${name} rejects missing, incorrect, and array-spoofed guards before billing work`, async () => {
    for (const protocol of [undefined, null, 'old-client', [APPLE_STORE_GUARD]]) {
      const h = checkoutHarness();
      await assert.rejects(invoke(h.service, protocol), { code: 'STORE_GUARD_REQUIRED' });
      assert.deepEqual(h.calls, [['context', account.id, 'apple']]);
    }
  });
}

test('mapped prepare reserves only the trusted Sandbox context and ignores forged request context', async () => {
  const h = checkoutHarness();
  const result = await h.service.prepare(account, { ...request, accountId: 'another-account', environment: 'Production', appleSandboxTester: false }, APPLE_STORE_GUARD);
  assert.deepEqual(result, { ...attempt, storeEnvironment: 'Sandbox', appleSandboxTester: true });
  assert.deepEqual(h.calls, [
    ['context', account.id, 'apple'], ['ready', mapped],
    ['claim', account.id, 'apple', 'Sandbox', attemptId, APPLE_STORE_GUARD],
    ['inspect', account.id], ['context', account.id, 'apple'],
  ]);
});

test('mapped resume reuses the guarded Sandbox reservation without creating another claim', async () => {
  const h = checkoutHarness();
  assert.deepEqual(await h.service.resume(account, request, website, APPLE_STORE_GUARD), {
    ...attempt, storeEnvironment: 'Sandbox', appleSandboxTester: true,
  });
  assert.deepEqual(h.calls, [
    ['context', account.id, 'apple'], ['ready', mapped],
    ['recover', account.id, 'Sandbox', APPLE_STORE_GUARD],
    ['inspect', account.id], ['context', account.id, 'apple'],
  ]);
});

test('mapped start requires the owned recorded Sandbox guard and returns the same store context', async () => {
  const h = checkoutHarness();
  assert.deepEqual(await h.service.start(account, attemptId, APPLE_STORE_GUARD), {
    started: true, storeEnvironment: 'Sandbox', appleSandboxTester: true,
  });
  assert.deepEqual(h.calls, [
    ['context', account.id, 'apple'], ['attempt', account.id, attemptId],
    ['ready', mapped], ['start', account.id, 'Sandbox', attemptId, APPLE_STORE_GUARD],
  ]);
});

test('normal Production and isolated Sandbox QA do not acquire a new guard requirement', async () => {
  for (const context of [ordinary, isolatedQa]) {
    const h = checkoutHarness({ context });
    const result = await h.service.prepare(account, request);
    assert.deepEqual(result, { ...attempt, storeEnvironment: context.environment, appleSandboxTester: false });
    assert.deepEqual(h.calls.find(call => call[0] === 'claim'), ['claim', account.id, 'apple', context.environment, attemptId]);
    const resumed = checkoutHarness({ context });
    await resumed.service.resume(account, request, website);
    assert.deepEqual(resumed.calls.find(call => call[0] === 'recover'), ['recover', account.id, context.environment]);
    const started = checkoutHarness({ context });
    await started.service.start(account, attemptId);
    assert.deepEqual(started.calls.find(call => call[0] === 'start'), ['start', account.id, context.environment, attemptId]);
  }
});

test('the legacy service without a context resolver preserves response shape and Production calls', async () => {
  const h = checkoutHarness({ withContext: false, context: ordinary, legacyRepository: true });
  assert.deepEqual(await h.service.prepare(account, request), attempt);
  assert.deepEqual(await h.service.start(account, attemptId), { started: true });
  const status = await h.service.status(account, website);
  assert.equal(status.access, 'free');
  assert.equal(Object.hasOwn(status, 'storeEnvironment'), false);
  assert.equal(Object.hasOwn(status, 'appleSandboxTester'), false);
  assert.deepEqual(h.calls.find(call => call[0] === 'claim'), ['claim', account.id, 'apple', 'Production', attemptId]);
  assert.deepEqual(h.calls.find(call => call[0] === 'start'), ['start', account.id, 'Production', attemptId]);
  assert.deepEqual(h.calls.filter(call => call[0] === 'settle'), [['settle', account.id, 'Production']]);
});

test('context lookup failure never falls back to Production billing work', async () => {
  const failure = new Error('Context unavailable');
  for (const invoke of [
    service => service.status(account, website),
    ...Object.values(launch).map(operation => service => operation(service, APPLE_STORE_GUARD)),
  ]) {
    const h = checkoutHarness({ resolve: () => { throw failure; } });
    await assert.rejects(invoke(h.service), error => error === failure);
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0][0], 'context');
  }
});

test('revoked mappings can cancel the exact owned recorded Sandbox attempt without current eligibility', async () => {
  for (const [reason, beforeLaunch] of [['store-guard-failed', true], ['user-cancelled', false]]) {
    const h = checkoutHarness({ resolve: () => { throw new Error('Mapping revoked'); }, recorded: { environment: 'Sandbox', provider: 'apple', guardProtocol: APPLE_STORE_GUARD } });
    assert.deepEqual(await h.service.cancel(account, attemptId, reason), { cancelled: true });
    assert.deepEqual(h.calls, [
      ['attempt', account.id, attemptId], ['cancel', account.id, 'Sandbox', attemptId, beforeLaunch],
    ]);
  }
});

test('cleanup rejects missing ownership and uncertain cancellation reasons without a cancellation call', async () => {
  const missing = checkoutHarness({ recorded: null });
  await assert.rejects(missing.service.cancel(account, attemptId, 'store-guard-failed'), { code: 'CHECKOUT_BLOCKED' });
  assert.deepEqual(missing.calls, [['attempt', account.id, attemptId]]);
  for (const reason of ['network-error', 'pending', 'no-purchases', '']) {
    const h = checkoutHarness();
    await assert.rejects(h.service.cancel(account, attemptId, reason), { code: 'INVALID_CANCELLATION' });
    assert.deepEqual(h.calls, []);
  }
});

test('wrong, stale, or unguarded recorded attempts cannot reach startup readiness', async () => {
  for (const recorded of [
    null,
    { environment: 'Production', provider: 'apple', guardProtocol: APPLE_STORE_GUARD },
    { environment: 'Sandbox', provider: 'google', guardProtocol: APPLE_STORE_GUARD },
    { environment: 'Sandbox', provider: 'apple', guardProtocol: null },
    { environment: 'Sandbox', provider: 'apple', guardProtocol: [APPLE_STORE_GUARD] },
  ]) {
    const h = checkoutHarness({ recorded });
    await assert.rejects(h.service.start(account, attemptId, APPLE_STORE_GUARD), { code: 'CHECKOUT_BLOCKED' });
    assert.deepEqual(h.calls, [['context', account.id, 'apple'], ['attempt', account.id, attemptId]]);
  }
  const revoked = checkoutHarness({ context: ordinary, recorded: { environment: 'Sandbox', provider: 'apple', guardProtocol: APPLE_STORE_GUARD } });
  await assert.rejects(revoked.service.start(account, attemptId, APPLE_STORE_GUARD), { code: 'CHECKOUT_BLOCKED' });
  assert.equal(revoked.calls.some(call => ['ready', 'start'].includes(call[0])), false);
});

test('a denied atomic start never reports launch success or releases a possibly started attempt', async () => {
  const h = checkoutHarness({ startResult: false });
  await assert.rejects(h.service.start(account, attemptId, APPLE_STORE_GUARD), { code: 'CHECKOUT_BLOCKED' });
  assert.deepEqual(h.calls.at(-1), ['start', account.id, 'Sandbox', attemptId, APPLE_STORE_GUARD]);
  assert.equal(h.calls.some(call => call[0] === 'cancel'), false);
});

test('a mapping change during prepare cancels only the unused reservation in its recorded Sandbox environment', async () => {
  const h = checkoutHarness({ resolve: count => count === 1 ? mapped : ordinary });
  await assert.rejects(h.service.prepare(account, request, APPLE_STORE_GUARD), { code: 'CHECKOUT_BLOCKED' });
  assert.deepEqual(h.calls.at(-1), ['cancel', account.id, 'Sandbox', attemptId, true]);
});

test('a mapping change during resume never allocates or cancels the original started attempt', async () => {
  const h = checkoutHarness({ resolve: count => count === 1 ? mapped : ordinary });
  await assert.rejects(h.service.resume(account, request, website, APPLE_STORE_GUARD), { code: 'CHECKOUT_BLOCKED' });
  assert.equal(h.calls.filter(call => call[0] === 'recover').length, 1);
  assert.equal(h.calls.some(call => ['claim', 'cancel', 'start'].includes(call[0])), false);
});

test('status uses the same trusted environment for summary, pending state, and public store context', async () => {
  for (const context of [mapped, ordinary, isolatedQa]) {
    const h = checkoutHarness({ context });
    const result = await h.service.status(account, { ...website, status: 'trialing', complimentaryAccess: true });
    assert.equal(result.access, 'free', 'The mapping and complimentary/local trial do not grant paid access');
    assert.equal(result.canPurchase, true);
    assert.equal(result.storeEnvironment, context.environment);
    assert.equal(result.appleSandboxTester, context.appleSandboxTester);
    assert.deepEqual(h.calls.filter(call => ['summary', 'pending'].includes(call[0])), [
      ['summary', account.id, context.environment], ['pending', account.id, context.environment],
    ]);
    assert.deepEqual(h.calls.filter(call => call[0] === 'settle'), [
      ['settle', account.id, 'Production'], ['settle', account.id, 'Sandbox'],
    ]);
  }
});

test('status grants Pro only from a matching environment summary and denies a stale resolved context', async () => {
  const nativeRows = [{ provider: 'apple', status: 'active', currentPeriodEnd: '2099-01-01T00:00:00Z', gracePeriodEnd: null, autoRenews: true }];
  for (const context of [mapped, ordinary]) {
    const h = checkoutHarness({ context, nativeRows });
    const result = await h.service.status(account, website);
    assert.equal(result.access, 'pro'); assert.equal(result.canPurchase, false);
    assert.equal(result.storeEnvironment, context.environment);
  }
  const wrongEnvironment = checkoutHarness({ summaryEnvironment: 'Production', nativeRows });
  await assert.rejects(wrongEnvironment.service.status(account, website));
  const stale = checkoutHarness({ nativeRows, resolve: count => count === 1 ? mapped : ordinary });
  await assert.rejects(stale.service.status(account, website), { code: 'CHECKOUT_BLOCKED' });
});

test('lazy resume website lookup is never invoked for an unsupported mapped store guard', async () => {
  for (const protocol of [undefined, 'old-client', [APPLE_STORE_GUARD]]) {
    const h = checkoutHarness();
    let websiteReads = 0;
    await assert.rejects(h.service.resume(account, request, async () => { websiteReads++; return website; }, protocol), { code: 'STORE_GUARD_REQUIRED' });
    assert.equal(websiteReads, 0);
    assert.deepEqual(h.calls, [['context', account.id, 'apple']]);
  }
});

test('lazy resume validates website state after the guard and readiness but before recovering the attempt', async () => {
  const h = checkoutHarness();
  const result = await h.service.resume(account, request, async () => { h.calls.push(['website']); return website; }, APPLE_STORE_GUARD);
  assert.equal(result.storeEnvironment, 'Sandbox');
  assert.deepEqual(h.calls.map(call => call[0]), ['context', 'ready', 'website', 'recover', 'inspect', 'context']);
});

test('failed or paid lazy website status never recovers or cancels the original started checkout', async () => {
  const failure = new Error('Website status unavailable');
  for (const read of [async () => { throw failure; }, async () => ({ ...website, plan: 'pro' }), async () => ({ ...website, billingPaused: true })]) {
    const h = checkoutHarness();
    await assert.rejects(h.service.resume(account, request, read, APPLE_STORE_GUARD));
    assert.deepEqual(h.calls.map(call => call[0]), ['context', 'ready']);
  }
});

const signedPayload = 'opaque-header.eyJlbnZpcm9ubWVudCI6IlNhbmRib3gifQ.opaque-signature';

test('Apple events begin with the server-selected Production runtime and return its fully verified event', async () => {
  const calls = [], event = { provider: 'apple', eventId: 'production-event', proof: 'verified-production-proof' };
  const runtime = { provider: { notification: async payload => { calls.push(['verify', payload]); return event; } } };
  const result = await verifiedAppleEvent(async environment => { calls.push(['runtime', environment]); return runtime; }, signedPayload, 'Production');
  assert.equal(result.runtime, runtime); assert.equal(result.event, event);
  assert.deepEqual(calls, [['runtime', 'Production'], ['verify', signedPayload]], 'An unverified Sandbox claim in the payload cannot select the initial runtime');
});

test('only an officially classified Production environment mismatch permits one full Sandbox verification', async () => {
  const calls = [], mismatch = new Error('Official Apple environment mismatch');
  const event = { provider: 'apple', eventId: 'sandbox-event', proof: 'verified-sandbox-proof' };
  const production = {
    provider: { notification: async payload => { calls.push(['verify', 'Production', payload]); throw mismatch; } },
    isEnvironmentMismatch: error => { calls.push(['classify', error]); return error === mismatch; },
  };
  const sandbox = { provider: { notification: async payload => { calls.push(['verify', 'Sandbox', payload]); return event; } } };
  const result = await verifiedAppleEvent(async environment => {
    calls.push(['runtime', environment]); return environment === 'Production' ? production : sandbox;
  }, signedPayload, 'Production');
  assert.equal(result.runtime, sandbox); assert.equal(result.event, event);
  assert.deepEqual(calls, [
    ['runtime', 'Production'], ['verify', 'Production', signedPayload], ['classify', mismatch],
    ['runtime', 'Sandbox'], ['verify', 'Sandbox', signedPayload],
  ]);
});

test('signature, network, product and spoofed error-code failures never trigger Sandbox fallback', async () => {
  for (const failure of [
    Object.assign(new Error('Invalid signature'), { code: 'INVALID_PROOF' }),
    new Error('Network unavailable'),
    Object.assign(new Error('Product mismatch'), { code: 'PRODUCT_MISMATCH' }),
    Object.assign(new Error('Attacker-supplied environment mismatch text'), { code: 'ENVIRONMENT_MISMATCH' }),
  ]) {
    const calls = [];
    const runtime = {
      provider: { notification: async payload => { calls.push(['verify', payload]); throw failure; } },
      isEnvironmentMismatch: error => { assert.equal(error, failure); return false; },
    };
    await assert.rejects(verifiedAppleEvent(async environment => { calls.push(['runtime', environment]); return runtime; }, signedPayload, 'Production'), error => error === failure);
    assert.deepEqual(calls, [['runtime', 'Production'], ['verify', signedPayload]]);
  }
});

test('absence of the official mismatch predicate cannot be replaced by an error message or code', async () => {
  const failure = Object.assign(new Error('Environment mismatch'), { code: 'ENVIRONMENT_MISMATCH' });
  const calls = [];
  await assert.rejects(verifiedAppleEvent(async environment => {
    calls.push(environment); return { provider: { notification: async () => { throw failure; } } };
  }, signedPayload, 'Production'), error => error === failure);
  assert.deepEqual(calls, ['Production']);
});

test('a failed Sandbox fallback propagates without another runtime or verification attempt', async () => {
  const mismatch = new Error('Official mismatch'), sandboxFailure = new Error('Sandbox signature rejected'), calls = [];
  await assert.rejects(verifiedAppleEvent(async environment => {
    calls.push(['runtime', environment]);
    return {
      provider: { notification: async payload => { calls.push(['verify', environment, payload]); throw environment === 'Production' ? mismatch : sandboxFailure; } },
      isEnvironmentMismatch: error => { assert.equal(environment, 'Production', 'A Sandbox failure cannot start another fallback'); return error === mismatch; },
    };
  }, signedPayload, 'Production'), error => error === sandboxFailure);
  assert.deepEqual(calls, [
    ['runtime', 'Production'], ['verify', 'Production', signedPayload],
    ['runtime', 'Sandbox'], ['verify', 'Sandbox', signedPayload],
  ]);
});

test('initial isolated Sandbox events never attempt Production, even when verification reports a mismatch', async () => {
  const failure = new Error('Sandbox environment mismatch'), calls = [];
  await assert.rejects(verifiedAppleEvent(async environment => {
    calls.push(['runtime', environment]);
    return {
      provider: { notification: async payload => { calls.push(['verify', environment, payload]); throw failure; } },
      isEnvironmentMismatch: () => { throw new Error('Sandbox must not consult a Production fallback predicate'); },
    };
  }, signedPayload, 'Sandbox'), error => error === failure);
  assert.deepEqual(calls, [['runtime', 'Sandbox'], ['verify', 'Sandbox', signedPayload]]);
});

test('successful isolated Sandbox verification preserves that runtime and does not parse the raw payload', async () => {
  const payload = '{"environment":"Production","accountId":"untrusted"}', calls = [];
  const event = { provider: 'apple', eventId: 'verified-isolated-event', proof: 'verified-proof' };
  const runtime = { provider: { notification: async value => { assert.equal(value, payload); return event; } } };
  const result = await verifiedAppleEvent(async environment => { calls.push(environment); return runtime; }, payload, 'Sandbox');
  assert.equal(result.runtime, runtime); assert.equal(result.event, event); assert.deepEqual(calls, ['Sandbox']);
});

test('invalid server environment and runtime setup failures cannot cause a verifier fallback', async () => {
  for (const environment of [undefined, null, '', 'production', 'Xcode', ['Production']]) {
    let runtimeCalls = 0;
    await assert.rejects(verifiedAppleEvent(async () => { runtimeCalls++; throw new Error('Must not initialize'); }, signedPayload, environment));
    assert.equal(runtimeCalls, 0);
  }
  const failure = new Error('Runtime unavailable'), calls = [];
  await assert.rejects(verifiedAppleEvent(async environment => { calls.push(environment); throw failure; }, signedPayload, 'Production'), error => error === failure);
  assert.deepEqual(calls, ['Production']);
});
