import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const require = createRequire(new URL('../mobile/package.json', import.meta.url));
const ts = require('typescript');
const plain = value => JSON.parse(JSON.stringify(value));
const signupUrl = 'baristamatch://auth/callback#access_token=secret&refresh_token=secret&type=signup';
function load(client, warnings = []) {
  const cache = new Map();
  function compile(name) {
    if (cache.has(name)) return cache.get(name);
    const exports = {};
    cache.set(name, exports);
    const source = ts.transpileModule(readFileSync(new URL(`../mobile/lib/${name}.ts`, import.meta.url), 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    vm.runInNewContext(source, { exports, URLSearchParams, console: { warn: (...args) => warnings.push(plain(args)) },
      require: name => name === './supabase' ? { supabase: client } : compile(name.slice(2)),
    });
    return exports;
  }
  return { ...compile('productEvents'), ...compile('authCallback') };
}
function backend({ user = { id: 'synthetic-user' }, authError = null, insert = async () => ({ error: null }) } = {}) {
  const writes = [], warnings = [];
  const client = {
    auth: { getUser: async () => ({ data: { user }, error: authError }) },
    from: table => ({ insert: async row => { writes.push({ table, row: plain(row) }); return insert(row); } }),
  };
  return { client, writes, warnings, ...load(client, warnings) };
}

test('all six activation events send an insert-only payload with no new identifiers or free text', async () => {
  const b = backend();
  for (const event of ['signup_completed', 'post_job_started', 'job_posted', 'job_viewed', 'apply_started', 'application_submitted']) {
    assert.equal(await b.trackProductEvent(event, { surface: 'private@example.invalid', role: 'barista', email: 'private@example.invalid', name: 'Private Person', location: 'private address', nested: { token: 'secret' } }), 'recorded');
    assert.deepEqual(b.writes.at(-1), { table: 'product_events', row: { user_id: 'synthetic-user', event_name: event, metadata: { surface: 'mobile', role: 'barista' } } });
  }
  await b.trackProductEvent('job_viewed', { role: 'private@example.invalid' });
  assert.deepEqual(b.writes.at(-1).row.metadata, { surface: 'mobile' });
  assert.equal(b.warnings.length, 0);
});

test('unauthenticated, invalid, and changed-account events never write', async () => {
  for (const options of [{ user: null }, { user: { id: 'other-account' } }]) {
    const b = backend(options);
    assert.equal(await b.trackProductEvent('signup_completed', {}, 'expected-account'), 'skipped');
    assert.equal(b.writes.length, 0);
  }
  const b = backend();
  assert.equal(await b.trackProductEvent('private@example.invalid'), 'skipped');
  assert.equal(b.writes.length, 0);
  assert.equal(b.warnings.length, 0);
});

test('returned Supabase failures are observed with fixed diagnostics and never reject', async () => {
  for (const [code, reason] of [['PGRST204', 'schema_mismatch'], ['42703', 'schema_mismatch'], ['42501', 'permission_denied'], ['23505', 'insert_failed'], ['private@example.invalid', 'insert_failed']]) {
    const b = backend({ insert: async () => ({ error: { code, message: 'private@example.invalid', details: 'secret token', hint: 'private address' } }) });
    assert.equal(await b.trackProductEvent('signup_completed'), 'failed');
    assert.deepEqual(b.warnings, [['[product_events]', { event: 'signup_completed', reason }]]);
  }
  const b = backend({ authError: { message: 'secret' } });
  assert.equal(await b.trackProductEvent('job_viewed'), 'failed');
  assert.equal(b.writes.length, 0);
  assert.deepEqual(b.warnings, [['[product_events]', { event: 'job_viewed', reason: 'auth_unavailable' }]]);
});

test('network and synchronous client failures are contained, and a subsequent attempt can succeed', async () => {
  const b = backend({ insert: async () => { throw new Error('private@example.invalid'); } });
  assert.equal(await b.trackProductEvent('job_posted'), 'failed');
  b.client.auth.getUser = () => { throw new Error('secret'); };
  assert.equal(await b.trackProductEvent('job_posted'), 'failed');
  assert.equal(JSON.stringify(b.warnings).includes('secret'), false);
  const retry = backend({ insert: async () => retry.writes.length === 1 ? { error: { code: '503' } } : { error: null } });
  assert.equal(await retry.trackProductEvent('signup_completed'), 'failed');
  assert.equal(await retry.trackProductEvent('signup_completed'), 'recorded');
});

test('only the signup uniqueness conflict is treated as an already-recorded completion', async () => {
  const b = backend({ insert: async () => ({ error: { code: '23505', message: 'duplicate key value violates unique constraint "product_events_signup_completed_user_idx"' } }) });
  assert.equal(await b.trackProductEvent('signup_completed'), 'duplicate');
  assert.equal(b.warnings.length, 0);
  assert.equal(await b.trackProductEvent('job_viewed'), 'failed');
});

test('confirmed signup tracking accepts both roles and rejects login, recovery, OAuth, missing roles and unconfirmed users', async () => {
  const b = backend();
  const user = { id: 'synthetic-user', email_confirmed_at: '2026-09-28T00:00:00Z', email: 'private@example.invalid' };
  for (const role of ['barista', 'cafe_owner_manager']) assert.equal(await b.trackConfirmedEmailSignup(signupUrl, user, role), 'recorded');
  assert.equal(b.writes.length, 2);
  for (const type of ['', 'recovery', 'magiclink', 'invite', 'email_change']) {
    assert.equal(await b.trackConfirmedEmailSignup(signupUrl.replace('type=signup', `type=${type}`), user, 'barista'), 'skipped');
  }
  assert.equal(await b.trackConfirmedEmailSignup(signupUrl, { id: user.id }, 'barista'), 'skipped');
  assert.equal(await b.trackConfirmedEmailSignup(signupUrl, user, null), 'skipped');
  assert.equal(await b.trackConfirmedEmailSignup(signupUrl, user, 'administrator'), 'skipped');
  assert.equal(await b.trackConfirmedEmailSignup(signupUrl.replace('auth/callback', 'auth/callback.evil'), user, 'barista'), 'skipped');
  assert.equal(await b.trackConfirmedEmailSignup(`${signupUrl}&error=denied`, user, 'barista'), 'skipped');
  assert.equal(b.writes.length, 2);
});

test('Expo warm query and hash routes preserve confirmation type without relying on a local pending-signup flag', () => {
  const b = backend();
  for (const params of [{ '#': 'access_token=secret&refresh_token=secret&type=signup' }, { access_token: 'secret', refresh_token: 'secret', type: 'signup' }]) {
    assert.equal(b.isSignupConfirmationCallback(b.mobileCallbackUrlFromParams(params)), true);
  }
  assert.equal(b.isSignupConfirmationCallback(b.mobileCallbackUrlFromParams({ access_token: 'secret', refresh_token: 'secret', type: 'recovery' })), false);
});

test('the installed Supabase SDK sends a minimal-return INSERT and exposes PostgREST failures to the tracker', async () => {
  const { createClient } = require('@supabase/supabase-js');
  const requests = [], warnings = [];
  let rejectInsert = false;
  const client = createClient('https://synthetic.supabase.co', 'synthetic-key', {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    accessToken: async () => 'synthetic-session',
    global: { fetch: async (url, options) => {
      requests.push({ url: String(url), method: options.method, headers: new Headers(options.headers), body: JSON.parse(options.body) });
      return rejectInsert
        ? new Response(JSON.stringify({ code: 'PGRST204', message: 'private@example.invalid', details: 'secret', hint: null }), { status: 400, headers: { 'Content-Type': 'application/json' } })
        : new Response(null, { status: 201 });
    } },
  });
  // Authentication is isolated; the real PostgREST builder/fetch/parser executes.
  const tracker = load({ auth: { getUser: async () => ({ data: { user: { id: 'synthetic-user' } }, error: null }) }, from: client.from.bind(client) }, warnings);
  assert.equal(await tracker.trackProductEvent('job_viewed'), 'recorded');
  assert.equal(requests[0].url, 'https://synthetic.supabase.co/rest/v1/product_events');
  assert.equal(requests[0].method, 'POST');
  assert.equal(requests[0].headers.get('authorization'), 'Bearer synthetic-session');
  assert.doesNotMatch(requests[0].headers.get('prefer') || '', /return=representation/);
  assert.deepEqual(requests[0].body, { user_id: 'synthetic-user', event_name: 'job_viewed', metadata: { surface: 'mobile' } });
  rejectInsert = true;
  assert.equal(await tracker.trackProductEvent('job_viewed'), 'failed');
  assert.deepEqual(warnings, [['[product_events]', { event: 'job_viewed', reason: 'schema_mismatch' }]]);
});
