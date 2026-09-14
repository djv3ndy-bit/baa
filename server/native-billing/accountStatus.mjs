/** Server-only composition. Inputs must come from the existing Stripe status
 * service and the service-role native ledger, never from a client request.
 * This is a read model; checkout still needs an atomic cross-provider claim. */
const statuses = new Set(['active', 'grace', 'pending', 'payment_required', 'expired', 'revoked']);
const date = value => value === null ? null : typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : undefined;
const invalid = () => { throw new Error('Subscription details are temporarily unavailable.'); };

export function combinedAccountStatus({ account, website, native, environment, checkoutPending, now = Date.now() }) {
  if (!account?.id || account.role !== 'cafe_owner_manager' || account.suspendedAt) invalid();
  if (!['Sandbox', 'Production'].includes(environment) || typeof checkoutPending !== 'boolean' || !Number.isFinite(now)) invalid();
  if (!website || !['free', 'pro'].includes(website.plan) || typeof website.connectedToBilling !== 'boolean'
      || typeof website.canManageBilling !== 'boolean' || typeof website.billingPaused !== 'boolean'
      || (website.plan === 'pro' && !website.connectedToBilling)) invalid();
  if (native?.accountId !== account.id || native.environment !== environment || !Array.isArray(native.subscriptions)) invalid();

  const subscriptions = [];
  if (website.connectedToBilling) {
    const status = website.plan === 'pro' ? 'active' : website.canManageBilling ? 'payment_required' : 'expired';
    subscriptions.push({ provider: 'stripe', status, access: website.plan, currentPeriodEnd: website.currentPeriodEnd ?? null,
      autoRenews: website.canManageBilling && !website.cancelAtPeriodEnd, canManage: website.canManageBilling });
  }
  for (const row of native.subscriptions) {
    if (!['apple', 'google'].includes(row.provider) || !statuses.has(row.status) || typeof row.autoRenews !== 'boolean'
        || date(row.currentPeriodEnd) === undefined || date(row.gracePeriodEnd) === undefined) invalid();
    const end = row.status === 'grace' ? row.gracePeriodEnd : row.currentPeriodEnd;
    const paid = ['active', 'grace'].includes(row.status) && end !== null && Date.parse(end) > now;
    // An overdue renewable purchase may be recovering; don't invite a second
    // charge just because its last verified period ended before the next event.
    const status = !paid && ['active', 'grace'].includes(row.status)
      ? row.autoRenews ? 'payment_required' : 'expired' : row.status;
    subscriptions.push({ provider: row.provider, status, access: paid ? 'pro' : 'free', currentPeriodEnd: row.currentPeriodEnd,
      gracePeriodEnd: row.gracePeriodEnd, autoRenews: row.autoRenews, canManage: true });
  }
  const rank = value => value.access === 'pro' ? 3 : ['pending', 'payment_required'].includes(value.status) ? 2 : 1;
  subscriptions.sort((a, b) => rank(b) - rank(a));
  const primary = subscriptions[0];
  const paid = subscriptions.some(row => row.access === 'pro');
  const requiresResolution = subscriptions.some(row => ['pending', 'payment_required'].includes(row.status));
  return {
    accountId: account.id, verified: true, access: paid ? 'pro' : 'free',
    provider: primary?.provider ?? null, status: checkoutPending && !paid && !requiresResolution ? 'pending' : primary?.status ?? 'free',
    currentPeriodEnd: primary?.currentPeriodEnd ?? null, gracePeriodEnd: primary?.gracePeriodEnd ?? null, autoRenews: primary?.autoRenews ?? false,
    canManage: subscriptions.some(row => row.canManage),
    canPurchase: !paid && !requiresResolution && !checkoutPending && !website.billingPaused,
    checkoutPending, subscriptions,
  };
}
