import test from 'node:test';
import assert from 'node:assert/strict';
import { captureBillingStatus } from '../../server/native-billing/accountBillingHandler.mjs';

async function exercise(codes, req = { method: 'GET', query: { action: 'status' }, headers: {} }) {
  const requests = [], waits = [];
  const body = { plan: 'pro', monthlyPriceCents: 999, maxActiveJobs: 3 };
  const result = await captureBillingStatus(async (request, response) => {
    requests.push(request);
    const code = codes[Math.min(requests.length - 1, codes.length - 1)];
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Read-Attempt', String(requests.length));
    response.status(code).json(code === 200 ? body : { error: 'Subscription details are temporarily unavailable.' });
  }, req, { wait: async ms => waits.push(ms) });
  return { result, requests, waits, body };
}

test('a temporary legacy status failure recovers using a fresh verified read', async () => {
  const { result, requests, waits, body } = await exercise([503, 200]);
  assert.equal(result.code, 200);
  assert.equal(result.body, body);
  assert.equal(requests.length, 2);
  assert.deepEqual(waits, [200]);
  assert.equal(result.headers['X-Read-Attempt'], '2');
});

test('persistent legacy failure remains unavailable after three reads, with no invented access', async () => {
  const { result, requests, waits } = await exercise([504]);
  assert.equal(result.code, 504);
  assert.equal(result.body.plan, undefined);
  assert.equal(requests.length, 3);
  assert.deepEqual(waits, [200, 600]);
});

test('successful, denied, conflicting and rate-limited reads are never retried', async () => {
  for (const code of [200, 400, 401, 403, 404, 409, 429]) {
    const { result, requests, waits } = await exercise([code]);
    assert.equal(result.code, code);
    assert.equal(requests.length, 1);
    assert.deepEqual(waits, []);
  }
});

test('an expired session encountered during recovery stops immediately', async () => {
  const { result, requests } = await exercise([503, 401, 200]);
  assert.equal(result.code, 401);
  assert.equal(requests.length, 2);
});

test('recovery of a management preflight only replays GET status, never a portal or purchase', async () => {
  const req = { method: 'POST', query: { action: 'portal' }, headers: { authorization: 'Bearer test-only' }, body: { provider: 'stripe' } };
  const { result, requests } = await exercise([502, 503, 200], req);
  assert.equal(result.code, 200);
  assert.equal(requests.length, 3);
  for (const request of requests) {
    assert.equal(request.method, 'GET');
    assert.deepEqual(request.query, { action: 'status' });
    assert.equal(request.headers, req.headers);
  }
  assert.equal(req.method, 'POST');
  assert.deepEqual(req.query, { action: 'portal' });
});
