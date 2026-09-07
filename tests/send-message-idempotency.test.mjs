import test from 'node:test';
import assert from 'node:assert/strict';
import handler from '../api/send-message.js';
import details from '../api/conversation-details.js';
const user = '00000000-0000-4000-8000-000000000001', other = '00000000-0000-4000-8000-000000000002';
const application = '10000000-0000-4000-8000-000000000001', id = '20000000-0000-4000-8000-000000000001';
const response = (body, status = 200) => new Response(JSON.stringify(body), { status });
function harness(t) {
  const original = globalThis.fetch;
  const keys = ['SUPABASE_URL', 'SUPABASE_PUBLISHABLE_KEY', 'SUPABASE_SECRET_KEY', 'RESEND_API_KEY'];
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  process.env.SUPABASE_URL = 'https://example.invalid'; process.env.SUPABASE_PUBLISHABLE_KEY = 'test'; process.env.SUPABASE_SECRET_KEY = 'test'; delete process.env.RESEND_API_KEY;
  const rows = new Map(), calls = [];
  const h = { rows, calls, override: null };
  globalThis.fetch = async (url, options = {}) => {
    const parsed = new URL(url), body = options.body ? JSON.parse(options.body) : null;
    const call = { path: parsed.pathname, query: parsed.searchParams, body, method: options.method || 'GET' }; calls.push(call);
    const overridden = await h.override?.(call); if (overridden) return overridden;
    if (call.path === '/auth/v1/user') return response({ id: user });
    if (call.path === '/rest/v1/applications') return response([{ id: application, status: 'matched', barista_id: user, job: { owner_id: other, title: 'Barista' } }]);
    if (call.path === '/rest/v1/messages' && body) {
      const key = body.id || String(rows.size);
      if (rows.has(key)) return response({ code: '23505' }, 409);
      const row = { ...body, id: key, created_at: '2026-09-07T10:00:00Z' }; rows.set(key, row); return response([row]);
    }
    if (call.path === '/rest/v1/messages') {
      const row = rows.get(call.query.get('id')?.slice(3));
      return response(row && row.application_id === call.query.get('application_id')?.slice(3) && row.sender_id === call.query.get('sender_id')?.slice(3) ? [row] : []);
    }
    if (call.path === '/rest/v1/user_blocks') return response([]);
    if (call.path === '/rest/v1/notification_preferences') return response([{ email_messages: false }]);
    if (call.path === '/rest/v1/profiles' || call.path === '/rest/v1/device_push_tokens') return response([]);
    throw new Error(`Unexpected request: ${call.path}`);
  };
  t.after(() => { globalThis.fetch = original; for (const key of keys) saved[key] === undefined ? delete process.env[key] : process.env[key] = saved[key]; });
  h.run = async (body = {}, headers = { authorization: 'Bearer test-user' }) => {
    const res = { setHeader() {}, status(code) { this.code = code; return this; }, json(value) { this.body = value; return this; } };
    await handler({ method: 'POST', headers, body: { application_id: application, body: 'Hello', client_message_id: id, ...body } }, res); return res;
  };
  return h;
}
test('retry after a lost send response returns one saved message without duplicate alerts', async t => {
  const h = harness(t); const first = await h.run(); assert.equal(first.code, 200);
  const before = h.calls.filter(c => c.path === '/rest/v1/notification_preferences').length;
  const retry = await h.run(); assert.equal(retry.code, 200); assert.equal(retry.body.replayed, true); assert.equal(retry.body.message.id, first.body.message.id); assert.equal(h.rows.size, 1);
  assert.equal(h.calls.filter(c => c.path === '/rest/v1/notification_preferences').length, before);
});
test('concurrent requests with the same message ID save exactly one message', async t => {
  const h = harness(t); const results = await Promise.all([h.run(), h.run()]); assert.deepEqual(results.map(r => r.code), [200, 200]); assert.equal(h.rows.size, 1); assert.equal(results.filter(r => r.body.replayed).length, 1);
});
test('reusing an ID with changed text or another sender cannot claim success', async t => {
  const h = harness(t); await h.run(); assert.equal((await h.run({ body: 'Changed' })).code, 409);
  h.rows.get(id).sender_id = other; assert.equal((await h.run()).code, 409);
});
test('invalid request IDs fail before any insert', async t => {
  const h = harness(t); assert.equal((await h.run({ client_message_id: '../bad' })).code, 400); assert.equal(h.rows.size, 0);
});
test('legacy web clients can still send without a request ID', async t => {
  const h = harness(t); assert.equal((await h.run({ client_message_id: undefined })).code, 200); assert.equal(h.rows.size, 1);
});
test('auth outages are retryable and never insert a message', async t => {
  const h = harness(t); h.override = c => c.path === '/auth/v1/user' ? response({}, 503) : null;
  assert.equal((await h.run()).code, 502); assert.equal(h.rows.size, 0);
});

test('paused jobs still permit a matched barista to send and resolve the café identity', async t => {
  const h = harness(t);
  h.override = c => c.path === '/rest/v1/applications' ? response([{id:application,status:'matched',job_id:'job-id',barista_id:user,job:null}]) : c.path === '/rest/v1/jobs' ? response([{id:'job-id',owner_id:other,title:'Paused role'}]) : null;
  assert.equal((await h.run()).code, 200);
  const res = { setHeader() {}, status(code) { this.code = code; return this; }, json(value) { this.body = value; return this; } };
  await details({method:'GET',headers:{authorization:'Bearer test-user'},query:{application_id:application}},res);
  assert.equal(res.code,200); assert.equal(res.body.cafe.id,other); assert.equal(res.body.job.title,'Paused role');
});
test('unrelated callers and blocked conversations cannot read metadata or send', async t => {
  const h = harness(t);
  h.override = c => c.path === '/rest/v1/applications' ? response([{id:application,status:'matched',job_id:'job-id',barista_id:other,job:null}]) : null;
  assert.equal((await h.run()).code,403); assert.equal(h.calls.some(c => c.path === '/rest/v1/jobs'),false);
  h.override = c => c.path === '/rest/v1/user_blocks' ? response([{blocker_id:user}]) : null;
  assert.equal((await h.run()).code,403); assert.equal(h.rows.size,0);
});
