import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readConfig, makeClients, listStripe, collectSnapshot, buildFindings, syncFindings, run } from '../ops/billing-agent/connect.mjs';

const env = { BILLING_AGENT_ENABLED: 'true', BILLING_AGENT_MODE: 'test', STRIPE_BILLING_READ_ONLY_KEY: 'rk_test_fixture', BILLING_AGENT_READ_ONLY_CONFIRMED: 'true', BILLING_AGENT_STRIPE_ACCOUNT_ID: 'acct_fixture', NOTION_API_TOKEN: 'fixture-not-a-secret' };
const config = readConfig(env);
const now = 1788782400;
const charge = (id, customer = 'cus_one', extra = {}) => ({ id, customer, status: 'succeeded', amount: 999, currency: 'usd', created: now - 100, refunded: false, amount_refunded: 0, captured: true, livemode: false, ...extra });
const event = (extra = {}) => ({ id: 'evt_one', type: 'invoice.paid', created: now - 100, pending_webhooks: 0, livemode: false, ...extra });
const subscription = (extra = {}) => ({ id: 'sub_one', customer: 'cus_one', status: 'active', cancel_at_period_end: false, livemode: false, ...extra });
const snapshot = (extra = {}) => ({ mode: 'test', account: 'acct_fixture', asOf: new Date(now * 1000).toISOString(), days: 7, subscriptions: [], charges: [], events: [], ...extra });
const response = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, headers: new Headers(), json: async () => data });
function stripeFixture(extra = {}) {
  return async (method, path) => {
    assert.equal(method, 'GET');
    const route = path.split('?')[0];
    if (route === '/v1/account') return { id: extra.account || 'acct_fixture' };
    return { data: ({ '/v1/subscriptions': extra.subscriptions || [], '/v1/charges': extra.charges || [], '/v1/events': extra.events || [] })[route], has_more: false };
  };
}
function notionFixture() {
  const fields = { Task: 'title', Status: 'select', Priority: 'select', Area: 'select', Agent: 'rich_text', Summary: 'rich_text', Source: 'select', 'Event Key': 'rich_text', 'Source Link': 'url', 'Owner Approval Required': 'checkbox' };
  const schema = { properties: Object.fromEntries(Object.entries(fields).map(([name, type]) => [name, { type, ...(type === 'select' ? { select: { options: ({ Status: ['Waiting for Owner Approval', 'Verified'], Priority: ['High', 'Medium', 'Low'], Area: ['Payments'], Source: ['Billing Agent'] })[name].map((name) => ({ name })) } } : {}) }])) };
  const pages = new Map();
  const calls = [];
  async function client(method, path, body) {
    calls.push({ method, path, body });
    if (method === 'GET') return schema;
    if (path.endsWith('/query')) return { results: [...pages.values()].filter((p) => p.properties['Event Key'].rich_text[0].text.content === body.filter.rich_text.equals), has_more: false };
    if (method === 'POST') {
      const id = `11111111-1111-4111-8111-${String(pages.size + 1).padStart(12, '0')}`;
      const page = { id, ...structuredClone(body) };
      pages.set(id, page); return page;
    }
    assert.equal(method, 'PATCH');
    const page = pages.get(path.split('/').at(-1));
    Object.assign(page.properties, structuredClone(body.properties));
    return page;
  }
  return { client, schema, pages, calls };
}

test('configuration requires a restricted key, matching mode and read-only attestation', () => {
  for (const patch of [{ STRIPE_BILLING_READ_ONLY_KEY: '' }, { STRIPE_BILLING_READ_ONLY_KEY: 'sk_test_fixture' }, { BILLING_AGENT_MODE: 'live' }, { BILLING_AGENT_MODE: 'invalid' }, { BILLING_AGENT_READ_ONLY_CONFIRMED: '' }]) assert.throws(() => readConfig({ ...env, ...patch }));
  assert.equal(readConfig({ ...env, BILLING_AGENT_MODE: 'live', STRIPE_BILLING_READ_ONLY_KEY: 'rk_live_fixture' }).mode, 'live');
});
test('configuration rejects missing account/token and invalid coverage windows', () => {
  for (const patch of [{ BILLING_AGENT_STRIPE_ACCOUNT_ID: '' }, { NOTION_API_TOKEN: '' }, { BILLING_AGENT_LOOKBACK_DAYS: '29' }, { BILLING_AGENT_LOOKBACK_DAYS: '-1' }, { BILLING_AGENT_LOOKBACK_DAYS: '1.5' }]) assert.throws(() => readConfig({ ...env, ...patch }));
});
test('all Stripe writes and non-allowlisted routes are blocked before network access', async () => {
  let calls = 0;
  const { stripe } = makeClients(config, async () => { calls++; return response({}); });
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) await assert.rejects(stripe(method, '/v1/charges'), /blocked/);
  for (const path of ['/v1/refunds', '/v1/customers', 'https://attacker.invalid', '//attacker.invalid/v1/account']) await assert.rejects(stripe('GET', path), /blocked/);
  assert.equal(calls, 0);
});
test('requests have fixed origins, pinned versions, timeout and redirect rejection', async () => {
  const { stripe } = makeClients(config, async (url, init) => {
    assert.equal(url, 'https://api.stripe.com/v1/account');
    assert.equal(init.method, 'GET'); assert.equal(init.redirect, 'error');
    assert.equal(init.headers['Stripe-Version'], '2025-06-30.basil');
    assert.ok(init.signal); assert.equal(init.body, undefined);
    return response({ id: 'acct_fixture' });
  });
  await stripe('GET', '/v1/account');
});
test('transient reads retry but Notion creates never blindly retry', async () => {
  let count = 0;
  const { stripe } = makeClients(config, async () => ++count < 3 ? response({}, 429) : response({ id: 'acct_fixture' }), async () => {});
  await stripe('GET', '/v1/account'); assert.equal(count, 3);
  count = 0;
  const { notion } = makeClients(config, async () => { count++; return response({}, 503); }, async () => {});
  await assert.rejects(notion('POST', '/v1/pages', {}), /notion_http_503/); assert.equal(count, 1);
});
test('provider failures never include response bodies or secret-bearing transport text', async () => {
  const a = makeClients(config, async () => response({ message: 'private-customer-and-secret' }, 403));
  await assert.rejects(a.stripe('GET', '/v1/account'), (e) => e.message === 'stripe_http_403');
  const b = makeClients(config, async () => { throw new Error('private-customer-and-secret'); }, async () => {});
  await assert.rejects(b.stripe('GET', '/v1/account'), (e) => e.message === 'stripe_transport_error');
});
test('malformed JSON and forbidden Notion routes fail closed', async () => {
  const c = makeClients(config, async () => ({ ok: true, json: async () => { throw Error('secret'); } }));
  await assert.rejects(c.stripe('GET', '/v1/account'), /stripe_invalid_json/);
  await assert.rejects(c.notion('DELETE', '/v1/pages/11111111-1111-4111-8111-111111111111'), /notion_route_blocked/);
});
test('pagination follows cursors and returns the entire bounded list', async () => {
  let n = 0;
  const rows = await listStripe(async (method, path) => {
    n++; assert.equal(method, 'GET');
    if (n === 1) return { data: [{ id: 'ch_one' }], has_more: true };
    assert.match(path, /starting_after=ch_one/);
    return { data: [{ id: 'ch_two' }], has_more: false };
  }, '/v1/charges', [], (x) => x.id);
  assert.deepEqual(rows, ['ch_one', 'ch_two']);
});
test('truncated, repeated, malformed and non-advancing pagination are rejected', async () => {
  await assert.rejects(listStripe(async () => ({ data: [{ id: 'ch_one' }], has_more: true }), '/v1/charges', [], (x) => x, 1), /coverage_limit/);
  await assert.rejects(listStripe(async () => ({ data: [{ id: 'ch_one' }], has_more: true }), '/v1/charges', [], (x) => x), /repeated_stripe/);
  await assert.rejects(listStripe(async () => ({ data: [], has_more: true }), '/v1/charges', [], (x) => x), /cursor/);
  await assert.rejects(listStripe(async () => ({ data: [] }), '/v1/charges', [], (x) => x), /invalid_stripe_list/);
});
test('wrong Stripe account and record mode are rejected', async () => {
  await assert.rejects(collectSnapshot(config, stripeFixture({ account: 'acct_wrong' }), now), /account_mismatch/);
  await assert.rejects(collectSnapshot(config, stripeFixture({ charges: [charge('ch_one', 'cus_one', { livemode: true })] }), now), /mode_mismatch/);
});
test('snapshot discards PII, card details, metadata and event payload secrets', async () => {
  const s = await collectSnapshot(config, stripeFixture({ subscriptions: [subscription()], charges: [charge('ch_one', 'cus_one', { billing_details: { email: 'private@example.invalid' }, payment_method_details: { card: { last4: '9876' } }, metadata: { confidential: 'sensitive' } })], events: [event({ data: { object: { client_secret: 'never-retain' } } })] }), now);
  assert.equal(s.charges.length, 1);
  for (const text of ['private@example.invalid', '9876', 'sensitive', 'never-retain', 'billing_details']) assert.equal(JSON.stringify(s).includes(text), false);
});
test('invalid charge amounts and unknown statuses do not silently become healthy', async () => {
  for (const extra of [{ amount: -1 }, { amount_refunded: 2000 }, { status: 'unexpected' }]) await assert.rejects(collectSnapshot(config, stripeFixture({ charges: [charge('ch_one', 'cus_one', extra)] }), now), /invalid_charge/);
});
test('same-price payments from different cafes are not suspected duplicates', () => {
  assert.equal(buildFindings(snapshot({ charges: [charge('ch_one'), charge('ch_two', 'cus_two')] })).length, 0);
});
test('same-customer same-day same-amount payments become review-only duplicate candidates', () => {
  const f = buildFindings(snapshot({ charges: [charge('ch_one'), charge('ch_two')] }));
  assert.equal(f.length, 1); assert.match(f[0].title, /Suspected duplicate/);
  assert.match(f[0].summary, /not proof/); assert.equal(f[0].approval, true);
});
test('anonymous charges and uncaptured authorizations are not cross-compared', () => {
  assert.equal(buildFindings(snapshot({ charges: [charge('ch_one', null), charge('ch_two', null)] })).length, 0);
  assert.equal(buildFindings(snapshot({ charges: [charge('ch_one', 'cus_one', { captured: false }), charge('ch_two')] })).length, 0);
});
test('failed payments and partial refunds are retained as review signals', () => {
  const f = buildFindings(snapshot({ charges: [charge('ch_one', 'cus_one', { status: 'failed' }), charge('ch_two', 'cus_two', { amount_refunded: 100 })] }));
  assert.equal(f.length, 2); assert.ok(f.every((x) => x.approval));
  assert.ok(f.some((x) => /later retry may have recovered/.test(x.summary)));
  assert.ok(f.some((x) => /partial refund/.test(x.summary)));
});
test('past-due and scheduled-cancel subscriptions reuse the V1 policy', () => {
  const f = buildFindings(snapshot({ subscriptions: [subscription({ status: 'past_due' }), subscription({ id: 'sub_two', cancel_at_period_end: true })] }));
  assert.deepEqual(f.map((x) => x.priority), ['P1', 'P2']);
});
test('old pending event deliveries and invoice failures are not claimed to prove current failure', () => {
  const f = buildFindings(snapshot({ events: [event({ type: 'invoice.payment_failed', created: now - 1000, pending_webhooks: 1 })] }));
  assert.equal(f.length, 2); assert.ok(f.some((x) => /does not prove the invoice remains unpaid/.test(x.summary)));
  assert.ok(f.some((x) => /does not prove a failed endpoint/.test(x.summary)));
});
test('event keys are stable between runs but isolated by Stripe account and mode', () => {
  const s = snapshot({ charges: [charge('ch_one', 'cus_one', { status: 'failed' })] });
  const key = buildFindings(s)[0].key;
  assert.equal(key, buildFindings({ ...s, asOf: '2026-09-08T00:00:00Z' })[0].key);
  assert.notEqual(key, buildFindings({ ...s, mode: 'live' })[0].key);
  assert.notEqual(key, buildFindings({ ...s, account: 'acct_other' })[0].key);
});
test('too many findings fail before any Notion write', () => {
  assert.throws(() => buildFindings(snapshot({ charges: Array.from({ length: 101 }, (_, i) => charge(`ch_${i}`, null, { status: 'failed' })) })), /finding_limit/);
});
test('Notion sync creates one review card and heartbeat, then preserves owner decisions on reruns', async () => {
  const n = notionFixture();
  const s = snapshot({ charges: [charge('ch_one', 'cus_one', { status: 'failed' })] });
  await syncFindings(config, n.client, s, buildFindings(s));
  assert.equal(n.pages.size, 2);
  const review = [...n.pages.values()][0];
  assert.equal(review.properties.Status.select.name, 'Waiting for Owner Approval');
  review.properties.Status.select.name = 'Approved';
  review.properties.Task.title[0].text.content = 'Owner-edited title';
  review.properties['Owner Approval Required'].checkbox = false;
  await syncFindings(config, n.client, { ...s, asOf: '2026-09-08T00:00:00Z' }, buildFindings(s));
  assert.equal(n.pages.size, 2); assert.equal(review.properties.Status.select.name, 'Approved');
  assert.equal(review.properties.Task.title[0].text.content, 'Owner-edited title');
  assert.equal(review.properties['Owner Approval Required'].checkbox, false);
  for (const c of n.calls.filter((x) => x.method === 'PATCH')) assert.deepEqual(Object.keys(c.body.properties), ['Summary']);
});
test('schema mismatch and duplicate Notion Event Keys fail closed', async () => {
  const n = notionFixture(); n.schema.properties.Status.type = 'status';
  await assert.rejects(syncFindings(config, n.client, snapshot(), []), /schema_mismatch/);
  assert.equal(n.calls.length, 1);
  const m = notionFixture();
  await assert.rejects(syncFindings(config, async (method, path, body) => path.endsWith('/query') ? { results: [{}, {}], has_more: false } : m.client(method, path, body), snapshot(), []), /event_key_not_unique/);
  assert.equal(m.pages.size, 0);
});
test('the heartbeat is written only after every review item succeeds', async () => {
  const n = notionFixture(); let creates = 0;
  const s = snapshot({ charges: [charge('ch_one', 'cus_one', { status: 'failed' })] });
  await assert.rejects(syncFindings(config, async (method, path, body) => {
    if (method === 'POST' && path === '/v1/pages') { creates++; throw Error('simulated failure'); }
    return n.client(method, path, body);
  }, s, buildFindings(s)), /simulated failure/);
  assert.equal(creates, 1); assert.equal(n.pages.size, 0);
});
test('disabled mode and incomplete Stripe reads cause no Notion writes', async () => {
  let requests = 0;
  await assert.rejects(run({ ...env, BILLING_AGENT_ENABLED: 'false' }, async () => { requests++; }), /not_enabled/);
  assert.equal(requests, 0);
  const calls = [];
  await assert.rejects(run(env, async (url) => {
    calls.push(url);
    if (url.endsWith('/v1/account')) return response({ id: 'acct_fixture' });
    if (url.includes('/subscriptions')) return response({ data: [], has_more: false });
    return response({}, 403);
  }), /stripe_http_403/);
  assert.ok(calls.every((u) => u.startsWith('https://api.stripe.com/')));
});
test('mocked end-to-end bridge sends no financial writes and emits no private business metrics', async () => {
  const n = notionFixture();
  const s = stripeFixture({ subscriptions: [subscription({ status: 'past_due' })] });
  const result = await run(env, async (url, init) => {
    const u = new URL(url);
    const data = u.hostname === 'api.stripe.com' ? await s(init.method, u.pathname + u.search) : await n.client(init.method, u.pathname, init.body ? JSON.parse(init.body) : undefined);
    return response(data);
  });
  assert.deepEqual(result, { status: 'synced', mode: 'test', financial_writes: false });
  assert.equal(n.pages.size, 2);
});
test('workflow keeps runtime secrets off pull requests and behind default-branch opt-in', () => {
  const yml = readFileSync(new URL('../.github/workflows/billing-agent-connection.yml', import.meta.url), 'utf8');
  assert.ok(!yml.includes('pull_request_target'));
  assert.match(yml, /github.ref == 'refs\/heads\/main'/);
  assert.match(yml, /vars.BILLING_AGENT_ENABLED == 'true'/);
  assert.match(yml, /github.event_name == 'workflow_dispatch'/);
  assert.match(yml, /needs: test/);
  assert.match(yml, /persist-credentials: false/);
  assert.ok(!yml.includes('upload-artifact'));
  assert.match(yml, /STRIPE_BILLING_READ_ONLY_KEY: \$\{\{ secrets.STRIPE_BILLING_READ_ONLY_KEY \}\}/);
});
