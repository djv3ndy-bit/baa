import type { PurchaseResult, StoreProduct, StorePurchase } from './purchaseCoordinator';
import { storeResponse } from './storeTimeout';

// Structural subset of the OpenIAP API. Composition with the installed native
// SDK is deliberately separate from the app's current subscription route.
export type NativePurchase = {
  id: string; productId: string; purchaseState: string; store: string;
  purchaseToken?: string | null; appAccountToken?: string | null;
  obfuscatedAccountIdAndroid?: string | null;
};
type PurchaseError = { code?: string; productId?: string | null };
export type NativePurchaseApi<P extends NativePurchase> = {
  initConnection(): Promise<unknown>;
  endConnection(): Promise<unknown>;
  fetchProducts(input: { skus: string[]; type: 'subs' }): Promise<unknown>;
  getStorefront(): Promise<string>;
  purchaseUpdatedListener(callback: (purchase: P) => void): { remove(): void };
  purchaseErrorListener(callback: (error: PurchaseError) => void): { remove(): void };
  requestPurchase(input: { type: 'subs'; request: {
    apple?: { sku: string; appAccountToken: string; andDangerouslyFinishTransactionAutomatically: false };
    google?: { skus: string[]; obfuscatedAccountId: string; subscriptionOffers: { sku: string; offerToken: string }[] };
  } }): Promise<unknown>;
  getAvailablePurchases(): Promise<P[]>;
  restorePurchases(): Promise<unknown>;
  finishTransaction(input: { purchase: P; isConsumable: false }): Promise<unknown>;
  deepLinkToSubscriptions(input?: { skuAndroid: string; packageNameAndroid: string }): Promise<unknown>;
};
export type ApprovedStorePlan = {
  id: string; provider: 'apple' | 'google'; basePlanId?: string;
  storefront: 'US';
  // Explicit server catalog prices. Do not infer regional prices or authorize
  // a different price from the browser preview's illustrative USD amount.
  prices: Record<string, number>;
};
type Selection = { product: StoreProduct; offerToken?: string };
export type StoreDiagnosticEvent = 'finish.start' | 'finish.missing' | 'finish.changed' | 'finish.provider-mismatch'
  | 'finish.store-completed' | 'finish.store-rejected' | 'finish.wait-failed' | 'finish.completed';

export class StorefrontUnavailableError extends Error {
  constructor(readonly reason: 'outside_us' | 'unconfirmed') {
    super(reason === 'outside_us'
      ? 'New subscriptions are available only through the United States store. You can still restore or manage an existing purchase.'
      : 'We could not confirm your store country. Try again when your store connection is available.');
    this.name = 'StorefrontUnavailableError';
  }
}

export class StoreProductReviewError extends Error {
  readonly reason = 'terms_review';
  constructor(message: string) { super(message); this.name = 'StoreProductReviewError'; }
}

function object(value: unknown): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Store product unavailable');
  return value as Record<string, any>;
}
function hasApprovedAppleTerms(row: Record<string, any>): boolean {
  const terms = row.pricingTermsIOS;
  // Older StoreKit versions omit this metadata. Newer versions include one
  // up-front term for an ordinary subscription, including monthly renewals.
  if (terms == null) return true;
  if (!Array.isArray(terms)) return false;
  if (terms.length === 0) return true;
  if (terms.length !== 1) return false;
  const term = terms[0];
  return term?.billingPlanType === 'up-front'
    && term.billingPeriod?.unit === 'month' && term.billingPeriod.value === 1
    && term.commitmentInfo?.period?.unit === 'month' && term.commitmentInfo.period.value === 1
    && term.billingPrice === row.price && term.commitmentInfo.price === row.price
    && term.billingDisplayPrice === row.displayPrice && term.commitmentInfo.displayPrice === row.displayPrice
    && (term.subscriptionOffers == null || (Array.isArray(term.subscriptionOffers) && term.subscriptionOffers.length === 0));
}
export function selectMonthlyProduct(value: unknown, plan: ApprovedStorePlan): Selection {
  const row = object(value);
  if (row.id !== plan.id || row.type !== 'subs' || row.platform !== (plan.provider === 'apple' ? 'ios' : 'android')) throw new Error('Store product unavailable');
  let currency: string, displayPrice: string, price: number, offerToken: string | undefined;
  if (plan.provider === 'apple') {
    if (row.subscriptionPeriodUnitIOS !== 'month' || row.subscriptionPeriodNumberIOS !== '1') throw new StoreProductReviewError('Subscription period needs review');
    // Do not silently add an introductory trial or a commitment billing plan.
    if (Number(row.introductoryPriceNumberOfPeriodsIOS || 0) > 0 || !hasApprovedAppleTerms(row)) throw new StoreProductReviewError('Subscription terms need review');
    ({ currency, displayPrice, price } = row);
  } else {
    if (!plan.basePlanId || !Array.isArray(row.subscriptionOffers)) throw new Error('Subscription plan unavailable');
    const eligible = row.subscriptionOffers.filter((offer: any) => {
      const phases = offer.pricingPhasesAndroid?.pricingPhaseList;
      return offer.basePlanIdAndroid === plan.basePlanId && !offer.installmentPlanDetailsAndroid && Array.isArray(phases) && phases.length === 1 && phases[0].billingPeriod === 'P1M' && phases[0].recurrenceMode === 1;
    });
    if (eligible.length !== 1) throw new StoreProductReviewError('Subscription terms need review');
    const offer = eligible[0], phase = offer.pricingPhasesAndroid.pricingPhaseList[0];
    if (!/^\d+$/.test(phase.priceAmountMicros)) throw new Error('Store price unavailable');
    price = Number(phase.priceAmountMicros) / 1_000_000;
    currency = phase.priceCurrencyCode; displayPrice = phase.formattedPrice; offerToken = offer.offerTokenAndroid;
    if (!offerToken) throw new Error('Subscription offer unavailable');
  }
  if (!Number.isFinite(price) || price <= 0 || !/^[A-Z]{3}$/.test(currency) || typeof displayPrice !== 'string' || !displayPrice.trim()) throw new Error('Store price unavailable');
  if (plan.prices[currency] !== price) throw new StoreProductReviewError('Store price needs review');
  return { product: { id: plan.id, provider: plan.provider, displayPrice, currency, period: 'month' }, offerToken };
}

export class ExpoStoreGateway<P extends NativePurchase> {
  private connection: Promise<void> | null = null;
  private listeners: { remove(): void }[] = [];
  private purchases = new Map<string, P>();
  private restoring: Promise<StorePurchase[]> | null = null;
  private selected: Selection | null = null;
  private waiter: { productId: string; binding: string; settle: (result: PurchaseResult) => void; reject: () => void } | null = null;
  private interrupted = false;
  private disposed = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  constructor(private api: NativePurchaseApi<P>, private plan: ApprovedStorePlan, private onUnfinished: (purchase: StorePurchase) => void, private waitMs = 120_000, private restoreWaitMs = 120_000, private diagnostic?: (event: StoreDiagnosticEvent) => void) {}

  private record(event: StoreDiagnosticEvent) {
    // Diagnostics contain only fixed stage names, never purchase/account data.
    try { this.diagnostic?.(event); } catch { /* Logging cannot affect billing. */ }
  }

  async connect() {
    if (this.disposed) throw new Error('Store connection closed');
    if (!this.connection) {
      this.listeners = [this.api.purchaseUpdatedListener(value => this.updated(value)), this.api.purchaseErrorListener(error => this.failed(error))];
      this.connection = storeResponse(this.api.initConnection()).then(value => { if (value === false) throw new Error('Store unavailable'); }).catch(error => {
        this.listeners.forEach(listener => listener.remove()); this.listeners = []; this.connection = null; throw error;
      });
    }
    await this.connection;
    if (this.disposed) throw new Error('Store connection closed');
  }
  async product() {
    await this.connect();
    this.selected = null;
    await this.checkStorefront();
    const products = await storeResponse(this.api.fetchProducts({ skus: [this.plan.id], type: 'subs' }));
    if (this.disposed) throw new Error('Store connection closed');
    if (!Array.isArray(products)) throw new Error('Store products unavailable');
    const row = products.find(item => item?.id === this.plan.id);
    this.selected = selectMonthlyProduct(row, this.plan);
    return this.selected.product;
  }
  private async checkStorefront() {
    // StoreKit uses USA; Play Billing uses US. Locale, IP address, profile
    // location and USD pricing are not evidence of a U.S. store account.
    let country: string;
    try { country = await storeResponse(this.api.getStorefront()); }
    catch { throw new StorefrontUnavailableError('unconfirmed'); }
    if (typeof country !== 'string' || !/^[A-Z]{2,3}$/.test(country)) throw new StorefrontUnavailableError('unconfirmed');
    if (this.plan.storefront !== 'US' || country !== (this.plan.provider === 'apple' ? 'USA' : 'US')) throw new StorefrontUnavailableError('outside_us');
    return country;
  }
  async country() { await this.connect(); return this.checkStorefront(); }
  private proof(value: P): StorePurchase {
    if (value.store !== this.plan.provider || value.productId !== this.plan.id || value.purchaseState !== 'purchased' || !value.id || !value.purchaseToken) throw new Error('Purchase details unavailable');
    this.purchases.set(value.id, value);
    return { id: value.id, productId: value.productId, provider: this.plan.provider, proof: value.purchaseToken };
  }
  private clearWaiter() { clearTimeout(this.timer); this.timer = undefined; const waiter = this.waiter; this.waiter = null; return waiter; }
  private recover(purchase: StorePurchase) { try { this.onUnfinished(purchase); } catch { this.interrupted = true; } }
  private updated(value: P) {
    if (this.disposed || value.store !== this.plan.provider || value.productId !== this.plan.id) return;
    if (value.purchaseState === 'pending') { this.interrupted = true; this.clearWaiter()?.settle({ kind: 'pending' }); return; }
    if (value.purchaseState !== 'purchased') return;
    let purchase: StorePurchase;
    try { purchase = this.proof(value); } catch { this.interrupted = true; this.clearWaiter()?.settle({ kind: 'pending' }); return; }
    const binding = value.appAccountToken || value.obfuscatedAccountIdAndroid;
    if (this.waiter && binding && binding !== this.waiter.binding) {
      // A prior account's transaction is not the result of this account's buy.
      this.recover(purchase); return;
    }
    const waiter = this.clearWaiter();
    if (waiter) waiter.settle({ kind: 'purchased', purchase });
    else this.recover(purchase);
  }
  private failed(error: PurchaseError) {
    if (error.productId && error.productId !== this.plan.id) return;
    const waiter = this.clearWaiter();
    if (!waiter) return;
    if (error.code === 'user-cancelled') { waiter.settle({ kind: 'cancelled' }); return; }
    // A transport failure may arrive after store confirmation. Block another
    // purchase until reconciliation, rather than assume that no charge exists.
    this.interrupted = true;
    waiter.settle({ kind: 'pending' });
  }
  async buy(product: StoreProduct, accountBinding: string): Promise<PurchaseResult> {
    await this.connect();
    if (this.waiter || this.interrupted || this.restoring) return { kind: 'pending' };
    // Recheck immediately before opening checkout: the store account can
    // change after the price was loaded. Restore/manage never use this gate.
    await this.checkStorefront();
    if (this.disposed) throw new Error('Store connection closed');
    if (this.waiter || this.interrupted || this.restoring) return { kind: 'pending' };
    if (!this.selected || product.id !== this.selected.product.id || product.provider !== this.plan.provider || product.displayPrice !== this.selected.product.displayPrice) throw new Error('Review the current store price');
    if (this.plan.provider === 'apple' ? !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(accountBinding) : !/^[A-Za-z0-9_-]{1,64}$/.test(accountBinding)) throw new Error('Purchase account unavailable');
    return new Promise<PurchaseResult>((resolve, reject) => {
      this.waiter = { productId: product.id, binding: accountBinding, settle: resolve, reject: () => reject(new Error('Store unavailable')) };
      this.timer = setTimeout(() => { this.interrupted = true; this.clearWaiter()?.settle({ kind: 'pending' }); }, this.waitMs);
      const request = this.plan.provider === 'apple'
        ? { apple: { sku: product.id, appAccountToken: accountBinding, andDangerouslyFinishTransactionAutomatically: false as const } }
        : { google: { skus: [product.id], obfuscatedAccountId: accountBinding, subscriptionOffers: [{ sku: product.id, offerToken: this.selected!.offerToken! }] } };
      void this.api.requestPurchase({ type: 'subs', request }).then(result => {
        // Some iOS SDK versions also return a transaction; the event path is
        // authoritative, and processing both is safe with server idempotency.
        if (result && !this.disposed) for (const purchase of Array.isArray(result) ? result : [result]) this.updated(purchase as P);
      }).catch(error => this.failed({ code: typeof error?.code === 'string' ? error.code : 'interrupted', productId: product.id }));
    });
  }
  async restore(): Promise<StorePurchase[]> {
    await this.connect();
    if (this.waiter) throw new Error('A purchase is still open');
    if (!this.restoring) {
      const request = (async () => {
        // Store restoration can include interactive Apple authentication. A UI
        // timeout must not discard its eventual result or open another prompt.
        await this.api.restorePurchases();
        if (this.disposed) throw new Error('Store connection closed');
        const purchases = await storeResponse(this.api.getAvailablePurchases());
        if (this.disposed) throw new Error('Store connection closed');
        if (purchases.some(value => value.productId === this.plan.id && value.purchaseState === 'pending')) { this.interrupted = true; throw new Error('A purchase is pending'); }
        return purchases.filter(value => value.store === this.plan.provider && value.productId === this.plan.id && value.purchaseState === 'purchased').map(value => this.proof(value));
      })();
      this.restoring = request;
      // Normal and late results use the same account-bound verification path.
      // Its coordinator deduplicates callbacks and the awaited restore result.
      void request.then(purchases => {
        if (!this.disposed) purchases.forEach(purchase => this.recover(purchase));
      }, () => {}).finally(() => { if (this.restoring === request) this.restoring = null; });
    }
    // An empty response cannot clear an interrupted buy: only the server can
    // settle that reservation. Keep all native purchase guards in force.
    return storeResponse(this.restoring, this.restoreWaitMs);
  }
  async finish(purchase: StorePurchase) {
    this.record('finish.start');
    const original = this.purchases.get(purchase.id);
    if (!original || original.purchaseToken !== purchase.proof || purchase.provider !== this.plan.provider) {
      this.record(!original ? 'finish.missing' : original.purchaseToken !== purchase.proof ? 'finish.changed' : 'finish.provider-mismatch');
      throw new Error('Purchase changed');
    }
    const finishing = this.api.finishTransaction({ purchase: original, isConsumable: false });
    void finishing.then(() => this.record('finish.store-completed'), () => this.record('finish.store-rejected'));
    try { await storeResponse(finishing); }
    catch (error) { this.record('finish.wait-failed'); throw error; }
    this.purchases.delete(purchase.id); this.interrupted = false;
    this.record('finish.completed');
  }
  async manage() { await this.connect(); await this.api.deepLinkToSubscriptions({ skuAndroid: this.plan.id, packageNameAndroid: 'com.baristajobmatch.app' }); }
  async dispose() {
    this.disposed = true; this.clearWaiter()?.settle({ kind: 'pending' });
    this.listeners.forEach(listener => listener.remove()); this.listeners = [];
    if (this.connection) { try { await this.connection; await this.api.endConnection(); } catch { /* No access change on cleanup failure. */ } }
    this.connection = null;
  }
}
