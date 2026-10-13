export type OfficeData = Record<string, any>;

export function structuredContent(value: any): OfficeData | null {
  const next = value?.structuredContent ?? value?.result?.structuredContent ?? value?.toolOutput ?? value?.output;
  return next && typeof next === 'object' && !Array.isArray(next) ? next : null;
}

export function mergeOfficeData(previous: OfficeData, next: OfficeData): OfficeData {
  const decisions = Array.isArray(next.decisions) ? next.decisions : Array.isArray(next.items) ? next.items : null;
  return {
    ...previous,
    ...next,
    ...(decisions ? { decisions, approvals: { count: decisions.filter((item: any) => item.protected).length } } : {}),
  };
}

export function show(value: unknown, fallback = '—') {
  return value === null || value === undefined || value === '' ? fallback : String(value);
}

function count(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function available(source: OfficeData) {
  return source.configured !== false && source.availability === 'available';
}

export function supportMetric(support: OfficeData | undefined) {
  if (!support) return { value: 'Not loaded', detail: 'Load an owner brief' };
  if (available(support) && count(support.open)) return { value: String(support.open), detail: 'Open requests in recent window' };
  return { value: 'Unavailable', detail: 'Support data is not verified' };
}

export function billingMetric(billing: OfficeData | undefined) {
  if (!billing) return { value: 'Not loaded', detail: 'Load a billing report' };
  const pastDue = billing.subscriptions?.past_due;
  const failed = billing.payments?.failed;
  if (!available(billing) || !count(pastDue) || !count(failed)) {
    return { value: billing.availability === 'partial' ? 'Partial' : 'Unavailable', detail: 'Billing data is not fully verified' };
  }
  const attention = pastDue + failed;
  return { value: String(attention), detail: attention ? 'Recent items need review' : 'No issues in checked data' };
}
