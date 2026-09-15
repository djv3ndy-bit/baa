/** Store adapters and the server must supply these values. Client receipt data
 * alone never grants access. This module is not wired into the release yet. */
export type BillingProvider = 'apple' | 'google' | 'stripe';
export type VerifiedSubscription = {
  accountId: string;
  verified: true;
  access: 'free' | 'pro';
  provider: BillingProvider | null;
  canPurchase: boolean;
  canManage: boolean;
  canResumeAppleCheckout?: boolean;
  status: 'free' | 'active' | 'grace' | 'pending' | 'expired' | 'revoked' | 'payment_required';
  currentPeriodEnd: string | null;
  autoRenews: boolean;
  gracePeriodEnd?: string | null;
  subscriptions?: { provider: BillingProvider; canManage: boolean; access: 'free' | 'pro' }[];
};
export type StoreProduct = { id: string; displayPrice: string; currency: string; period: 'month'; provider: 'apple' | 'google' };
export type StorePurchase = { id: string; productId: string; provider: 'apple' | 'google'; proof: string };
export type PurchaseResult = { kind: 'cancelled' | 'pending' } | { kind: 'purchased'; purchase: StorePurchase };
export type PurchaseOutcome =
  | { kind: 'verified'; subscription: VerifiedSubscription }
  | { kind: 'blocked'; subscription: VerifiedSubscription }
  | { kind: 'cancelled' | 'pending' | 'busy' | 'account_changed' | 'verification_pending' | 'failed' };

export type PurchaseDependencies = {
  account: () => Promise<{ id: string; role: string } | null>;
  status: (accountId: string) => Promise<VerifiedSubscription>;
  // Must atomically reserve checkout across ALL providers, including Stripe.
  // Server returns an opaque attempt and account binding, never a customer ID
  // supplied by a caller. Store products must belong to the approved plan.
  preflight: (accountId: string, product: StoreProduct) => Promise<{ attemptId: string; accountBinding: string }>;
  resumePreflight?: (accountId: string, product: StoreProduct) => Promise<{ attemptId: string; accountBinding: string }>;
  purchase: (product: StoreProduct, accountBinding: string) => Promise<PurchaseResult>;
  restore: () => Promise<StorePurchase[]>;
  verify: (accountId: string, purchase: StorePurchase, attemptId?: string) => Promise<VerifiedSubscription>;
  // StoreKit finish / Google acknowledgement happens after durable server grant.
  finish: (purchase: StorePurchase) => Promise<void>;
};

function checkedStatus(status: VerifiedSubscription, id: string): VerifiedSubscription {
  if (status.accountId !== id || status.verified !== true) throw new Error('Invalid subscription confirmation');
  return status;
}

export function purchaseIsBlocked(status: VerifiedSubscription) {
  return !status.canPurchase || status.access === 'pro' || (!!status.provider && !['free', 'expired', 'revoked'].includes(status.status));
}

export class PurchaseCoordinator {
  private busy = false;
  private pending: { accountId: string; purchase: StorePurchase; attemptId?: string } | null = null;
  private completed = new Set<string>();
  constructor(private readonly deps: PurchaseDependencies) {}

  private async sameCafe(id: string) {
    const account = await this.deps.account();
    return account?.id === id && account.role === 'cafe_owner_manager';
  }

  private async reconcile(accountId: string, purchase: StorePurchase, attemptId?: string): Promise<PurchaseOutcome> {
    // A newer signed proof for the same transaction may report revocation.
    // Suppress identical event delivery, never a changed provider confirmation.
    const key = `${accountId}:${purchase.provider}:${purchase.id}:${purchase.proof}`;
    if (this.completed.has(key)) {
      const subscription = checkedStatus(await this.deps.status(accountId), accountId);
      return await this.sameCafe(accountId) ? { kind: 'verified', subscription } : { kind: 'account_changed' };
    }
    this.pending = { accountId, purchase, attemptId };
    if (!await this.sameCafe(accountId)) return { kind: 'account_changed' };
    try {
      const subscription = checkedStatus(await this.deps.verify(accountId, purchase, attemptId), accountId);
      if (!await this.sameCafe(accountId)) return { kind: 'account_changed' };
      if (subscription.status === 'pending' || subscription.status === 'payment_required') return { kind: 'verification_pending' };
      // A finishing error retains the receipt for recovery. Never ask the user
      // to pay again after the server has already confirmed their subscription.
      await this.deps.finish(purchase);
      this.completed.add(key);
      this.pending = null;
      return { kind: 'verified', subscription };
    } catch { return { kind: 'verification_pending' }; }
  }

  /** Recover a store event without showing checkout or prompting App Store sync. */
  async recover(purchase: StorePurchase): Promise<PurchaseOutcome> {
    if (this.busy) return { kind: 'busy' };
    this.busy = true;
    try {
      const account = await this.deps.account();
      if (!account || account.role !== 'cafe_owner_manager') return { kind: 'account_changed' };
      if (this.pending && this.pending.accountId !== account.id) return { kind: 'account_changed' };
      return await this.reconcile(account.id, purchase);
    } catch { return { kind: 'verification_pending' }; }
    finally { this.busy = false; }
  }

  async buy(product: StoreProduct): Promise<PurchaseOutcome> {
    if (this.busy) return { kind: 'busy' };
    this.busy = true;
    try {
      const account = await this.deps.account();
      if (!account || account.role !== 'cafe_owner_manager') return { kind: 'account_changed' };
      if (this.pending) {
        if (this.pending.accountId !== account.id) return { kind: 'account_changed' };
        return await this.reconcile(account.id, this.pending.purchase, this.pending.attemptId);
      }
      const status = checkedStatus(await this.deps.status(account.id), account.id);
      // Block renewal issues and existing subscriptions as well as active access.
      if (purchaseIsBlocked(status)) return { kind: 'blocked', subscription: status };
      const attempt = await this.deps.preflight(account.id, product);
      if (!await this.sameCafe(account.id)) return { kind: 'account_changed' };
      const result = await this.deps.purchase(product, attempt.accountBinding);
      if (result.kind !== 'purchased') return { kind: result.kind };
      return await this.reconcile(account.id, result.purchase, attempt.attemptId);
    } catch { return { kind: 'failed' }; }
    finally { this.busy = false; }
  }

  async resume(product: StoreProduct): Promise<PurchaseOutcome> {
    if (this.busy) return { kind: 'busy' };
    this.busy = true;
    try {
      const account = await this.deps.account();
      if (!account || account.role !== 'cafe_owner_manager') return { kind: 'account_changed' };
      if (product.provider !== 'apple' || !this.deps.resumePreflight) return { kind: 'failed' };
      if (this.pending) {
        if (this.pending.accountId !== account.id) return { kind: 'account_changed' };
        return await this.reconcile(account.id, this.pending.purchase, this.pending.attemptId);
      }
      // A completed purchase is restored and verified before another store
      // sheet may open. Empty restoration never cancels the reservation.
      const purchases = await this.deps.restore();
      for (const purchase of purchases) {
        if (!await this.sameCafe(account.id)) return { kind: 'account_changed' };
        const result = await this.reconcile(account.id, purchase);
        if (result.kind !== 'verified') return result;
      }
      const status = checkedStatus(await this.deps.status(account.id), account.id);
      if (!await this.sameCafe(account.id)) return { kind: 'account_changed' };
      if (status.canResumeAppleCheckout !== true || status.access !== 'free' || status.status !== 'pending') {
        return { kind: 'blocked', subscription: status };
      }
      const attempt = await this.deps.resumePreflight(account.id, product);
      if (!await this.sameCafe(account.id)) return { kind: 'account_changed' };
      const result = await this.deps.purchase(product, attempt.accountBinding);
      if (result.kind !== 'purchased') return { kind: 'pending' };
      return await this.reconcile(account.id, result.purchase, attempt.attemptId);
    } catch { return { kind: 'failed' }; }
    finally { this.busy = false; }
  }

  async restore(): Promise<PurchaseOutcome> {
    if (this.busy) return { kind: 'busy' };
    this.busy = true;
    try {
      const account = await this.deps.account();
      if (!account || account.role !== 'cafe_owner_manager') return { kind: 'account_changed' };
      if (this.pending?.accountId === account.id) return await this.reconcile(account.id, this.pending.purchase, this.pending.attemptId);
      const purchases = await this.deps.restore();
      for (const purchase of purchases) {
        if (!await this.sameCafe(account.id)) return { kind: 'account_changed' };
        // Backend must reject a receipt belonging to a different BaristaMatch
        // account; restoration is never permission to transfer ownership.
        const result = await this.reconcile(account.id, purchase);
        if (result.kind !== 'verified') return result;
      }
      const subscription = checkedStatus(await this.deps.status(account.id), account.id);
      if (!await this.sameCafe(account.id)) return { kind: 'account_changed' };
      return { kind: 'verified', subscription };
    } catch { return { kind: 'failed' }; }
    finally { this.busy = false; }
  }
}
