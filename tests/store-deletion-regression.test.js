import test from 'node:test';
import assert from 'node:assert/strict';
import handler, { endStripeBillingForDeletion, storedObjectsForProfile } from '../api/delete-account.js';
import { stripeApiClient } from '../api/_billing.js';

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const BASE = 'https://project.supabase.co';
const response = (data, status = 200) => new Response(JSON.stringify(data), { status });

function setup(t, options = {}) {
  const oldFetch = globalThis.fetch;
  const keys = ['SUPABASE_URL', 'SUPABASE_PUBLISHABLE_KEY', 'SUPABASE_SECRET_KEY', 'STRIPE_RESTRICTED_KEY', 'STRIPE_LIVEMODE', 'STRIPE_ACCOUNT_ID', 'STRIPE_MONTHLY_PRICE_ID'];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  Object.assign(process.env, { SUPABASE_URL: BASE, SUPABASE_PUBLISHABLE_KEY: 'publishable-test', SUPABASE_SECRET_KEY: options.legacy ? 'legacy-service-key' : 'sb_secret_test' });
  let testStripe;
  let previousStripeHttpClient;
  if (options.stripeFetch) {
    Object.assign(process.env, {
      STRIPE_RESTRICTED_KEY: 'rk_test_account_deletion',
      STRIPE_LIVEMODE: 'false',
      STRIPE_ACCOUNT_ID: 'acct_baristamatch',
      STRIPE_MONTHLY_PRICE_ID: 'price_baristamatch'
    });
    testStripe = stripeApiClient();
    previousStripeHttpClient = testStripe.getApiField('httpClient');
    testStripe._setApiField('httpClient', testStripe.constructor.createFetchHttpClient(options.stripeFetch));
  } else {
    delete process.env.STRIPE_RESTRICTED_KEY;
    delete process.env.STRIPE_LIVEMODE;
  }
  t.after(() => {
    globalThis.fetch = oldFetch;
    if (testStripe) testStripe._setApiField('httpClient', previousStripeHttpClient);
    for (const key of keys) previous[key] === undefined ? delete process.env[key] : process.env[key] = previous[key];
  });
  const files = new Map(['coffee-videos', 'cafe-images'].map(bucket => [bucket, new Set(options.files?.[bucket] || [])]));
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(url);
    const path = parsed.pathname;
    const call = { url, path, search: parsed.search, method: init.method || 'GET', headers: init.headers, body: init.body ? JSON.parse(init.body) : null };
    calls.push(call);
    const override = options.override?.(call, calls);
    if (override !== undefined) return override;
    if (path === '/auth/v1/user') return response({ id: USER });
    if (path === '/rest/v1/rpc/claim_stripe_deletion') return response(options.deletionClaim || 'claimed');
    if (path === '/rest/v1/rpc/settle_stripe_checkout_attempt_for_deletion') return response(true);
    if (path === '/rest/v1/rpc/release_stripe_checkout') return response(true);
    if (path === '/rest/v1/cafe_subscriptions') return response(options.subscriptions || []);
    if (path === '/rest/v1/profiles') {
      if (call.method === 'PATCH') {
        if (call.search.includes('suspended_at=is.null')) {
          return response(options.locked === false ? [] : [{ id: USER }]);
        }
        return response([]);
      }
      return response(options.profiles || []);
    }
    if (path.startsWith('/storage/v1/object/list/')) {
      const bucket = path.split('/').at(-1);
      const { prefix, offset, limit } = call.body;
      const entries = new Map();
      for (const file of files.get(bucket)) {
        if (!file.startsWith(prefix)) continue;
        const remainder = file.slice(prefix.length);
        const folder = remainder.includes('/');
        const name = remainder.split('/')[0];
        entries.set(name, { name, id: folder ? null : `object-${name}`, metadata: folder ? null : {} });
      }
      return response([...entries.values()].sort((a, b) => a.name.localeCompare(b.name)).slice(offset, offset + limit));
    }
    if (path.startsWith('/storage/v1/object/') && call.method === 'DELETE') {
      const bucket = path.split('/').at(-1);
      for (const file of call.body.prefixes) {
        assert.ok(file.startsWith(`${USER}/`), 'must not delete another member file');
        if (!options.leaveFiles) files.get(bucket).delete(file);
      }
      return response([]);
    }
    if (path === `/auth/v1/admin/users/${USER}` && call.method === 'DELETE') return response({ id: USER });
    throw new Error(`Unexpected test request: ${path}`);
  };
  const res = {
    statusCode: 200, headers: {}, body: null,
    setHeader(name, value) { this.headers[name] = value; },
    status(value) { this.statusCode = value; return this; },
    json(value) { this.body = value; return this; }
  };
  return {
    calls, files, res,
    run: (overrides = {}) => handler({ method: 'POST', headers: { authorization: 'Bearer valid-session' }, body: { confirmation: 'DELETE' }, ...overrides }, res),
    identityDeleted: () => calls.some(call => call.path.startsWith('/auth/v1/admin/users/') && call.method === 'DELETE')
  };
}

test('profile files: includes all owned media and deduplicates references', () => {
  const image = `${BASE}/storage/v1/object/public/cafe-images/${USER}/avatar.jpg`;
  assert.deepEqual(storedObjectsForProfile({ avatar_url: image, bar_picture_url: image, video_path: `${USER}/video.mp4` }, USER, BASE), [
    ['coffee-videos', `${USER}/video.mp4`], ['cafe-images', `${USER}/avatar.jpg`]
  ]);
});
test('profile files: rejects another member, external origins and traversal', () => {
  assert.deepEqual(storedObjectsForProfile({ video_path: `${OTHER}/x.mp4`, avatar_url: `${BASE}/storage/v1/object/public/cafe-images/${USER}/%2e%2e/x.jpg`, bar_picture_url: `https://evil.example/storage/v1/object/public/cafe-images/${USER}/x.jpg` }, USER, BASE), []);
});
test('Stripe deletion expires every open Checkout Session before deleting the owned customer', async () => {
  const events = [];
  const listCalls = [];
  const stripe = {
    customers: {
      retrieve: async id => { events.push(`retrieve:${id}`); return { id, metadata: { cafe_user_id: USER } }; },
      del: async id => { events.push(`delete:${id}`); return { id, deleted: true }; }
    },
    checkout: { sessions: {
      list: async options => {
        listCalls.push(options);
        if (!options.starting_after) return { data: [{ id: 'cs_first' }, { id: 'cs_second' }], has_more: true };
        return { data: [{ id: 'cs_raced' }], has_more: false };
      },
      expire: async id => {
        events.push(`expire:${id}`);
        if (id === 'cs_raced') throw new Error('Session already completed');
        return { id, status: 'expired' };
      }
    } },
    subscriptions: {
      retrieve: async () => assert.fail('the customer is the authoritative cleanup target'),
      cancel: async () => assert.fail('deleting the customer ends its subscriptions')
    }
  };

  await endStripeBillingForDeletion(stripe, { stripe_customer_id: 'cus_owner', stripe_subscription_id: 'sub_stale' }, USER);

  assert.deepEqual(listCalls, [
    { customer: 'cus_owner', status: 'open', limit: 100 },
    { customer: 'cus_owner', status: 'open', limit: 100, starting_after: 'cs_second' }
  ]);
  assert.deepEqual(events.filter(event => event.startsWith('expire:')).sort(), ['expire:cs_first', 'expire:cs_raced', 'expire:cs_second']);
  assert.equal(events[0], 'retrieve:cus_owner');
  assert.equal(events.at(-1), 'delete:cus_owner');
});
test('Stripe deletion is idempotent for an already deleted customer', async () => {
  let downstreamCalls = 0;
  const stripe = {
    customers: {
      retrieve: async id => ({ id, deleted: true }),
      del: async () => { downstreamCalls += 1; }
    },
    checkout: { sessions: {
      list: async () => { downstreamCalls += 1; },
      expire: async () => { downstreamCalls += 1; }
    } }
  };
  await endStripeBillingForDeletion(stripe, { stripe_customer_id: 'cus_deleted' }, USER);
  assert.equal(downstreamCalls, 0);
});
test('Stripe deletion refuses customer ownership mismatches and invalid deletion acknowledgements', async () => {
  let mutations = 0;
  const wrongOwner = {
    customers: {
      retrieve: async id => ({ id, metadata: { cafe_user_id: OTHER } }),
      del: async () => { mutations += 1; }
    },
    checkout: { sessions: {
      list: async () => { mutations += 1; return { data: [], has_more: false }; },
      expire: async () => { mutations += 1; }
    } }
  };
  await assert.rejects(endStripeBillingForDeletion(wrongOwner, { stripe_customer_id: 'cus_other' }, USER), /safely remove/);
  assert.equal(mutations, 0);

  const badAcknowledgement = {
    customers: {
      retrieve: async id => ({ id, metadata: { cafe_user_id: USER } }),
      del: async () => ({ id: 'cus_different', deleted: true })
    },
    checkout: { sessions: { list: async () => ({ data: [], has_more: false }), expire: async () => {} } }
  };
  await assert.rejects(endStripeBillingForDeletion(badAcknowledgement, { stripe_customer_id: 'cus_owner' }, USER), /safely remove/);
});
test('Stripe Checkout Session enumeration fails closed at its pagination bound', async () => {
  const listCalls = [];
  let mutations = 0;
  const stripe = {
    customers: {
      retrieve: async id => ({ id, metadata: { cafe_user_id: USER } }),
      del: async () => { mutations += 1; }
    },
    checkout: { sessions: {
      list: async options => {
        listCalls.push(options);
        return { data: [{ id: `cs_${listCalls.length}` }], has_more: true };
      },
      expire: async () => { mutations += 1; }
    } }
  };
  await assert.rejects(endStripeBillingForDeletion(stripe, { stripe_customer_id: 'cus_owner' }, USER), /safely remove/);
  assert.equal(listCalls.length, 10);
  assert.equal(listCalls.at(-1).starting_after, 'cs_9');
  assert.equal(mutations, 0);
});
test('legacy Stripe rows delete the subscription Customer when no customer ID is stored', async () => {
  const calls = [];
  const stripe = {
    subscriptions: {
      retrieve: async id => { calls.push(['retrieve-subscription', id]); return { id, customer: 'cus_legacy', status: 'active', metadata: { cafe_user_id: USER } }; }
    },
    customers: {
      retrieve: async id => { calls.push(['retrieve-customer', id]); return { id, metadata: { cafe_user_id: USER } }; },
      del: async id => { calls.push(['delete-customer', id]); return { id, deleted: true }; }
    },
    checkout: { sessions: {
      list: async options => { calls.push(['list-sessions', options.customer]); return { data: [], has_more: false }; },
      expire: async () => assert.fail('there are no open Sessions')
    } }
  };
  await endStripeBillingForDeletion(stripe, { stripe_subscription_id: 'sub_legacy' }, USER);
  assert.deepEqual(calls, [
    ['retrieve-subscription', 'sub_legacy'],
    ['retrieve-customer', 'cus_legacy'],
    ['list-sessions', 'cus_legacy'],
    ['delete-customer', 'cus_legacy']
  ]);
});
test('legacy Stripe cleanup deletes an ended subscription Customer and rejects foreign ownership', async () => {
  let deletions = 0;
  const ended = {
    subscriptions: { retrieve: async id => ({ id, customer: 'cus_ended', status: 'canceled', metadata: { cafe_user_id: USER } }) },
    customers: {
      retrieve: async id => ({ id, metadata: { cafe_user_id: USER } }),
      del: async id => { deletions += 1; return { id, deleted: true }; }
    },
    checkout: { sessions: { list: async () => ({ data: [], has_more: false }), expire: async () => {} } }
  };
  await endStripeBillingForDeletion(ended, { stripe_subscription_id: 'sub_ended' }, USER);
  assert.equal(deletions, 1);

  const foreign = { subscriptions: {
    retrieve: async id => ({ id, customer: 'cus_foreign', status: 'active', metadata: { cafe_user_id: OTHER } })
  } };
  await assert.rejects(endStripeBillingForDeletion(foreign, { stripe_subscription_id: 'sub_foreign' }, USER), /safely remove/);
  assert.equal(deletions, 1);
});
test('an unfinished Checkout attempt discovers and deletes an ambiguously attached Customer', async () => {
  const deleted = [];
  const searches = [];
  const lists = [];
  const timeline = [];
  const stripe = {
    customers: {
      search: async options => {
        searches.push(options);
        return { data: [
          { id: 'cus_orphan', metadata: { cafe_user_id: USER } },
          { id: 'cus_foreign', metadata: { cafe_user_id: OTHER } }
        ], has_more: false };
      },
      list: async options => { lists.push(options); return { data: [], has_more: false }; },
      retrieve: async id => { timeline.push(`retrieve:${id}`); return { id, metadata: { cafe_user_id: USER } }; },
      del: async id => { timeline.push(`delete:${id}`); deleted.push(id); return { id, deleted: true }; }
    },
    checkout: { sessions: { list: async () => ({ data: [], has_more: false }), expire: async () => {} } }
  };

  await endStripeBillingForDeletion(
    stripe,
    { stripe_checkout_attempt_id: '33333333-3333-4333-8333-333333333333' },
    USER,
    'owner@example.com',
    false,
    async () => { timeline.push('settle-attempt'); }
  );

  assert.deepEqual(searches, [{ query: `metadata['cafe_user_id']:'${USER}'`, limit: 100 }]);
  assert.deepEqual(lists, [{ email: 'owner@example.com', limit: 100 }]);
  assert.deepEqual(deleted, ['cus_orphan']);
  assert.deepEqual(timeline, ['settle-attempt', 'retrieve:cus_orphan', 'delete:cus_orphan']);
});
test('an unresolved Checkout attempt cannot silently leave Stripe customer data behind', async () => {
  const stripe = { customers: {
    search: async () => ({ data: [], has_more: false }),
    list: async () => ({ data: [], has_more: false })
  } };
  await assert.rejects(
    endStripeBillingForDeletion(stripe, { stripe_checkout_attempt_id: '33333333-3333-4333-8333-333333333333' }, USER, 'owner@example.com'),
    /safely remove/
  );
});
test('rejects GET without making requests', async t => {
  const mock = setup(t); await mock.run({ method: 'GET' });
  assert.equal(mock.res.statusCode, 405); assert.equal(mock.calls.length, 0);
  assert.equal(mock.res.headers.Allow, 'POST');
});
test('missing server configuration fails closed', async t => {
  const mock = setup(t); delete process.env.SUPABASE_SECRET_KEY; await mock.run();
  assert.equal(mock.res.statusCode, 503); assert.equal(mock.calls.length, 0);
});
test('requires explicit deletion confirmation', async t => {
  const mock = setup(t); await mock.run({ body: { confirmation: 'yes' } });
  assert.equal(mock.res.statusCode, 400); assert.equal(mock.calls.length, 0);
});
test('requires authentication', async t => {
  const mock = setup(t); await mock.run({ headers: {} });
  assert.equal(mock.res.statusCode, 401); assert.equal(mock.calls.length, 0);
});
test('rejects an expired session', async t => {
  const mock = setup(t, { override: c => c.path === '/auth/v1/user' ? response({}, 401) : undefined });
  await mock.run(); assert.equal(mock.res.statusCode, 401); assert.equal(mock.identityDeleted(), false);
});
test('does not misreport an auth service outage as bad credentials', async t => {
  const mock = setup(t, { override: c => c.path === '/auth/v1/user' ? response({}, 503) : undefined });
  await mock.run(); assert.equal(mock.res.statusCode, 502); assert.equal(mock.identityDeleted(), false);
});
test('does not trust malformed authenticated user IDs', async t => {
  const mock = setup(t, { override: c => c.path === '/auth/v1/user' ? response({ id: '../other-user' }) : undefined });
  await mock.run(); assert.equal(mock.res.statusCode, 502); assert.equal(mock.identityDeleted(), false);
});
test('profile lookup failure cannot delete the identity', async t => {
  const mock = setup(t, { override: c => c.path === '/rest/v1/profiles' ? response({}, 503) : undefined });
  await mock.run(); assert.equal(mock.res.statusCode, 502); assert.equal(mock.identityDeleted(), false);
  assert.equal(mock.calls.some(c => c.method === 'DELETE'), false);
});
test('a matching-mode key from the wrong Stripe account cannot delete the local identity', async t => {
  const stripeRequests = [];
  const mock = setup(t, {
    profiles: [{ role: 'cafe_owner_manager', suspended_at: null, is_discoverable: true }],
    subscriptions: [{ stripe_customer_id: 'cus_real_account', stripe_subscription_id: 'sub_real_account' }],
    stripeFetch: async (url, init) => {
      const call = { path: new URL(url).pathname, method: init.method };
      stripeRequests.push(call);
      return response({ error: { type: 'invalid_request_error' } }, 404);
    }
  });

  await mock.run();

  assert.equal(mock.res.statusCode, 502);
  assert.equal(mock.identityDeleted(), false);
  assert.deepEqual(stripeRequests, [{ path: '/v1/prices/price_baristamatch', method: 'GET' }]);
  assert.equal(mock.calls.some(call => call.path.startsWith('/storage/v1/object/list/')), false);
  const restore = mock.calls.find(call => call.path === '/rest/v1/profiles' && call.method === 'PATCH' && call.search.includes('suspended_at=eq.'));
  assert.deepEqual(restore.body, { suspended_at: null, is_discoverable: true });
});
test('cafe deletion claims suspended_at, rereads billing, and ends Stripe before deleting the identity', async t => {
  const stripeRequests = [];
  const timeline = [];
  const stripeFetch = async (url, init) => {
    const parsed = new URL(url);
    const call = { path: parsed.pathname, search: parsed.search, method: init.method };
    stripeRequests.push(call);
    timeline.push(`stripe:${call.method}:${call.path}`);
    if (call.path === '/v1/prices/price_baristamatch' && call.method === 'GET') {
      return response({
        id: 'price_baristamatch', object: 'price', livemode: false, currency: 'usd', unit_amount: 999,
        type: 'recurring', recurring: { interval: 'month', interval_count: 1 },
        metadata: { application: 'baristamatch', plan: 'cafe_monthly', stripe_account_id: 'acct_baristamatch' }
      });
    }
    if (call.path === '/v1/customers/cus_current' && call.method === 'GET') {
      return response({ id: 'cus_current', object: 'customer', metadata: { cafe_user_id: USER } });
    }
    if (call.path === '/v1/customers/search' && call.method === 'GET') {
      return response({ object: 'search_result', data: [{ id: 'cus_current', metadata: { cafe_user_id: USER } }], has_more: false, url: '/v1/customers/search' });
    }
    if (call.path === '/v1/checkout/sessions' && call.method === 'GET') {
      return response({ object: 'list', data: [{ id: 'cs_open', object: 'checkout.session' }], has_more: false, url: '/v1/checkout/sessions' });
    }
    if (call.path === '/v1/checkout/sessions/cs_open/expire' && call.method === 'POST') {
      return response({ id: 'cs_open', object: 'checkout.session', status: 'expired' });
    }
    if (call.path === '/v1/customers/cus_current' && call.method === 'DELETE') {
      return response({ id: 'cus_current', object: 'customer', deleted: true });
    }
    throw new Error(`Unexpected Stripe request: ${call.method} ${call.path}`);
  };
  const mock = setup(t, {
    profiles: [{ role: 'cafe_owner_manager', suspended_at: null }],
    subscriptions: [{ stripe_customer_id: 'cus_current', stripe_subscription_id: 'sub_current', stripe_checkout_attempt_id: '33333333-3333-4333-8333-333333333333', status: 'active', cancel_at_period_end: false }],
    stripeFetch,
    override: call => { timeline.push(`supabase:${call.method}:${call.path}`); }
  });
  await mock.run();
  assert.equal(mock.res.statusCode, 200);
  assert.equal(mock.identityDeleted(), true);

  const profileReadIndex = mock.calls.findIndex(call => call.path === '/rest/v1/profiles' && call.method === 'GET');
  const deletionClaimIndex = mock.calls.findIndex(call => call.path === '/rest/v1/rpc/claim_stripe_deletion');
  const lockIndex = mock.calls.findIndex(call => call.path === '/rest/v1/profiles' && call.method === 'PATCH' && call.search.includes('suspended_at=is.null'));
  const billingReadIndex = mock.calls.findIndex(call => call.path === '/rest/v1/cafe_subscriptions');
  assert.ok(profileReadIndex >= 0 && profileReadIndex < deletionClaimIndex && deletionClaimIndex < lockIndex && lockIndex < billingReadIndex);
  const lock = mock.calls[lockIndex];
  assert.equal(lock.headers.Prefer, 'return=representation');
  assert.equal(Number.isNaN(Date.parse(lock.body.suspended_at)), false);
  const billingQuery = new URLSearchParams(mock.calls[billingReadIndex].search);
  assert.equal(billingQuery.get('user_id'), `eq.${USER}`);
  assert.equal(billingQuery.get('select'), 'stripe_customer_id,stripe_subscription_id,stripe_checkout_attempt_id,status,cancel_at_period_end');
  assert.equal(mock.calls.filter(call => call.path === '/rest/v1/profiles' && call.method === 'PATCH').length, 1);
  const settlementIndex = mock.calls.findIndex(call => call.path === '/rest/v1/rpc/settle_stripe_checkout_attempt_for_deletion');
  assert.ok(settlementIndex > billingReadIndex);
  assert.equal(mock.calls[settlementIndex].body.p_user_id, USER);
  assert.equal(mock.calls[settlementIndex].body.p_claim_id, mock.calls[deletionClaimIndex].body.p_claim_id);

  assert.deepEqual(stripeRequests.map(call => `${call.method} ${call.path}`), [
    'GET /v1/prices/price_baristamatch',
    'GET /v1/customers/search',
    'GET /v1/customers/cus_current',
    'GET /v1/checkout/sessions',
    'POST /v1/checkout/sessions/cs_open/expire',
    'DELETE /v1/customers/cus_current'
  ]);
  const sessionQuery = new URLSearchParams(stripeRequests[3].search);
  assert.equal(sessionQuery.get('customer'), 'cus_current');
  assert.equal(sessionQuery.get('status'), 'open');
  assert.equal(sessionQuery.get('limit'), '100');
  assert.ok(timeline.indexOf('supabase:PATCH:/rest/v1/profiles') < timeline.indexOf('supabase:GET:/rest/v1/cafe_subscriptions'));
  assert.ok(timeline.indexOf('supabase:GET:/rest/v1/cafe_subscriptions') < timeline.indexOf('stripe:GET:/v1/customers/cus_current'));
  assert.ok(timeline.indexOf('supabase:POST:/rest/v1/rpc/settle_stripe_checkout_attempt_for_deletion') < timeline.indexOf('stripe:GET:/v1/customers/cus_current'));
  assert.ok(timeline.indexOf('stripe:DELETE:/v1/customers/cus_current') < timeline.indexOf('supabase:POST:/storage/v1/object/list/coffee-videos'));
});
test('a failed Checkout-attempt settlement stops before mutating Stripe or deleting identity data', async t => {
  const stripeRequests = [];
  const mock = setup(t, {
    profiles: [{ role: 'cafe_owner_manager', suspended_at: null }],
    subscriptions: [{ stripe_customer_id: 'cus_current', stripe_checkout_attempt_id: '33333333-3333-4333-8333-333333333333' }],
    stripeFetch: async (url, init) => {
      const path = new URL(url).pathname;
      stripeRequests.push(`${init.method} ${path}`);
      if (path === '/v1/prices/price_baristamatch') return response({
        id: 'price_baristamatch', object: 'price', livemode: false, currency: 'usd', unit_amount: 999,
        type: 'recurring', recurring: { interval: 'month', interval_count: 1 },
        metadata: { application: 'baristamatch', plan: 'cafe_monthly', stripe_account_id: 'acct_baristamatch' }
      });
      if (path === '/v1/customers/search') return response({ object: 'search_result', data: [{ id: 'cus_current', metadata: { cafe_user_id: USER } }], has_more: false });
      throw new Error(`Unexpected Stripe request: ${init.method} ${path}`);
    },
    override: call => call.path === '/rest/v1/rpc/settle_stripe_checkout_attempt_for_deletion' ? response(false) : undefined
  });

  await mock.run();

  assert.equal(mock.res.statusCode, 502);
  assert.equal(mock.identityDeleted(), false);
  assert.equal(stripeRequests.at(-1), 'GET /v1/customers/search');
  assert.equal(stripeRequests.every(call => call === 'GET /v1/prices/price_baristamatch' || call === 'GET /v1/customers/search'), true);
  assert.equal(mock.calls.some(call => call.path.startsWith('/storage/v1/object/list/')), false);
});
test('the suspended_at deletion lock is scoped to cafe accounts', async t => {
  const mock = setup(t, { profiles: [{ role: 'barista', suspended_at: null }] });
  await mock.run();
  assert.equal(mock.res.statusCode, 200);
  assert.equal(mock.identityDeleted(), true);
  assert.equal(mock.calls.some(call => call.path === '/rest/v1/profiles' && call.method === 'PATCH'), false);
});
test('a lost cafe deletion claim stops before billing, storage, or identity deletion', async t => {
  const mock = setup(t, { profiles: [{ role: 'cafe_owner_manager', suspended_at: null }], locked: false });
  await mock.run();
  assert.equal(mock.res.statusCode, 502);
  assert.equal(mock.identityDeleted(), false);
  assert.equal(mock.calls.some(call => call.path === '/rest/v1/cafe_subscriptions'), false);
  assert.equal(mock.calls.some(call => call.path.startsWith('/storage/v1/object/list/')), false);
});
test('a pre-Stripe failure restores only the deletion lock this request acquired', async t => {
  const mock = setup(t, {
    profiles: [{ role: 'cafe_owner_manager', suspended_at: null }],
    override: call => call.path === '/rest/v1/cafe_subscriptions' ? response({}, 503) : undefined
  });
  await mock.run();
  assert.equal(mock.res.statusCode, 502);
  assert.equal(mock.identityDeleted(), false);

  const patches = mock.calls.filter(call => call.path === '/rest/v1/profiles' && call.method === 'PATCH');
  assert.equal(patches.length, 2);
  assert.equal(patches[0].search.includes('suspended_at=is.null'), true);
  assert.deepEqual(patches[1].body, { suspended_at: null, is_discoverable: false });
  assert.equal(new URLSearchParams(patches[1].search).get('suspended_at'), `eq.${patches[0].body.suspended_at}`);
  const restoreIndex = mock.calls.indexOf(patches[1]);
  const releaseIndex = mock.calls.findIndex(call => call.path === '/rest/v1/rpc/release_stripe_checkout');
  assert.ok(restoreIndex >= 0 && restoreIndex < releaseIndex);
});
test('an active Checkout claim blocks deletion before billing is read or visibility changes', async t => {
  const mock = setup(t, {
    profiles: [{ role: 'cafe_owner_manager', suspended_at: null, is_discoverable: true }],
    deletionClaim: 'busy'
  });
  await mock.run();
  assert.equal(mock.res.statusCode, 409);
  assert.equal(mock.identityDeleted(), false);
  assert.equal(mock.calls.some(call => call.path === '/rest/v1/cafe_subscriptions'), false);
  assert.equal(mock.calls.some(call => call.path === '/rest/v1/profiles' && call.method === 'PATCH'), false);
});
test('a losing concurrent deletion never clears the active deletion owner lock', async t => {
  const mock = setup(t, {
    profiles: [{ role: 'cafe_owner_manager', suspended_at: '2026-09-08T12:00:00.000Z', is_discoverable: false }],
    deletionClaim: 'busy'
  });
  await mock.run();
  assert.equal(mock.res.statusCode, 409);
  assert.equal(mock.identityDeleted(), false);
  assert.equal(mock.calls.some(call => call.path === '/rest/v1/cafe_subscriptions'), false);
  assert.equal(mock.calls.some(call => call.path === '/rest/v1/profiles' && call.method === 'PATCH'), false);
});
test('malformed profile response fails closed', async t => {
  const mock = setup(t, { override: c => c.path === '/rest/v1/profiles' ? response({ error: 'not an array' }) : undefined });
  await mock.run(); assert.equal(mock.res.statusCode, 502); assert.equal(mock.identityDeleted(), false);
});
test('a genuinely missing profile still permits deletion of the authenticated account', async t => {
  const mock = setup(t); await mock.run();
  assert.equal(mock.res.statusCode, 200); assert.equal(mock.identityDeleted(), true);
});
test('storage inventory failure makes no destructive calls', async t => {
  const mock = setup(t, { override: c => c.path.endsWith('/list/cafe-images') ? response({}, 503) : undefined });
  await mock.run(); assert.equal(mock.res.statusCode, 502); assert.equal(mock.calls.some(c => c.method === 'DELETE'), false);
});
for (const name of ['../other.jpg', '.', '..', 'nested/file.jpg', 'folder\\file.jpg', '\u0000bad']) {
  test(`rejects unsafe storage row ${JSON.stringify(name)}`, async t => {
    const mock = setup(t, { override: c => c.path.includes('/object/list/') ? response([{ id: 'file', name, metadata: {} }]) : undefined });
    await mock.run(); assert.equal(mock.res.statusCode, 502); assert.equal(mock.identityDeleted(), false);
  });
}
test('cleans superseded uploads, nested folders and every page; preserves other users', async t => {
  const images = Array.from({ length: 105 }, (_, i) => `${USER}/image-${String(i).padStart(3, '0')}.jpg`);
  const mock = setup(t, { files: { 'cafe-images': [...images, `${USER}/nested/old.jpg`, `${OTHER}/keep.jpg`], 'coffee-videos': [`${USER}/old-video.mp4`] } });
  await mock.run({ body: { confirmation: 'DELETE', user_id: OTHER } });
  assert.equal(mock.res.statusCode, 200);
  assert.deepEqual([...mock.files.get('cafe-images')], [`${OTHER}/keep.jpg`]);
  assert.equal(mock.files.get('coffee-videos').size, 0);
  assert.ok(mock.calls.some(c => c.body?.offset === 100));
  assert.ok(mock.calls.some(c => c.body?.prefix === `${USER}/nested/`));
  assert.equal(mock.calls.at(-1).path, `/auth/v1/admin/users/${USER}`);
  assert.ok(mock.calls.filter(c => c.method === 'DELETE' && c.body).every(c => c.body.prefixes.length <= 100));
});
test('modern secret keys are not sent as JWT Authorization headers', async t => {
  const mock = setup(t); await mock.run();
  assert.equal(mock.calls.find(c => c.path === '/rest/v1/profiles').headers.Authorization, undefined);
  assert.equal(mock.calls[0].headers.Authorization, 'Bearer valid-session');
});
test('legacy server keys retain their required Authorization header', async t => {
  const mock = setup(t, { legacy: true }); await mock.run();
  assert.equal(mock.calls.find(c => c.path === '/rest/v1/profiles').headers.Authorization, 'Bearer legacy-service-key');
});
test('storage deletion error cannot delete identity', async t => {
  const mock = setup(t, { files: { 'cafe-images': [`${USER}/x.jpg`] }, override: c => c.method === 'DELETE' ? response({}, 503) : undefined });
  await mock.run(); assert.equal(mock.res.statusCode, 502); assert.equal(mock.identityDeleted(), false);
});
test('cleanup must be verified before deleting identity', async t => {
  const mock = setup(t, { files: { 'cafe-images': [`${USER}/x.jpg`] }, leaveFiles: true });
  await mock.run(); assert.equal(mock.res.statusCode, 502); assert.equal(mock.identityDeleted(), false);
});
test('identity deletion failure does not report success', async t => {
  const mock = setup(t, { override: c => c.path.includes('/admin/users/') ? response({}, 503) : undefined });
  await mock.run(); assert.equal(mock.res.statusCode, 502); assert.equal(mock.res.body.success, undefined);
});
test('timeouts report a retryable error without leaking credentials', async t => {
  const mock = setup(t, { override: () => { throw new DOMException('private upstream details', 'TimeoutError'); } });
  await mock.run(); assert.equal(mock.res.statusCode, 504); assert.equal(mock.identityDeleted(), false);
  assert.doesNotMatch(JSON.stringify(mock.res.body), /private upstream|sb_secret|valid-session/);
});
