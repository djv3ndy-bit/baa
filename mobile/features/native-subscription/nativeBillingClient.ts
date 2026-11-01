import type { PurchaseDependencies, PurchaseResult, StoreProduct, StorePurchase, StoreCheckoutContext, VerifiedSubscription } from './purchaseCoordinator';

export type BillingTransport = (path: string, body: Record<string, unknown>, method: 'GET' | 'POST', accountId: string, options?: { storeGuard?: 'apple-app-transaction-v1' }) => Promise<unknown>;
export type PurchaseStore = {
  country(): Promise<string>;
  assertPurchaseEnvironment?(context: StoreCheckoutContext): Promise<void>;
  buy(product: StoreProduct, accountBinding: string, context?: StoreCheckoutContext, beforePurchase?: () => Promise<void>): Promise<PurchaseResult>;
  resume?(product: StoreProduct, accountBinding: string, context?: StoreCheckoutContext, beforePurchase?: () => Promise<void>): Promise<PurchaseResult>;
  restore(): Promise<StorePurchase[]>;
  finish(purchase: StorePurchase): Promise<void>;
};
type AccountReader = PurchaseDependencies['account'];
const statuses = ['free', 'active', 'grace', 'pending', 'expired', 'revoked', 'payment_required'];
const record = (value: unknown): Record<string, any> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Subscription confirmation is unavailable.');
  return value as Record<string, any>;
};
/** These values come only from the authenticated billing response. The capability
 * header cannot choose a store environment or make an account a tester. Legacy
 * production responses may omit both fields; partial/contradictory values fail. */
export function checkedStoreContext(value: unknown, expected?: StoreCheckoutContext): StoreCheckoutContext {
  const row = record(value);
  const context: StoreCheckoutContext = row.storeEnvironment === undefined && row.appleSandboxTester === undefined
    ? { storeEnvironment: 'Production', appleSandboxTester: false }
    : { storeEnvironment: row.storeEnvironment, appleSandboxTester: row.appleSandboxTester };
  if (!['Production', 'Sandbox'].includes(context.storeEnvironment) || typeof context.appleSandboxTester !== 'boolean'
    || (context.appleSandboxTester && context.storeEnvironment !== 'Sandbox')
    || (expected && (context.storeEnvironment !== expected.storeEnvironment || context.appleSandboxTester !== expected.appleSandboxTester))) {
    throw new Error('The store environment could not be confirmed. Reload your subscription.');
  }
  return context;
}
export function checkedSubscription(value: unknown, accountId: string): VerifiedSubscription {
  const row = record(value);
  if (row.accountId !== accountId || row.verified !== true || !['free', 'pro'].includes(row.access)
    || ![null, 'apple', 'google', 'stripe'].includes(row.provider) || !statuses.includes(row.status)
    || typeof row.canPurchase !== 'boolean' || typeof row.canManage !== 'boolean' || typeof row.autoRenews !== 'boolean'
    || (row.currentPeriodEnd !== null && (typeof row.currentPeriodEnd !== 'string' || !Number.isFinite(Date.parse(row.currentPeriodEnd))))) {
    throw new Error('Subscription confirmation is unavailable.');
  }
  if (row.gracePeriodEnd !== undefined && row.gracePeriodEnd !== null
    && (typeof row.gracePeriodEnd !== 'string' || !Number.isFinite(Date.parse(row.gracePeriodEnd)))) throw new Error('Subscription confirmation is unavailable.');
  if (row.subscriptions !== undefined && (!Array.isArray(row.subscriptions) || row.subscriptions.some((item: any) =>
    !item || !['apple', 'google', 'stripe'].includes(item.provider) || !['free', 'pro'].includes(item.access) || typeof item.canManage !== 'boolean'))) {
    throw new Error('Subscription confirmation is unavailable.');
  }
  if (row.canResumeAppleCheckout !== undefined && typeof row.canResumeAppleCheckout !== 'boolean') throw new Error('Subscription confirmation is unavailable.');
  checkedStoreContext(row);
  return row as VerifiedSubscription;
}

/** The caller supplies the existing authenticatedApi transport. Its expected
 * account check stays in force on every request, including verification. */
export function nativePurchaseDependencies({ account, call, store }: { account: AccountReader; call: BillingTransport; store: PurchaseStore }): PurchaseDependencies {
  let prepared: { accountId: string; attemptId: string; binding: string; productId: string; provider: StoreProduct['provider']; basePlanId?: string; storefront: string; recovery?: boolean; context: StoreCheckoutContext } | null = null;
  let confirmedContext: { accountId: string; context: StoreCheckoutContext } | null = null;
  const guardOptions = { storeGuard: 'apple-app-transaction-v1' as const };
  const requireAccount = async (expected?: string) => {
    const current = await account();
    if (!current || current.role !== 'cafe_owner_manager' || (expected && current.id !== expected)) throw new Error('Please review the signed-in café account.');
    return current;
  };
  const status = async (accountId: string) => {
    await requireAccount(accountId);
    const result = checkedSubscription(await call('/native-billing?action=status', {}, 'GET', accountId), accountId);
    await requireAccount(accountId);
    confirmedContext = { accountId, context: checkedStoreContext(result) };
    return result;
  };
  return {
    account, status,
    async preflight(accountId, product) {
      await requireAccount(accountId);
      const selection = { provider: product.provider, productId: product.id, basePlanId: product.basePlanId };
      if (selection.provider === 'google' && !selection.basePlanId) throw new Error('Subscription plan unavailable.');
      const storefront = await store.country();
      const response = record(await call('/native-billing?action=prepare', { provider: selection.provider, productId: selection.productId, storefront,
        ...(selection.provider === 'google' ? { basePlanId: selection.basePlanId } : {}) }, 'POST', accountId, selection.provider === 'apple' ? guardOptions : undefined));
      const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
      if (!uuid.test(response.attemptId) || !uuid.test(response.accountBinding)) throw new Error('Purchase preparation could not be confirmed.');
      await requireAccount(accountId);
      const context = checkedStoreContext(response, confirmedContext?.accountId === accountId ? confirmedContext.context : undefined);
      prepared = { accountId, attemptId: response.attemptId, binding: response.accountBinding, ...selection, storefront, context };
      return { attemptId: response.attemptId, accountBinding: response.accountBinding };
    },
    async resumePreflight(accountId, product) {
      await requireAccount(accountId);
      if (product.provider !== 'apple' || !store.resume) throw new Error('Apple checkout recovery is unavailable.');
      const storefront = await store.country();
      const response = record(await call('/native-billing?action=resume', { provider: product.provider, productId: product.id, storefront }, 'POST', accountId, guardOptions));
      const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
      if (!uuid.test(response.attemptId) || !uuid.test(response.accountBinding)) throw new Error('Purchase recovery could not be confirmed.');
      await requireAccount(accountId);
      const context = checkedStoreContext(response, confirmedContext?.accountId === accountId ? confirmedContext.context : undefined);
      prepared = { accountId, attemptId: response.attemptId, binding: response.accountBinding, productId: product.id, provider: product.provider, basePlanId: product.basePlanId, storefront, recovery: true, context };
      return { attemptId: response.attemptId, accountBinding: response.accountBinding };
    },
    async purchase(product, binding) {
      const attempt = prepared;
      if (!attempt || attempt.productId !== product.id || attempt.provider !== product.provider
        || attempt.basePlanId !== product.basePlanId || attempt.binding !== binding) throw new Error('Please reload the subscription before purchasing.');
      await requireAccount(attempt.accountId);
      // A lost launch response may mean the reservation has started. Never
      // retry it or ask the store to charge unless the start is confirmed.
      let startRequested = !!attempt.recovery;
      let checkingGuard = false;
      try {
        if (!attempt.recovery && product.provider === 'apple' && attempt.context.storeEnvironment === 'Sandbox') {
          checkingGuard = true;
          if (!store.assertPurchaseEnvironment) throw new Error('Apple Sandbox verification is unavailable.');
          await store.assertPurchaseEnvironment(attempt.context);
          checkingGuard = false;
          await requireAccount(attempt.accountId);
        }
        startRequested = true;
        const started = attempt.recovery ? { started: true }
          : record(await call('/native-billing?action=start', { attemptId: attempt.attemptId,
            ...(attempt.provider === 'google' ? { provider: attempt.provider, productId: attempt.productId, basePlanId: attempt.basePlanId, storefront: attempt.storefront } : {}) }, 'POST', attempt.accountId, attempt.provider === 'apple' ? guardOptions : undefined));
        if (started.started !== true) return { kind: 'pending' };
        if (!attempt.recovery) checkedStoreContext(started, attempt.context);
        await requireAccount(attempt.accountId);
        const result = attempt.recovery ? await store.resume!(product, binding, attempt.context, () => requireAccount(attempt.accountId).then(() => {})) : await store.buy(product, binding, attempt.context, product.provider === 'apple' ? () => requireAccount(attempt.accountId).then(() => {}) : undefined);
        // Closing a resumed sheet does not prove an earlier uncertain request
        // was canceled. Retain its reservation and cross-provider protection.
        if (result.kind === 'cancelled' && attempt.recovery) return { kind: 'pending' };
        if (result.kind === 'cancelled') {
          const cancelled = record(await call('/native-billing?action=cancel', { attemptId: attempt.attemptId, reason: 'user-cancelled' }, 'POST', attempt.accountId));
          if (cancelled.cancelled !== true) return { kind: 'pending' };
        }
        return result;
      } catch {
        // Only a local guard failure before any start request proves that this
        // reservation never opened checkout. The server also enforces reserved-only
        // cancellation. A lost start response or recovery must remain pending.
        if (!startRequested && checkingGuard) {
          try {
            await requireAccount(attempt.accountId);
            const cancelled = record(await call('/native-billing?action=cancel', { attemptId: attempt.attemptId, reason: 'store-guard-failed' }, 'POST', attempt.accountId));
            if (cancelled.cancelled === true) return { kind: 'cancelled' };
          } catch { /* Preserve the reservation when cancellation is unconfirmed. */ }
        }
        return { kind: 'pending' };
      }
      finally { prepared = null; }
    },
    async verify(accountId, purchase) {
      await requireAccount(accountId);
      const result = record(await call('/native-purchases', { provider: purchase.provider, proof: purchase.proof }, 'POST', accountId));
      if (result.accountId !== accountId || result.verified !== true || result.purchase?.provider !== purchase.provider
        || !statuses.includes(result.purchase?.status) || ['free', 'pending', 'payment_required'].includes(result.purchase.status)) {
        throw new Error('Your purchase is still being confirmed.');
      }
      // A purchase response is not the account's combined access. In particular,
      // restoring an old expired receipt must not revoke a valid Stripe plan.
      return status(accountId);
    },
    restore: () => store.restore(),
    finish: purchase => store.finish(purchase),
  };
}
