const clean = (value, max = 500) => String(value ?? '').trim().slice(0, max);
const cents = (value) => Number.isFinite(Number(value)) ? Math.max(0, Math.round(Number(value))) : 0;

export const BILLING_AGENT_POLICY = Object.freeze({
  version: 'billing-agent-v1',
  mode: 'read_analyze_recommend',
  stripe_write_allowed: false,
  refund_allowed: false,
  charge_allowed: false,
  cancellation_allowed: false,
  subscription_change_allowed: false,
  pricing_change_allowed: false,
  database_write_allowed: false,
  owner_approval_required_for_financial_action: true,
});

export function analyzeSubscription(subscription = {}) {
  const status = clean(subscription.status, 40).toLowerCase() || 'unknown';
  const connected = Boolean(subscription.stripe_subscription_id || subscription.stripe_customer_id);
  const cancelAtPeriodEnd = Boolean(subscription.cancel_at_period_end);
  const complimentary = Boolean(subscription.complimentary_access);
  let priority = 'P3';
  let finding = 'No immediate billing action identified.';
  let route = 'billing';

  if (['past_due', 'unpaid', 'incomplete'].includes(status)) {
    priority = 'P1';
    finding = 'Subscription requires payment-failure review. Do not charge or modify the subscription automatically.';
  } else if (status === 'expired' && connected) {
    priority = 'P2';
    finding = 'Connected billing record is expired and should be reviewed for synchronization or customer follow-up.';
  } else if (cancelAtPeriodEnd) {
    priority = 'P2';
    finding = 'Subscription is scheduled to cancel at period end. No retention or cancellation change should be made automatically.';
  } else if (complimentary) {
    finding = 'Complimentary access is enabled. Any change to free access requires owner approval.';
  }

  return { priority, route, status, connected, cancel_at_period_end: cancelAtPeriodEnd, complimentary_access: complimentary, finding, policy: BILLING_AGENT_POLICY };
}

export function analyzePayments(payments = []) {
  const normalized = payments.map((payment) => ({
    id: clean(payment.provider_payment_id, 180),
    status: clean(payment.status, 40).toLowerCase(),
    amount_cents: cents(payment.amount_cents),
    currency: clean(payment.currency || 'usd', 12).toLowerCase(),
    paid_at: payment.paid_at || null,
  }));

  const failed = normalized.filter((p) => p.status === 'failed');
  const refunded = normalized.filter((p) => p.status === 'refunded');
  const succeeded = normalized.filter((p) => p.status === 'succeeded');
  const duplicateLooking = [];
  const seen = new Map();

  for (const payment of succeeded) {
    const day = payment.paid_at ? String(payment.paid_at).slice(0, 10) : 'unknown';
    const key = `${payment.amount_cents}:${payment.currency}:${day}`;
    if (seen.has(key)) duplicateLooking.push({ first: seen.get(key), second: payment, reason: 'Same amount, currency, and posting day. Verify in Stripe before concluding this is a duplicate charge.' });
    else seen.set(key, payment);
  }

  let priority = 'P3';
  if (failed.length || duplicateLooking.length) priority = 'P1';
  else if (refunded.length) priority = 'P2';

  return {
    priority,
    counts: { total: normalized.length, succeeded: succeeded.length, failed: failed.length, refunded: refunded.length, duplicate_looking: duplicateLooking.length },
    failed,
    refunded,
    duplicate_looking: duplicateLooking,
    recommendation: duplicateLooking.length ? 'Verify suspected duplicates against Stripe invoice/charge IDs before recommending a refund.' : failed.length ? 'Review failed payments and subscription state; do not retry charges automatically.' : 'No immediate payment anomaly identified.',
    policy: BILLING_AGENT_POLICY,
  };
}

export function analyzeWebhookEvents(events = []) {
  const normalized = events.map((event) => ({ event_id: clean(event.event_id, 180), event_type: clean(event.event_type, 120), created_at: event.created_at || null }));
  const ids = new Set();
  const duplicates = [];
  for (const event of normalized) {
    if (event.event_id && ids.has(event.event_id)) duplicates.push(event.event_id);
    if (event.event_id) ids.add(event.event_id);
  }
  return {
    priority: duplicates.length ? 'P2' : 'P3',
    total_events: normalized.length,
    duplicate_event_ids: [...new Set(duplicates)],
    finding: duplicates.length ? 'Duplicate webhook event IDs were observed in the supplied records. Investigate idempotency/event storage before changing billing state.' : 'No duplicate webhook event IDs identified in the supplied records.',
    policy: BILLING_AGENT_POLICY,
  };
}

export function billingBrief({ subscription = {}, payments = [], webhookEvents = [] } = {}) {
  const subscriptionAnalysis = analyzeSubscription(subscription);
  const paymentAnalysis = analyzePayments(payments);
  const webhookAnalysis = analyzeWebhookEvents(webhookEvents);
  const priorities = [subscriptionAnalysis.priority, paymentAnalysis.priority, webhookAnalysis.priority];
  const rank = { P0: 0, P1: 1, P2: 2, P3: 3 };
  const priority = priorities.sort((a, b) => rank[a] - rank[b])[0] || 'P3';
  return {
    version: BILLING_AGENT_POLICY.version,
    priority,
    subscription: subscriptionAnalysis,
    payments: paymentAnalysis,
    webhooks: webhookAnalysis,
    owner_approval_required: priority === 'P0' || priority === 'P1' || Boolean(subscription.cancel_at_period_end) || Boolean(subscription.complimentary_access),
    allowed_next_step: 'Investigate and recommend only. Any financial or subscription-changing action must be separately approved by the owner.',
  };
}
