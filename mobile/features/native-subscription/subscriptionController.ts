import { PurchaseCoordinator, purchaseIsBlocked, type BillingProvider, type PurchaseDependencies, type PurchaseOutcome, type StoreProduct, type StorePurchase, type VerifiedSubscription } from './purchaseCoordinator';
import { checkedSubscription, nativePurchaseDependencies, type BillingTransport, type PurchaseStore } from './nativeBillingClient';

export type SubscriptionStore = PurchaseStore & {
  connect(): Promise<void>;
  product(): Promise<StoreProduct>;
  manage(): Promise<void>;
  dispose(): Promise<void>;
};
export type SubscriptionViewState = {
  subscription: VerifiedSubscription | null;
  product: StoreProduct | null;
  busy: boolean;
  error: string;
  notice: string;
};
export const initialSubscriptionState: SubscriptionViewState = { subscription: null, product: null, busy: false, error: '', notice: '' };
type Dependencies = {
  accountId: string;
  account: PurchaseDependencies['account'];
  call: BillingTransport;
  store: SubscriptionStore | null;
  openManagement: (provider: 'stripe' | 'apple' | 'google', accountId: string) => Promise<void>;
  changed: (state: SubscriptionViewState) => void;
  accountChanged: () => void;
};

/** One account-scoped controller; all native callbacks and UI taps share a lock. */
export class SubscriptionController {
  private state: SubscriptionViewState = { ...initialSubscriptionState };
  private disposed = false;
  private running = false;
  private queued = new Map<string, StorePurchase>();
  private coordinator: PurchaseCoordinator | null;
  constructor(private deps: Dependencies) {
    this.coordinator = deps.store ? new PurchaseCoordinator(nativePurchaseDependencies({ ...deps, store: deps.store,
      account: async () => {
        const current = await deps.account();
        return !this.disposed && current?.id === deps.accountId ? current : null;
      },
    })) : null;
  }
  private publish(patch: Partial<SubscriptionViewState>) {
    if (this.disposed) return;
    this.state = { ...this.state, ...patch };
    this.deps.changed(this.state);
  }
  private async accountIsCurrent() {
    const account = await this.deps.account();
    if (this.disposed) return false;
    if (account?.id === this.deps.accountId && account.role === 'cafe_owner_manager') return true;
    this.publish({ subscription: null, product: null, error: '', notice: '' });
    this.deps.accountChanged();
    return false;
  }
  private async status() {
    const value = await this.deps.call('/native-billing?action=status', {}, 'GET', this.deps.accountId);
    const subscription = checkedSubscription(value, this.deps.accountId);
    if (!await this.accountIsCurrent()) throw new Error('Account changed');
    this.publish({ subscription });
    return subscription;
  }
  private async run(work: () => Promise<void>) {
    if (this.disposed || this.running) return;
    this.running = true;
    this.publish({ busy: true, error: '' });
    try { if (await this.accountIsCurrent()) await work(); }
    catch {
      this.publish({ error: 'We could not confirm your subscription. Check your connection and try again. Your last confirmed status is shown.' });
    } finally {
      this.running = false;
      this.publish({ busy: false });
      // Drain events once. A failed verification stays unfinished at the store;
      // retry/restore or a later store event can recover it without a new charge.
      const first = this.queued.entries().next();
      if (!this.disposed && !first.done) {
        this.queued.delete(first.value[0]);
        void this.recover(first.value[1]);
      }
    }
  }
  async load() {
    return this.run(async () => {
      const subscription = await this.status();
      this.publish({ notice: '', product: null });
      if (!this.deps.store) {
        this.publish({ notice: 'New in-app subscriptions are not available on this device yet. Your existing subscription access is unchanged.' });
        return;
      }
      try {
        await this.deps.store.connect();
        // Listen for unfinished purchases even when this account already has
        // access. Loading the screen must not prompt an App Store restore.
        if (purchaseIsBlocked(subscription) && subscription.canResumeAppleCheckout !== true) return;
        const product = await this.deps.store.product();
        if (await this.accountIsCurrent()) this.publish({ product });
      } catch (cause) {
        const reason = (cause as { reason?: string } | null)?.reason;
        this.publish({ error: reason === 'outside_us'
          ? 'New subscriptions are available only through the United States store. You can still restore or manage an existing purchase.'
          : reason === 'terms_review'
          ? 'The store returned subscription terms that need review. Purchases are unavailable for now. Try again later or contact support. Your existing access is unchanged.'
          : 'We could not load the current U.S. store price. Check your store account and connection, then try again.' });
      }
    });
  }
  private async accept(result: PurchaseOutcome, restore = false) {
    if (!await this.accountIsCurrent()) return;
    if (result.kind === 'verified' || result.kind === 'blocked') {
      this.publish({ subscription: result.subscription, error: '', notice: result.subscription.status === 'pending'
        ? 'A purchase is still pending. Use Restore purchases to check it, or contact support if it remains pending.'
        : result.subscription.access === 'pro' ? 'Your Pro access is confirmed.'
          : restore ? 'No active in-app subscription was confirmed for this BaristaMatch account.' : 'Review your current subscription before purchasing.' });
    } else if (result.kind === 'account_changed') {
      this.publish({ subscription: null, product: null }); this.deps.accountChanged();
    } else if (result.kind === 'cancelled') {
      this.publish({ notice: 'Purchase canceled.' });
    } else if (result.kind !== 'busy') {
      this.publish({ notice: 'Your purchase could not be confirmed yet. Use Restore purchases to check it before trying to buy again.' });
    }
  }
  private async refreshOutcome(result: PurchaseOutcome) {
    const subscription = await this.status();
    if (subscription.access === 'pro' && ['pending', 'verification_pending', 'failed'].includes(result.kind)) {
      this.publish({ notice: 'Your Pro access is active. We could not finish checking this purchase. Complete any store sign-in, then use Restore purchases to retry if needed.' });
    }
  }
  async buy() {
    return this.run(async () => {
      if (!this.coordinator || !this.state.product || !this.state.subscription || this.state.error) return;
      const resume = this.state.subscription.canResumeAppleCheckout === true && this.state.product.provider === 'apple';
      if (purchaseIsBlocked(this.state.subscription) && !resume) return;
      const result = resume ? await this.coordinator.resume(this.state.product) : await this.coordinator.buy(this.state.product);
      await this.accept(result);
      // Refresh on cancellation, pending, and failure too. Never infer success.
      await this.refreshOutcome(result);
    });
  }
  async restore() {
    return this.run(async () => {
      if (!this.coordinator) return;
      const result = await this.coordinator.restore();
      await this.accept(result, true);
      await this.refreshOutcome(result);
    });
  }
  async recover(purchase: StorePurchase) {
    if (this.disposed || !this.coordinator) return;
    if (this.running) { this.queued.set(`${purchase.provider}:${purchase.id}`, purchase); return; }
    return this.run(async () => {
      const result = await this.coordinator!.recover(purchase);
      await this.accept(result, true);
      if (['pending', 'verification_pending', 'failed'].includes(result.kind)) await this.refreshOutcome(result);
    });
  }
  async manage(requestedProvider?: BillingProvider) {
    return this.run(async () => {
      const subscription = await this.status();
      const provider = requestedProvider || subscription.provider;
      const manageable = subscription.subscriptions?.some(row => row.provider === provider && row.canManage)
        ?? (provider === subscription.provider && subscription.canManage);
      if (!provider || !manageable) return;
      // Website subscribers keep the existing secure Stripe portal. Store
      // subscribers use their provider, including after switching phone OS.
      await this.deps.openManagement(provider, this.deps.accountId);
      if (await this.accountIsCurrent()) await this.status();
    });
  }
  dispose() {
    this.disposed = true;
    this.queued.clear();
    void this.deps.store?.dispose().catch(() => {});
  }
}
