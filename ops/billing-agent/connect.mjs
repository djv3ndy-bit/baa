/** Private, opt-in Stripe -> existing Billing Agent -> Notion bridge. Node 22, no SDK. */
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { BILLING_AGENT_POLICY, analyzeSubscription, analyzePayments } from '../../api/_billing-agent.js';

const DATA_SOURCE = '64a712d1-8a77-44da-8db5-6a80b9ace054';
const STRIPE_VERSION = '2025-06-30.basil';
const NOTION_VERSION = '2025-09-03';
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const EVENTS = ['charge.succeeded', 'charge.failed', 'charge.refunded', 'invoice.payment_failed', 'invoice.paid', 'customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted'];
const POLICY = 'Review only. Any charge, refund, cancellation, pricing, subscription, or database change requires separate owner approval and a separate execution path.';
class BridgeError extends Error {}
const fail = (code) => { throw new BridgeError(code); };
const must = (condition, code) => { if (!condition) fail(code); };
const objectId = (value, prefix) => {
  const id = typeof value === 'object' && value ? value.id : value;
  must(typeof id === 'string' && new RegExp(`^${prefix}_[A-Za-z0-9]+$`).test(id), 'invalid_provider_id');
  return id;
};
const rich = (content) => ({ rich_text: [{ type: 'text', text: { content: content.slice(0, 1900) } }] });

export function readConfig(env = process.env) {
  const mode = env.BILLING_AGENT_MODE || 'test';
  const key = (env.STRIPE_BILLING_READ_ONLY_KEY || '').trim();
  must(['test', 'live'].includes(mode), 'invalid_mode');
  must(new RegExp(`^rk_${mode}_[A-Za-z0-9]+$`).test(key), 'restricted_key_required_for_selected_mode');
  // Prefix alone does not prove permissions. Require explicit setup attestation too.
  must(env.BILLING_AGENT_READ_ONLY_CONFIRMED === 'true', 'confirm_stripe_read_only_permissions');
  const account = objectId(env.BILLING_AGENT_STRIPE_ACCOUNT_ID, 'acct');
  const token = (env.NOTION_API_TOKEN || '').trim();
  must(token.length > 0, 'notion_token_required');
  const days = Number(env.BILLING_AGENT_LOOKBACK_DAYS || 7);
  must(Number.isInteger(days) && days >= 1 && days <= 28, 'lookback_must_be_1_to_28_days');
  return Object.freeze({ mode, key, account, token, days, dataSource: DATA_SOURCE });
}

/** Only fixed provider origins; never follow redirects with authorization headers. */
export function makeClients(config, fetcher = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms))) {
  async function request(provider, method, path, body, retryableRead = false) {
    const stripe = provider === 'stripe';
    const route = path.split('?')[0];
    if (stripe) {
      must(method === 'GET' && ['/v1/account', '/v1/subscriptions', '/v1/charges', '/v1/events'].includes(route), 'stripe_write_or_route_blocked');
    } else {
      const ds = `/v1/data_sources/${config.dataSource}`;
      must((method === 'GET' && path === ds) || (method === 'POST' && path === `${ds}/query`) || (method === 'POST' && path === '/v1/pages') || (method === 'PATCH' && route.startsWith('/v1/pages/') && UUID.test(route.slice(10))), 'notion_route_blocked');
    }
    const headers = { Authorization: `Bearer ${stripe ? config.key : config.token}`, 'Content-Type': 'application/json', [stripe ? 'Stripe-Version' : 'Notion-Version']: stripe ? STRIPE_VERSION : NOTION_VERSION };
    const attempts = method === 'GET' || retryableRead ? 3 : 1;
    for (let attempt = 0; attempt < attempts; attempt++) {
      let response;
      try {
        response = await fetcher(`${stripe ? 'https://api.stripe.com' : 'https://api.notion.com'}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined, redirect: 'error', signal: AbortSignal.timeout(10000) });
      } catch {
        if (attempt + 1 < attempts) { await sleep(500 * 2 ** attempt); continue; }
        fail(`${provider}_transport_error`);
      }
      if (!response.ok) {
        if ([429, 500, 502, 503, 504].includes(response.status) && attempt + 1 < attempts) {
          const delay = Number(response.headers?.get('retry-after')) || 2 ** attempt;
          await sleep(Math.min(8000, Math.max(500, delay * 1000))); continue;
        }
        // Never expose response bodies, headers, credentials, or customer error text.
        fail(`${provider}_http_${response.status}`);
      }
      try { return await response.json(); } catch { fail(`${provider}_invalid_json`); }
    }
  }
  return {
    stripe: (method, path) => request('stripe', method, path),
    notion: (method, path, body) => request('notion', method, path, body, path.endsWith('/query')),
  };
}

export async function listStripe(client, path, query, mapper, maxPages = 20) {
  const result = [];
  let cursor;
  const seen = new Set();
  for (let page = 0; page < maxPages; page++) {
    const params = new URLSearchParams(query);
    params.set('limit', '100');
    if (cursor) params.set('starting_after', cursor);
    const response = await client('GET', `${path}?${params}`);
    must(Array.isArray(response?.data) && typeof response.has_more === 'boolean', 'invalid_stripe_list');
    for (const row of response.data) {
      must(typeof row?.id === 'string' && !seen.has(row.id), 'repeated_stripe_record');
      seen.add(row.id);
      result.push(mapper(row)); // Retain only allowlisted fields, not raw payment/customer data.
    }
    if (!response.has_more) return result;
    must(response.data.length > 0, 'invalid_stripe_cursor');
    cursor = response.data.at(-1).id;
  }
  fail('stripe_coverage_limit_exceeded'); // Never represent a truncated window as complete.
}

export async function collectSnapshot(config, stripe, now = Math.floor(Date.now() / 1000)) {
  const account = await stripe('GET', '/v1/account');
  must(account?.id === config.account, 'stripe_account_mismatch');
  const modeCheck = (row) => must(row.livemode === (config.mode === 'live'), 'stripe_record_mode_mismatch');
  const timestamp = (n) => { must(Number.isSafeInteger(n) && n > 0, 'invalid_timestamp'); return n; };
  const window = [['created[gte]', String(now - config.days * 86400)], ['created[lte]', String(now)]];
  const subscriptions = await listStripe(stripe, '/v1/subscriptions', [['status', 'all']], (s) => {
    modeCheck(s);
    must(['active', 'trialing', 'past_due', 'unpaid', 'incomplete', 'incomplete_expired', 'canceled', 'paused'].includes(s.status) && typeof s.cancel_at_period_end === 'boolean', 'invalid_subscription');
    return { id: objectId(s.id, 'sub'), customer: objectId(s.customer, 'cus'), status: s.status, cancel_at_period_end: s.cancel_at_period_end };
  });
  const charges = await listStripe(stripe, '/v1/charges', window, (c) => {
    modeCheck(c);
    must(['succeeded', 'failed', 'pending'].includes(c.status) && Number.isSafeInteger(c.amount) && c.amount >= 0 && Number.isSafeInteger(c.amount_refunded) && c.amount_refunded >= 0 && c.amount_refunded <= c.amount && /^[a-z]{3}$/.test(c.currency) && typeof c.refunded === 'boolean' && typeof c.captured === 'boolean', 'invalid_charge');
    return { id: objectId(c.id, 'ch'), customer: c.customer ? objectId(c.customer, 'cus') : null, status: c.status, amount: c.amount, currency: c.currency, created: timestamp(c.created), refunded: c.refunded, amount_refunded: c.amount_refunded, captured: c.captured };
  });
  const events = await listStripe(stripe, '/v1/events', [...window, ...EVENTS.map((t) => ['types[]', t])], (e) => {
    modeCheck(e);
    must(EVENTS.includes(e.type) && Number.isSafeInteger(e.pending_webhooks) && e.pending_webhooks >= 0, 'invalid_event');
    return { id: objectId(e.id, 'evt'), type: e.type, created: timestamp(e.created), pending_webhooks: e.pending_webhooks };
  });
  return { mode: config.mode, account: config.account, asOf: new Date(now * 1000).toISOString(), days: config.days, subscriptions, charges, events };
}

/** Reuse V1 analysis; do NOT compare equal-price payments across different cafes. */
export function buildFindings(snapshot) {
  must(BILLING_AGENT_POLICY.stripe_write_allowed === false, 'billing_policy_changed');
  const findings = [];
  const add = (kind, ids, title, priority, summary) => {
    const key = createHash('sha256').update(JSON.stringify([snapshot.mode, snapshot.account, kind, [...ids].sort()])).digest('hex').slice(0, 40);
    findings.push({ key: `billing:v1:${key}`, title: `[${snapshot.mode.toUpperCase()}] ${title}`, priority, summary: `${summary}\nObserved: ${snapshot.asOf}. ${POLICY}`, approval: true });
  };
  for (const s of snapshot.subscriptions) {
    const r = analyzeSubscription({ ...s, status: s.status === 'incomplete_expired' ? 'expired' : s.status, stripe_subscription_id: s.id, stripe_customer_id: s.customer });
    if (r.priority !== 'P3') add(`subscription:${s.status}:${s.cancel_at_period_end}`, [s.id], 'Subscription needs billing review', r.priority, `${s.id}: ${r.finding}`);
    if (s.status === 'paused') add('paused', [s.id], 'Paused subscription needs review', 'P2', `${s.id} is paused. Do not resume or modify it automatically.`);
  }
  const groups = new Map();
  for (const c of snapshot.charges) {
    // Anonymous charges cannot safely be matched to each other.
    const group = c.customer || c.id;
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push({ provider_payment_id: c.id, status: c.refunded ? 'refunded' : c.status === 'succeeded' && !c.captured ? 'pending' : c.status, amount_cents: c.amount, currency: c.currency, paid_at: new Date(c.created * 1000).toISOString() });
    if (c.amount_refunded > 0) add('refund', [c.id], 'Refund record available for review', 'P2', `${c.id} has a recorded full or partial refund. No refund was initiated by this agent.`);
  }
  for (const payments of groups.values()) {
    const r = analyzePayments(payments);
    for (const p of r.failed) add('failed-charge', [p.id], 'Failed payment needs review', 'P1', `${p.id} failed in the ${snapshot.days}-day window; a later retry may have recovered. Check current invoice and subscription before contacting the customer.`);
    for (const d of r.duplicate_looking) add('suspected-duplicate', [d.first.id, d.second.id], 'Suspected duplicate — verify before action', 'P1', `${d.first.id} and ${d.second.id}: same customer, amount, currency, and UTC creation day. This is a review signal, not proof of a duplicate or settlement. Verify invoices, capture times, and charge IDs.`);
  }
  for (const e of snapshot.events) {
    if (e.type === 'invoice.payment_failed') add('invoice-failure-event', [e.id], 'Invoice failure event needs review', 'P1', `${e.id}: invoice.payment_failed was observed. This historical event does not prove the invoice remains unpaid; verify current state in Stripe.`);
    if (e.pending_webhooks > 0 && Date.parse(snapshot.asOf) / 1000 - e.created > 900) add('pending-delivery', [e.id], 'Billing event delivery needs review', 'P2', `${e.id} has outstanding webhook deliveries after 15 minutes. Inspect endpoint delivery logs; this does not prove a failed endpoint or duplicate processing.`);
  }
  must(findings.length <= 100, 'finding_limit_exceeded');
  return findings;
}

export async function syncFindings(config, notion, snapshot, findings) {
  const dsPath = `/v1/data_sources/${config.dataSource}`;
  const schema = await notion('GET', dsPath);
  const types = { Task: 'title', Status: 'select', Priority: 'select', Area: 'select', Agent: 'rich_text', Summary: 'rich_text', Source: 'select', 'Event Key': 'rich_text', 'Source Link': 'url', 'Owner Approval Required': 'checkbox' };
  for (const [name, type] of Object.entries(types)) must(schema?.properties?.[name]?.type === type, 'notion_schema_mismatch');
  for (const [name, options] of Object.entries({ Status: ['Waiting for Owner Approval', 'Verified'], Priority: ['High', 'Medium', 'Low'], Area: ['Payments'], Source: ['Billing Agent'] })) {
    must(options.every((nameOption) => schema.properties[name].select?.options?.some((o) => o.name === nameOption)), 'notion_options_mismatch');
  }
  const heartbeatKey = createHash('sha256').update(`${snapshot.mode}:${snapshot.account}`).digest('hex').slice(0, 32);
  const cards = [...findings, { key: `billing:connection:v1:${heartbeatKey}`, title: `[${snapshot.mode.toUpperCase()}] Billing data feed connection verified`, priority: 'P3', approval: false, summary: `Successful bounded read and Notion sync at ${snapshot.asOf}. Charges and selected events: last ${snapshot.days} days; subscriptions: current paginated snapshot (not transactional). Records: ${snapshot.subscriptions.length} subscriptions, ${snapshot.charges.length} charges, ${snapshot.events.length} selected events; ${findings.length} review findings. Anonymous charges: ${snapshot.charges.filter((c) => !c.customer).length}; these are not cross-compared. This verifies the feed only, not settlement, webhook processing, app access reconciliation, or launch readiness. ${POLICY}` }];
  for (const card of cards) {
    const query = await notion('POST', `${dsPath}/query`, { filter: { property: 'Event Key', rich_text: { equals: card.key } }, page_size: 2 });
    must(Array.isArray(query?.results) && typeof query.has_more === 'boolean' && !query.has_more && query.results.length <= 1, 'notion_event_key_not_unique');
    if (query.results.length) {
      const page = query.results[0];
      must(UUID.test(page.id), 'invalid_notion_page_id');
      // Never overwrite the owner's Status, checkbox, title, notes, or approval decision.
      await notion('PATCH', `/v1/pages/${page.id}`, { properties: { Summary: rich(card.summary) } });
    } else {
      await notion('POST', '/v1/pages', { parent: { data_source_id: config.dataSource }, properties: {
        Task: { title: [{ type: 'text', text: { content: card.title } }] },
        Status: { select: { name: card.approval ? 'Waiting for Owner Approval' : 'Verified' } },
        Priority: { select: { name: { P1: 'High', P2: 'Medium', P3: 'Low' }[card.priority] } },
        Area: { select: { name: 'Payments' } }, Source: { select: { name: 'Billing Agent' } },
        Agent: rich('Billing / Payments Agent'), Summary: rich(card.summary), 'Event Key': rich(card.key), 'Owner Approval Required': { checkbox: card.approval },
      } });
    }
  }
  return { status: 'synced', mode: config.mode, financial_writes: false };
}

export async function run(env = process.env, fetcher = fetch) {
  must(env.BILLING_AGENT_ENABLED === 'true', 'billing_agent_not_enabled');
  const config = readConfig(env);
  const clients = makeClients(config, fetcher);
  const snapshot = await collectSnapshot(config, clients.stripe);
  const findings = buildFindings(snapshot);
  return syncFindings(config, clients.notion, snapshot, findings);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().then((result) => console.log(JSON.stringify(result))).catch((error) => {
    console.error(JSON.stringify({ status: 'failed', code: error instanceof BridgeError ? error.message : 'unexpected_error', financial_writes: false }));
    process.exitCode = 1;
  });
}
