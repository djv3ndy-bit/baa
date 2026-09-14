export type BillingStatus = {
  status: string;
  plan: 'free' | 'pro';
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  connectedToBilling: boolean;
  billingPaused: boolean;
  canManageBilling?: boolean;
  monthlyPriceCents?: number;
  complimentaryAccess?: boolean;
  message?: string;
};

export function canManageBilling(billing: BillingStatus | null): boolean {
  if (!billing) return false;
  if (typeof billing.canManageBilling === 'boolean') return billing.canManageBilling;
  return billing.connectedToBilling && ['active', 'trialing', 'past_due', 'unpaid', 'incomplete'].includes(billing.status);
}

export function hasActivePro(billing: BillingStatus): boolean {
  return billing.connectedToBilling && billing.plan === 'pro' && ['active', 'trialing'].includes(billing.status);
}

export function validCheckoutSessionId(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 255 && /^cs_(?:test_|live_)?[A-Za-z0-9]+$/.test(value);
}

export function validatedCheckoutUrl(value: unknown): string {
  if (typeof value !== 'string') throw new Error('The secure checkout link is unavailable. Please try again.');
  const url = new URL(value);
  if (url.origin !== 'https://checkout.stripe.com' || url.username || url.password) {
    throw new Error('The secure checkout link is unavailable. Please try again.');
  }
  return url.href;
}

export function validBillingStatus(value: unknown): value is BillingStatus {
  if (!value || typeof value !== 'object') return false;
  const billing = value as Partial<BillingStatus>;
  return typeof billing.status === 'string'
    && (billing.plan === 'free' || billing.plan === 'pro')
    && typeof billing.connectedToBilling === 'boolean'
    && typeof billing.billingPaused === 'boolean';
}
