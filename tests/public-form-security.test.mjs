import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import support from '../api/support.js';
import waitlist from '../api/waitlist.js';
import { sendFormEmail } from '../api/_public-form-guard.js';

const IP = '192.0.2.10';
const EMAIL = 'person@example.invalid';
const SECRET = 'synthetic-server-secret-not-a-real-credential';
const supportBody = () => ({ name: 'Synthetic', email: EMAIL, issue_type: 'bug', subject: 'Cannot open a page', description: 'This is a synthetic support request.', website: '' });
const waitlistBody = () => ({ role: 'barista', email: EMAIL, city: 'Tampa, FL' });
const json = (body, status = 200) => Response.json(body, { status });

function harness(t) {
  const keys = ['SUPABASE_URL', 'SUPABASE_SECRET_KEY', 'RESEND_API_KEY', 'VERCEL'];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  const previousFetch = globalThis.fetch;
  const previousError = console.error;
  process.env.SUPABASE_URL = 'https://synthetic.invalid';
  process.env.SUPABASE_SECRET_KEY = SECRET;
  process.env.RESEND_API_KEY = 'synthetic-email-key';
  process.env.VERCEL = '1';
  const h = { calls: [], errors: [], override: null };
  console.error = (...args) => h.errors.push(args.join(' '));
  globalThis.fetch = async (url, options = {}) => {
    const parsed = new URL(url);
    const call = { url: String(url), path: parsed.pathname, query: parsed.searchParams, method: options.method || 'GET', headers: options.headers || {}, body: options.body ? JSON.parse(options.body) : null, serializedBody: options.body, signal: options.signal };
    h.calls.push(call);
    assert.ok(options.signal instanceof AbortSignal, 'Every external request must have a deadline');
    const overridden = await h.override?.(call);
    if (overridden) return overridden;
    if (call.path === '/rest/v1/rpc/consume_public_form_budget') return json({ allowed: true, retry_after_seconds: 0 });
    if (call.path === '/rest/v1/support_tickets' && call.method === 'POST') return new Response(null, { status: 201 });
    if (call.path === '/rest/v1/support_tickets') return json([{ ticket_id: 'BM-SYNTHETIC', status: 'new', subject: 'Synthetic lookup' }]);
    if (call.path === '/rest/v1/waitlist_signups' && call.method === 'GET') return json([]);
    if (call.path === '/rest/v1/waitlist_signups' && call.method === 'POST') return new Response(null, { status: 201 });
    if (parsed.origin === 'https://api.resend.com') return json({ id: 'synthetic-mail-id' });
    throw new Error(`Unexpected synthetic request: ${call.path}`);
  };
  t.after(() => {
    globalThis.fetch = previousFetch;
    console.error = previousError;
    for (const key of keys) previous[key] === undefined ? delete process.env[key] : process.env[key] = previous[key];
  });
  h.run = async (handler, body, options = {}) => {
    const res = { code: null, body: null, headers: {}, setHeader(name, value) { this.headers[name] = value; }, status(code) { this.code = code; return this; }, json(value) { this.body = value; return this; }, end() { return this; } };
    await handler({ method: options.method || 'POST', body, query: options.query, headers: options.headers || { 'x-vercel-forwarded-for': IP }, socket: options.socket }, res);
    return res;
  };
  h.sideEffects = () => h.calls.filter(call => (call.method === 'POST' && !call.path.includes('/rpc/')));
  return h;
}

test('allowed support submission consumes all durable budgets before saving and sends escaped, idempotent mail', async t => {
  const h = harness(t);
  const result = await h.run(support, { ...supportBody(), name: '<script>alert(1)</script>', subject: '<img src=x onerror=alert(1)>' });
  assert.equal(result.code, 200);
  assert.equal(result.body.confirmation_sent, true);
  assert.match(result.body.ticket_id, /^BM-\d{8}-[0-9A-F]{12}$/);
  assert.equal(h.calls[0].path, '/rest/v1/rpc/consume_public_form_budget');
  const budget = h.calls[0];
  assert.deepEqual(budget.body.p_buckets.map(({ max_requests, window_seconds }) => [max_requests, window_seconds]), [[10, 600], [40, 86400], [5, 3600]]);
  assert.equal(budget.headers.apikey, SECRET);
  for (const bucket of budget.body.p_buckets) assert.match(bucket.bucket_key, /^[a-f0-9]{64}$/);
  assert.equal(budget.serializedBody.includes(IP), false);
  assert.equal(budget.serializedBody.includes(EMAIL), false);
  const mails = h.calls.filter(call => call.url.startsWith('https://api.resend.com/'));
  assert.equal(mails.length, 2);
  assert.equal(new Set(mails.map(call => call.headers['Idempotency-Key'])).size, 2);
  for (const mail of mails) {
    assert.ok(mail.headers['Idempotency-Key'].endsWith(result.body.ticket_id));
    assert.equal(mail.body.html.includes('<script>'), false);
    assert.equal(mail.body.html.includes('<img src=x'), false);
  }
});

test('waitlist submissions use independent form budgets and return confirmed save even when email is disabled', async t => {
  const h = harness(t);
  delete process.env.RESEND_API_KEY;
  const result = await h.run(waitlist, waitlistBody());
  assert.equal(result.code, 200);
  assert.deepEqual(result.body, { success: true, saved: true, internalEmailSent: false, confirmationSent: false });
  assert.deepEqual(h.calls[0].body.p_buckets.map(({ max_requests, window_seconds }) => [max_requests, window_seconds]), [[20, 600], [100, 86400], [3, 3600]]);
  assert.equal(h.calls.filter(call => call.url.startsWith('https://api.resend.com/')).length, 0);
});

test('valid plus addressing and internationalized domains are normalized without discarding email data', async t => {
  const h = harness(t);
  const result = await h.run(waitlist, { ...waitlistBody(), email: '  Person+tag@BÜCHER.example  ' });
  assert.equal(result.code, 200);
  const insert = h.calls.find(call => call.path === '/rest/v1/waitlist_signups' && call.method === 'POST');
  assert.equal(insert.body.email, 'person+tag@xn--bcher-kva.example');
});

test('a denied durable budget returns Retry-After without any insert or mail', async t => {
  const h = harness(t);
  h.override = call => call.path.includes('/rpc/') ? json({ allowed: false, retry_after_seconds: 73 }) : null;
  for (const [handler, body] of [[support, supportBody()], [waitlist, waitlistBody()]]) {
    const result = await h.run(handler, body);
    assert.equal(result.code, 429);
    assert.equal(result.headers['Retry-After'], '73');
  }
  assert.equal(h.sideEffects().length, 0);
});

test('concurrent requests each use the atomic RPC outcome before causing side effects', async t => {
  const h = harness(t);
  let consumed = 0;
  h.override = call => {
    if (!call.path.includes('/rpc/')) return null;
    const allowed = consumed++ < 3;
    return json({ allowed, retry_after_seconds: allowed ? 0 : 3600 });
  };
  const results = await Promise.all(Array.from({ length: 12 }, () => h.run(support, supportBody())));
  assert.equal(results.filter(result => result.code === 200).length, 3);
  assert.equal(results.filter(result => result.code === 429).length, 9);
  assert.equal(h.calls.filter(call => call.path.includes('/rpc/')).length, 12);
  assert.equal(h.calls.filter(call => call.path === '/rest/v1/support_tickets').length, 3);
  assert.equal(h.calls.filter(call => call.url.startsWith('https://api.resend.com/')).length, 6);
});

test('unavailable or malformed budget responses fail closed before insert or mail', async t => {
  const h = harness(t);
  const failures = [() => json({}, 503), () => new Response('{not JSON'), () => json([]), () => json({ allowed: 'true', retry_after_seconds: 0 }), () => json({ allowed: true, retry_after_seconds: 30 }), () => json({ allowed: false, retry_after_seconds: 0 }), () => { throw new TypeError('synthetic provider rejection'); }];
  for (const failure of failures) {
    h.override = call => call.path.includes('/rpc/') ? failure() : null;
    const result = await h.run(support, supportBody());
    assert.equal(result.code, 503);
  }
  assert.equal(h.sideEffects().length, 0);
});

test('invalid form bodies, field types and sizes are rejected before any provider call', async t => {
  const h = harness(t);
  const circular = supportBody(); circular.extra = circular;
  for (const body of [null, [], 'invalid JSON body', circular, { ...supportBody(), email: ['person@example.invalid'] }, { ...supportBody(), name: { value: 'Synthetic' } }, { ...supportBody(), description: 'x'.repeat(5001) }]) {
    assert.equal((await h.run(support, body)).code, 400);
  }
  assert.equal((await h.run(support, { ...supportBody(), extra: 'x'.repeat(32768) })).code, 413);
  assert.equal((await h.run(waitlist, { ...waitlistBody(), extra: 'x'.repeat(8192) })).code, 413);
  assert.equal((await h.run(support, supportBody(), { headers: { 'content-length': '32769', 'x-vercel-forwarded-for': IP } })).code, 413);
  assert.equal(h.calls.length, 0);
});

test('malformed emails and invalid roles are rejected before any provider call', async t => {
  const h = harness(t);
  for (const email of ['no-at-sign', 'person@@example.com', 'a\r\nbcc:victim@example.com', '.start@example.com', 'two..dots@example.com', 'person@-example.com', 'person@example', 'person@example.com/path']) {
    assert.equal((await h.run(support, { ...supportBody(), email })).code, 400, email);
    assert.equal((await h.run(waitlist, { ...waitlistBody(), email })).code, 400, email);
  }
  assert.equal((await h.run(waitlist, { ...waitlistBody(), role: 'support_admin' })).code, 400);
  assert.equal(h.calls.length, 0);
});

test('honeypots return a generic success without budget, database or email side effects', async t => {
  const h = harness(t);
  for (const [handler, body] of [[support, supportBody()], [waitlist, waitlistBody()]]) {
    const result = await h.run(handler, { ...body, website: 'https://synthetic.invalid' });
    assert.equal(result.code, 200);
    assert.deepEqual(result.body, { success: true });
  }
  assert.equal(h.calls.length, 0);
});

test('a client cannot choose a new bucket by spoofing ordinary forwarded IP headers', async t => {
  const h = harness(t);
  await h.run(waitlist, waitlistBody(), { headers: { 'x-vercel-forwarded-for': IP, 'x-forwarded-for': '203.0.113.1', 'x-real-ip': '203.0.113.2' } });
  await h.run(waitlist, waitlistBody(), { headers: { 'x-vercel-forwarded-for': IP, 'x-forwarded-for': '203.0.113.99' } });
  const calls = h.calls.filter(call => call.path.includes('/rpc/'));
  assert.deepEqual(calls[0].body, calls[1].body);
  assert.equal((await h.run(waitlist, waitlistBody(), { headers: { 'x-forwarded-for': IP }, socket: { remoteAddress: IP } })).code, 503);
  assert.equal((await h.run(waitlist, waitlistBody(), { headers: { 'x-vercel-forwarded-for': `${IP}, 203.0.113.1` } })).code, 503);
});

test('standalone servers use the socket and ignore untrusted Vercel headers', async t => {
  const h = harness(t);
  delete process.env.VERCEL;
  await h.run(waitlist, waitlistBody(), { headers: { 'x-vercel-forwarded-for': '203.0.113.1' }, socket: { remoteAddress: IP } });
  const expected = createHmac('sha256', SECRET).update(['bjm-public-form-v1', 'waitlist', 'ip', '600', IP].join('\0')).digest('hex');
  assert.equal(h.calls[0].body.p_buckets[0].bucket_key, expected);
  assert.equal((await h.run(waitlist, waitlistBody(), { headers: { 'x-vercel-forwarded-for': IP } })).code, 503);
});

test('equivalent IPv6 and temporary addresses in the same /64 share IP budgets', async t => {
  const h = harness(t);
  for (const address of ['2001:db8:abcd:12::1', '2001:0db8:abcd:0012:ffff:ffff:ffff:ffff', '2001:db8:abcd:13::1']) {
    assert.equal((await h.run(waitlist, waitlistBody(), { headers: { 'x-vercel-forwarded-for': address } })).code, 200);
  }
  const calls = h.calls.filter(call => call.path.includes('/rpc/'));
  assert.deepEqual(calls[0].body, calls[1].body);
  assert.notEqual(calls[0].body.p_buckets[0].bucket_key, calls[2].body.p_buckets[0].bucket_key);
  assert.equal(calls[0].body.p_buckets[2].bucket_key, calls[2].body.p_buckets[2].bucket_key);
});

test('mapped IPv4 and IPv4 addresses share the same IP budget', async t => {
  const h = harness(t);
  await h.run(waitlist, waitlistBody());
  await h.run(waitlist, waitlistBody(), { headers: { 'x-vercel-forwarded-for': '::ffff:192.0.2.10' } });
  const calls = h.calls.filter(call => call.path.includes('/rpc/'));
  assert.deepEqual(calls[0].body, calls[1].body);
});

test('database rejection never sends confirmation or claims a saved support ticket', async t => {
  const h = harness(t);
  h.override = call => call.path === '/rest/v1/support_tickets' ? json({ message: 'synthetic private provider body' }, 503) : null;
  assert.equal((await h.run(support, supportBody())).code, 503);
  assert.equal(h.calls.filter(call => call.url.startsWith('https://api.resend.com/')).length, 0);
  assert.equal(h.errors.join(' ').includes('synthetic private provider body'), false);
});

test('a saved support ticket remains successful when mail fails, with identical keys and payloads on retry', async t => {
  const h = harness(t);
  h.override = call => call.url.startsWith('https://api.resend.com/') ? json({ message: 'synthetic mail rejection containing private data' }, 503) : null;
  const result = await h.run(support, supportBody());
  assert.equal(result.code, 200);
  assert.equal(result.body.confirmation_sent, false);
  assert.match(result.body.ticket_id, /^BM-/);
  const mails = h.calls.filter(call => call.url.startsWith('https://api.resend.com/'));
  assert.equal(mails.length, 4);
  const keys = new Set(mails.map(call => call.headers['Idempotency-Key']));
  assert.equal(keys.size, 2);
  for (const key of keys) {
    const attempts = mails.filter(call => call.headers['Idempotency-Key'] === key);
    assert.equal(attempts.length, 2);
    assert.equal(attempts[0].serializedBody, attempts[1].serializedBody);
  }
  assert.equal(h.errors.join(' ').includes('private data'), false);
});

test('network loss after an accepted mail can retry with the same idempotency key', async t => {
  const h = harness(t);
  const seen = new Set();
  h.override = call => {
    if (!call.url.startsWith('https://api.resend.com/')) return null;
    const key = call.headers['Idempotency-Key'];
    if (!seen.has(key)) { seen.add(key); throw new TypeError('Synthetic response lost'); }
    return json({ id: 'same-synthetic-email-id' });
  };
  const result = await h.run(support, supportBody());
  assert.equal(result.code, 200);
  assert.equal(result.body.confirmation_sent, true);
  assert.equal(h.calls.filter(call => call.url.startsWith('https://api.resend.com/')).length, 4);
});

test('permanent mail rejection is not retried and cannot turn a saved ticket into failure', async t => {
  const h = harness(t);
  h.override = call => call.url.startsWith('https://api.resend.com/') ? json({ name: 'validation_error' }, 422) : null;
  const result = await h.run(support, supportBody());
  assert.equal(result.code, 200);
  assert.equal(result.body.confirmation_sent, false);
  assert.equal(h.calls.filter(call => call.url.startsWith('https://api.resend.com/')).length, 2);
});

test('an already joined address and a rate limit without Retry-After cause no redundant mail retries', async t => {
  const h = harness(t);
  h.override = call => call.path === '/rest/v1/waitlist_signups' && call.method === 'GET' ? json([{ id: 'synthetic-existing-signup' }]) : null;
  const existing = await h.run(waitlist, waitlistBody());
  assert.equal(existing.code, 200);
  assert.equal(existing.body.alreadyJoined, true);
  assert.equal(h.sideEffects().length, 0);
  h.override = call => call.url.startsWith('https://api.resend.com/') ? json({ name: 'rate_limit_exceeded' }, 429) : null;
  const saved = await h.run(support, supportBody());
  assert.equal(saved.code, 200);
  assert.equal(saved.body.confirmation_sent, false);
  assert.equal(h.calls.filter(call => call.url.startsWith('https://api.resend.com/')).length, 2);
});

test('a short provider rate limit gets one delayed retry with the same mail key and payload', async t => {
  const h = harness(t);
  const seen = new Set();
  h.override = call => {
    if (!call.url.startsWith('https://api.resend.com/')) return null;
    const key = call.headers['Idempotency-Key'];
    if (seen.has(key)) return json({ id: 'same-synthetic-email-id' });
    seen.add(key);
    return new Response(JSON.stringify({ name: 'rate_limit_exceeded' }), { status: 429, headers: { 'Retry-After': '1' } });
  };
  const result = await h.run(support, supportBody());
  assert.equal(result.code, 200);
  assert.equal(result.body.confirmation_sent, true);
  const mails = h.calls.filter(call => call.url.startsWith('https://api.resend.com/'));
  assert.equal(mails.length, 4);
  for (const key of seen) {
    const attempts = mails.filter(call => call.headers['Idempotency-Key'] === key);
    assert.equal(attempts.length, 2);
    assert.equal(attempts[0].serializedBody, attempts[1].serializedBody);
  }
});

test('quota errors, malformed 429 bodies, and unsafe Retry-After values are never retried', async t => {
  const h = harness(t);
  const failures = [
    ...['daily_quota_exceeded', 'monthly_quota_exceeded', 'unknown_error'].map(name => ({ name, retryAfter: '1' })),
    ...[undefined, '0', '-1', '0.5', '3', '86400', 'Wed, 21 Oct 2026 07:28:00 GMT'].map(retryAfter => ({ name: 'rate_limit_exceeded', retryAfter })),
    { invalidJson: true, retryAfter: '1' },
  ];
  for (const failure of failures) {
    h.override = call => !call.url.startsWith('https://api.resend.com/') ? null : new Response(
      failure.invalidJson ? '{invalid' : JSON.stringify({ name: failure.name, message: 'synthetic private response body' }),
      { status: 429, headers: failure.retryAfter === undefined ? {} : { 'Retry-After': failure.retryAfter } },
    );
    const before = h.calls.filter(call => call.url.startsWith('https://api.resend.com/')).length;
    const result = await h.run(support, supportBody());
    assert.equal(result.code, 200);
    assert.equal(result.body.confirmation_sent, false);
    assert.equal(h.calls.filter(call => call.url.startsWith('https://api.resend.com/')).length - before, 2);
  }
  assert.equal(h.errors.join(' ').includes('synthetic private response body'), false);
});

test('the shared request deadline aborts a provider Retry-After wait before another send', async t => {
  const h = harness(t);
  h.override = call => call.url.startsWith('https://api.resend.com/')
    ? new Response(JSON.stringify({ name: 'rate_limit_exceeded' }), { status: 429, headers: { 'Retry-After': '1' } }) : null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20);
  try {
    assert.equal(await sendFormEmail({ to: [EMAIL], subject: 'Synthetic' }, 'synthetic/deadline', controller.signal), false);
  } finally {
    clearTimeout(timer);
  }
  assert.equal(controller.signal.aborted, true);
  assert.equal(h.calls.length, 1);
  assert.equal(await sendFormEmail({ to: [EMAIL] }, 'synthetic/already-aborted', controller.signal), false);
  assert.equal(h.calls.length, 1);
});

function accelerateTimeouts(t) {
  const original = AbortSignal.timeout;
  t.mock.method(AbortSignal, 'timeout', milliseconds => original(Math.min(milliseconds, 20)));
}

function stalled(call) {
  return new Promise((resolve, reject) => {
    const fallback = setTimeout(() => reject(new Error('Deadline was not observed')), 250);
    const abort = () => { clearTimeout(fallback); reject(call.signal.reason); };
    if (call.signal.aborted) abort(); else call.signal.addEventListener('abort', abort, { once: true });
  });
}

test('a stalled budget RPC reaches its deadline and fails closed without any save or mail', async t => {
  const h = harness(t);
  accelerateTimeouts(t);
  h.override = call => call.path.includes('/rpc/') ? stalled(call) : null;
  assert.equal((await h.run(support, supportBody())).code, 503);
  assert.equal(h.sideEffects().length, 0);
});

test('a stalled email provider cannot hang or erase a successfully saved support ticket', async t => {
  const h = harness(t);
  accelerateTimeouts(t);
  h.override = call => call.url.startsWith('https://api.resend.com/') ? stalled(call) : null;
  const result = await h.run(support, supportBody());
  assert.equal(result.code, 200);
  assert.equal(result.body.confirmation_sent, false);
  assert.equal(h.calls.filter(call => call.path === '/rest/v1/support_tickets').length, 1);
});

test('support lookups handle provider rejection, invalid JSON and timeouts with a safe response', async t => {
  const h = harness(t);
  const options = { method: 'GET', query: { ticket: 'BM-SYNTHETIC', email: EMAIL } };
  for (const failure of [() => { throw new TypeError('Synthetic provider offline'); }, () => new Response('not JSON'), () => json({ error: 'unexpected data shape' })]) {
    h.override = call => call.path === '/rest/v1/support_tickets' ? failure() : null;
    assert.equal((await h.run(support, undefined, options)).code, 503);
  }
  accelerateTimeouts(t);
  h.override = call => call.path === '/rest/v1/support_tickets' ? stalled(call) : null;
  assert.equal((await h.run(support, undefined, options)).code, 503);
  assert.equal(h.sideEffects().length, 0);
});

test('waitlist lookup faults and a concurrent unique conflict cannot cause duplicate mail', async t => {
  const h = harness(t);
  for (const failure of [() => json({}, 503), () => new Response('not JSON'), () => json({ unexpected: true })]) {
    h.override = call => call.path === '/rest/v1/waitlist_signups' && call.method === 'GET' ? failure() : null;
    assert.equal((await h.run(waitlist, waitlistBody())).code, 503);
  }
  assert.equal(h.sideEffects().length, 0);
  h.override = call => call.path === '/rest/v1/waitlist_signups' && call.method === 'POST' ? json({ code: '23505' }, 409) : null;
  const conflict = await h.run(waitlist, waitlistBody());
  assert.equal(conflict.code, 200);
  assert.equal(conflict.body.alreadyJoined, true);
  assert.equal(h.calls.filter(call => call.url.startsWith('https://api.resend.com/')).length, 0);
});
