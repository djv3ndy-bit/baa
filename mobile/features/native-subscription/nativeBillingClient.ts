import type { PurchaseDependencies, PurchaseResult, StoreProduct, StorePurchase, VerifiedSubscription } from './purchaseCoordinator';

export type BillingTransport = (path: string, body: Record<string, unknown>, method: 'GET' | 'POST', accountId: string) => Promise<unknown>;
export type PurchaseStore = {
  country(): Promise<string>;
  buy(product: StoreProduct, accountBinding: string): Promise<PurchaseResult>;
  resume?(product: StoreProduct, accountBinding: string): Promise<PurchaseResult>;
  restore(): Promise<StorePurchase[]>;
  finish(purchase: StorePurchase): Promise<void>;
};
type AccountReader = PurchaseDependencies['account'];
const statuses = ['free', 'active', 'grace', 'pending', 'expired', 'revoked', 'payment_required'];
const record = (value: unknown): Record<string, any> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Subscription confirmation is unavailable.');
  return value as Record<string, any>;
};
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
  return row as VerifiedSubscription;
}

/** The caller supplies the existing authenticatedApi transport. Its expected
 * account check stays in force on every request, including verification. */
export function nativePurchaseDependencies({ account, call, store }: { account: AccountReader; call: BillingTransport; store: PurchaseStore }): PurchaseDependencies {
  let prepared: { accountId: string; attemptId: string; binding: string; productId: string; recovery?: boolean } | null = null;
  const requireAccount = async (expected?: string) => {
    const current = await account();
    if (!current || current.role !== 'cafe_owner_manager' || (expected && current.id !== expected)) throw new Error('Please review the signed-in café account.');
    return current;
  };
  const status = async (accountId: string) => {
    await requireAccount(accountId);
    const result = checkedSubscription(await call('/native-billing?action=status', {}, 'GET', accountId), accountId);
    await requireAccount(accountId);
    return result;
  };
  return {
    account, status,
    async preflight(accountId, product) {
      await requireAccount(accountId);
      const storefront = await store.country();
      const response = record(await call('/native-billing?action=prepare', { provider: product.provider, productId: product.id, storefront }, 'POST', accountId));
      const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
      if (!uuid.test(response.attemptId) || !uuid.test(response.accountBinding)) throw new Error('Purchase preparation could not be confirmed.');
      prepared = { accountId, attemptId: response.attemptId, binding: response.accountBinding, productId: product.id };
      return { attemptId: response.attemptId, accountBinding: response.accountBinding };
    },
    async resumePreflight(accountId, product) {
      await requireAccount(accountId);
      if (product.provider !== 'apple' || !store.resume) throw new Error('Apple checkout recovery is unavailable.');
      const storefront = await store.country();
      const response = record(await call('/native-billing?action=resume', { provider: product.provider, productId: product.id, storefront }, 'POST', accountId));
      const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
      if (!uuid.test(response.attemptId) || !uuid.test(response.accountBinding)) throw new Error('Purchase recovery could not be confirmed.');
      prepared = { accountId, attemptId: response.attemptId, binding: response.accountBinding, productId: product.id, recovery: true };
      return { attemptId: response.attemptId, accountBinding: response.accountBinding };
    },
    async purchase(product, binding) {
      const attempt = prepared;
      if (!attempt || attempt.productId !== product.id || attempt.binding !== binding) throw new Error('Please reload the subscription before purchasing.');
      await requireAccount(attempt.accountId);
      // A lost launch response may mean the reservation has started. Never
      // retry it or ask the store to charge unless the start is confirmed.
      try {
        const started = attempt.recovery ? { started: true }
          : record(await call('/native-billing?action=start', { attemptId: attempt.attemptId }, 'POST', attempt.accountId));
        if (started.started !== true) return { kind: 'pending' };
        await requireAccount(attempt.accountId);
        const result = attempt.recovery ? await store.resume!(product, binding) : await store.buy(product, binding);
        // Closing a resumed sheet does not prove an earlier uncertain request
        // was canceled. Retain its reservation and cross-provider protection.
        if (result.kind === 'cancelled' && attempt.recovery) return { kind: 'pending' };
        if (result.kind === 'cancelled') {
          const cancelled = record(await call('/native-billing?action=cancel', { attemptId: attempt.attemptId, reason: 'user-cancelled' }, 'POST', attempt.accountId));
          if (cancelled.cancelled !== true) return { kind: 'pending' };
        }
        return result;
      } catch { return { kind: 'pending' }; }
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
