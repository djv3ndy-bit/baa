type FetchResult = {
  ok: boolean;
  status: number;
  data: any;
  error?: string;
};

const env = (name: string) => String(process.env[name] || '').trim();

const safeFetch = async (url: string, init: RequestInit = {}): Promise<FetchResult> => {
  try {
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(5000) });
    const text = await response.text();
    let data: any = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = null; }
    return { ok: response.ok, status: response.status, data };
  } catch (error: any) {
    return { ok: false, status: 0, data: null, error: String(error?.message || error) };
  }
};

const supabaseKey = () => env('SUPABASE_SERVICE_ROLE_KEY') || env('SUPABASE_SECRET_KEY');
const supabaseHeaders = () => ({ apikey: supabaseKey(), Authorization: `Bearer ${supabaseKey()}` });

const sb = async (path: string): Promise<FetchResult> => {
  const base = env('SUPABASE_URL').replace(/\/$/, '');
  if (!base || !supabaseKey()) return { ok: false, status: 0, data: null, error: 'supabase_not_configured' };
  return safeFetch(`${base}/rest/v1/${path}`, { headers: supabaseHeaders() });
};

async function count(table: string, query = 'select=*&limit=1') {
  const base = env('SUPABASE_URL').replace(/\/$/, '');
  if (!base || !supabaseKey()) return null;
  try {
    const response = await fetch(`${base}/rest/v1/${table}?${query}`, {
      headers: { ...supabaseHeaders(), Prefer: 'count=exact' },
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return null;
    const range = response.headers.get('content-range') || '';
    const total = range.split('/')[1];
    return total && total !== '*' ? Number(total) : null;
  } catch { return null; }
}

export async function getLiveOverview() {
  const [profiles, cafes, baristas, jobs, applications, subscriptions, payments] = await Promise.all([
    count('profiles'), count('cafe_profiles'), count('barista_profiles'), count('jobs'), count('applications'), count('cafe_subscriptions'), count('subscription_payments'),
  ]);
  const configured = Boolean(env('SUPABASE_URL') && supabaseKey());
  return { source: 'supabase', configured, metrics: { profiles, cafes, baristas, jobs, applications, subscriptions, payments }, status: configured ? 'connected' : 'configuration_required' };
}

export async function getSupportSummary() {
  const candidates = [
    { table: 'support_tickets', select: 'ticket_id,status,created_at' },
    { table: 'support_requests', select: 'id,status,created_at' },
  ];
  for (const candidate of candidates) {
    const result = await sb(`${candidate.table}?select=${candidate.select}&order=created_at.desc&limit=100`);
    if (result.ok && Array.isArray(result.data)) {
      const open = result.data.filter((row: any) => !['resolved', 'closed'].includes(String(row.status || '').toLowerCase())).length;
      return { source: `supabase:${candidate.table}`, configured: true, total_recent: result.data.length, open };
    }
  }
  return { source: 'supabase', configured: Boolean(env('SUPABASE_URL') && supabaseKey()), total_recent: null, open: null, note: 'No readable support table was found by the private read-only adapter.' };
}

export async function getBillingSummary() {
  const [subscriptions, payments] = await Promise.all([
    sb('cafe_subscriptions?select=status,cancel_at_period_end,complimentary_access&limit=500'),
    sb('subscription_payments?select=status,amount_cents,currency,paid_at&order=paid_at.desc&limit=500'),
  ]);
  const subscriptionRows = subscriptions.ok && Array.isArray(subscriptions.data) ? subscriptions.data : [];
  const paymentRows = payments.ok && Array.isArray(payments.data) ? payments.data : [];
  return {
    source: 'supabase-billing',
    configured: Boolean(env('SUPABASE_URL') && supabaseKey()),
    subscriptions: {
      total: subscriptionRows.length,
      active: subscriptionRows.filter((row: any) => String(row.status).toLowerCase() === 'active').length,
      past_due: subscriptionRows.filter((row: any) => ['past_due', 'unpaid', 'incomplete'].includes(String(row.status).toLowerCase())).length,
      canceling: subscriptionRows.filter((row: any) => Boolean(row.cancel_at_period_end)).length,
    },
    payments: {
      recent: paymentRows.length,
      failed: paymentRows.filter((row: any) => String(row.status).toLowerCase() === 'failed').length,
      refunded: paymentRows.filter((row: any) => String(row.status).toLowerCase() === 'refunded').length,
    },
  };
}

export async function getSystemHealth() {
  const checks: Array<{ service: string; ok: boolean; status: string | number }> = [];
  const publicUrl = env('BJM_PUBLIC_URL') || 'https://www.baristajobmatch.com';
  const website = await safeFetch(publicUrl, { method: 'HEAD' });
  checks.push({ service: 'website', ok: website.ok, status: website.status || 'unreachable' });

  const supabaseConfigured = Boolean(env('SUPABASE_URL') && supabaseKey());
  checks.push({ service: 'supabase-read-adapter', ok: supabaseConfigured, status: supabaseConfigured ? 'configured' : 'configuration_required' });

  checks.push({ service: 'resend', ok: true, status: 'not_required_in_read_only_office' });
  checks.push({ service: 'stripe', ok: true, status: 'not_required_in_read_only_office' });

  return { source: 'server-health', overall: checks.every((check) => check.ok) ? 'healthy' : checks.some((check) => check.ok) ? 'attention' : 'unavailable', checks };
}

export async function getDecisionSignals() {
  const [billing, health, support] = await Promise.all([getBillingSummary(), getSystemHealth(), getSupportSummary()]);
  const items: any[] = [];
  if (billing.configured && (billing.subscriptions.past_due > 0 || billing.payments.failed > 0)) {
    items.push({ agent: 'billing-subscriptions', severity: 'P1', title: 'Billing issues need review', summary: `${billing.subscriptions.past_due} past-due subscriptions and ${billing.payments.failed} failed payments detected.`, protected: true });
  }
  if (health.overall !== 'healthy') {
    items.push({ agent: 'engineering-reliability', severity: 'P1', title: 'Office data connection needs attention', summary: 'The private Office is reachable, but its read-only Supabase adapter still needs configuration.', protected: true });
  }
  if (typeof support.open === 'number' && support.open > 0) {
    items.push({ agent: 'customer-support', severity: 'P2', title: 'Open support requests', summary: `${support.open} recent support requests appear open.`, protected: false });
  }
  return items;
}
