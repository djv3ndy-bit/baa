/** Aggregate-only Data API adapter. Call only after the owner boundary verifies
 * this exact token. The RPC independently checks claims and its role/grants.
 * Each factory belongs to ONE HTTP request; never cache it across requests.
 */
const clean = value => typeof value === 'string' ? value.trim() : '';
const COUNT_KEYS = ['profiles', 'cafes', 'baristas', 'jobs', 'applications', 'subscriptions', 'payments'];
const SUBSCRIPTION_KEYS = ['total', 'active', 'past_due', 'canceling'];
const PAYMENT_KEYS = ['recent', 'failed', 'refunded'];
const MAX_RESPONSE_BYTES = 16384;
const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const counts = (value, keys) => Object.fromEntries(keys.map(key => [key,
  Number.isSafeInteger(object(value)[key]) && object(value)[key] >= 0 ? object(value)[key] : null]));
const valuesAvailability = values => values.every(value => value !== null) ? 'available'
  : values.some(value => value !== null) ? 'partial' : 'unavailable';

function configuration(env, accessToken) {
  if (clean(env.SUPABASE_SECRET_KEY) || clean(env.SUPABASE_SERVICE_ROLE_KEY)) {
    return { reason: 'privileged_credentials_forbidden', availability: 'configuration_required' };
  }
  let url;
  try {
    url = new URL(clean(env.SUPABASE_URL));
    if (url.protocol !== 'https:' || url.pathname !== '/' || url.search || url.hash || url.username || url.password) throw new Error();
  } catch { return { reason: 'aggregate_adapter_not_configured', availability: 'configuration_required' }; }
  const publishableKey = clean(env.SUPABASE_PUBLISHABLE_KEY);
  if (!/^sb_publishable_[A-Za-z0-9_-]+$/.test(publishableKey)) {
    return { reason: 'aggregate_adapter_not_configured', availability: 'configuration_required' };
  }
  // Shape check is NOT signature verification. Call authorizeOfficeRequest first.
  if (typeof accessToken !== 'string' || accessToken.length > 8192 ||
      !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(accessToken)) {
    return { reason: 'verified_owner_context_required', availability: 'authentication_required' };
  }
  return { url: url.origin, publishableKey };
}

async function limitedJson(response) {
  if (!response.body) throw new Error('empty');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new Error('oversized'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}

export function createOfficeProviders(accessToken, options = {}) {
  const env = options.env || process.env;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const now = options.now || Date.now;
  const config = configuration(env, accessToken);
  let snapshotPromise;
  let healthPromise;

  const unavailable = (reason, availability = 'unavailable') => ({ configured: !config.reason, availability, reason, generated_at: null, data: {} });
  async function loadSnapshot() {
    if (config.reason) return unavailable(config.reason, config.availability);
    let response;
    try {
      response = await fetchImpl(`${config.url}/rest/v1/rpc/office_read_snapshot`, {
        method: 'POST', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(5000),
        headers: { apikey: config.publishableKey, Authorization: `Bearer ${accessToken}`, Accept: 'application/json', 'Content-Type': 'application/json' },
        body: '{}',
      });
    } catch { return unavailable('aggregate_provider_unreachable'); }
    if (!response.ok) return unavailable(response.status === 401 || response.status === 403
      ? 'aggregate_access_denied' : response.status === 404 ? 'aggregate_rpc_not_installed' : 'aggregate_provider_unavailable');
    let data;
    try { data = await limitedJson(response); } catch { return unavailable('aggregate_response_invalid'); }
    if (object(data).schema_version !== 1 || typeof data.generated_at !== 'string') return unavailable('aggregate_response_invalid');
    const generatedAt = Date.parse(data.generated_at);
    if (!Number.isFinite(generatedAt) || generatedAt > now() + 30000 || generatedAt < now() - 300000) return unavailable('aggregate_timestamp_invalid');
    // Whitelist returned fields below. Never spread a provider response.
    return { configured: true, availability: 'available', reason: null, generated_at: new Date(generatedAt).toISOString(), data };
  }
  const snapshot = () => snapshotPromise ||= loadSnapshot();
  function metadata(result, valueList) {
    const availability = result.availability === 'available' ? valuesAvailability(valueList) : result.availability;
    return { source: 'supabase:office_read_snapshot', configured: result.configured, availability,
      reason: result.reason || (availability === 'available' ? null : 'aggregate_fields_unavailable'), generated_at: result.generated_at };
  }
  async function getLiveOverview() {
    const result = await snapshot();
    const metrics = counts(result.data.metrics, COUNT_KEYS);
    return { ...metadata(result, Object.values(metrics)), metrics, status: metadata(result, Object.values(metrics)).availability === 'available' ? 'connected' : 'unavailable' };
  }
  async function getSupportSummary() {
    const result = await snapshot();
    const summary = counts(result.data.support, ['total_recent', 'open']);
    if (summary.open !== null && summary.total_recent !== null && summary.open > summary.total_recent) summary.open = null;
    return { ...metadata(result, Object.values(summary)), ...summary, window_days: 30 };
  }
  async function getBillingSummary() {
    const result = await snapshot();
    const billing = object(result.data.billing);
    const subscriptions = counts(billing.subscriptions, SUBSCRIPTION_KEYS);
    const payments = counts(billing.payments, PAYMENT_KEYS);
    for (const key of SUBSCRIPTION_KEYS.slice(1)) {
      if (subscriptions.total !== null && subscriptions[key] !== null && subscriptions[key] > subscriptions.total) subscriptions[key] = null;
    }
    for (const key of PAYMENT_KEYS.slice(1)) {
      if (payments.recent !== null && payments[key] !== null && payments[key] > payments.recent) payments[key] = null;
    }
    return { ...metadata(result, [...Object.values(subscriptions), ...Object.values(payments)]), subscriptions, payments, window_days: 30 };
  }
  async function loadHealth() {
    const [business, support, billing] = await Promise.all([getLiveOverview(), getSupportSummary(), getBillingSummary()]);
    let website = { service: 'website', ok: false, status: 'configuration_required' };
    try {
      const url = new URL(clean(env.BJM_PUBLIC_URL) || 'https://www.baristajobmatch.com');
      if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error();
      const response = await fetchImpl(url.href, { method: 'HEAD', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(5000) });
      website = { service: 'website', ok: response.ok, status: response.status };
    } catch { website.status = 'unreachable'; }
    const sections = [business, support, billing];
    const aggregateOk = sections.every(section => section.availability === 'available');
    const partial = sections.some(section => section.availability === 'partial' || section.availability === 'available');
    const checks = [website, { service: 'supabase-read-adapter', ok: aggregateOk,
      status: aggregateOk ? 'available' : partial ? 'partial' : sections[0].availability }];
    return { source: 'server-health', overall: checks.every(check => check.ok) ? 'healthy'
      : checks.some(check => check.ok) || partial ? 'attention' : 'unavailable', checks };
  }
  const getSystemHealth = () => healthPromise ||= loadHealth();
  async function getDecisionSignals() {
    const [billing, health, support] = await Promise.all([getBillingSummary(), getSystemHealth(), getSupportSummary()]);
    const items = [];
    if ((billing.subscriptions.past_due !== null && billing.subscriptions.past_due > 0) || (billing.payments.failed !== null && billing.payments.failed > 0)) {
      items.push({ agent: 'billing-subscriptions', severity: 'P1', title: 'Billing issues need review',
        summary: `Past-due subscriptions: ${billing.subscriptions.past_due ?? 'unavailable'}. Failed payments in the last 30 days: ${billing.payments.failed ?? 'unavailable'}.`, protected: true });
    }
    if (health.overall !== 'healthy') items.push({ agent: 'engineering-reliability', severity: 'P1', title: 'Office data or website health needs attention',
      summary: 'Some read-only checks are unavailable, incomplete, or unsuccessful. Review availability before interpreting business counts.', protected: true });
    if (support.open !== null && support.open > 0) items.push({ agent: 'customer-support', severity: 'P2', title: 'Open support requests',
      summary: `${support.open} requests created in the last 30 days remain open.`, protected: false });
    return items;
  }
  return Object.freeze({ getLiveOverview, getSupportSummary, getBillingSummary, getSystemHealth, getDecisionSignals });
}
