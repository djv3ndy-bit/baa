import test from 'node:test';
import assert from 'node:assert/strict';
import { APIException, VerificationException, VerificationStatus } from '@apple/app-store-server-library';
import { paymentFailureReport } from '../../server/native-billing/diagnostics.mjs';
import { verificationHandler } from '../../server/native-billing/verificationHandler.mjs';

test('payment diagnostics exclude arbitrary error/request material', () => {
  const error = Object.assign(new Error('private receipt and secret key'), {
    code: 'private-token', stack: 'private-stack', cause: { token: 'private-cause' },
    response: { data: { credential: 'private-response' } },
  });
  const report = paymentFailureReport(error, { provider: 'private-provider', stage: 'private-stage', rejected: false });
  assert.deepEqual(report, { event: 'native_purchase_verification_failed', provider: 'unknown',
    stage: 'request', httpStatus: 503, reason: 'UNCLASSIFIED' });
  assert.doesNotMatch(JSON.stringify(report), /private|receipt|secret|credential/);
});

test('official Apple retryable signature errors retain only a bounded status', () => {
  const error = new VerificationException(VerificationStatus.RETRYABLE_VERIFICATION_FAILURE, new Error('private-certificate-response'));
  assert.deepEqual(paymentFailureReport(error, { provider: 'apple', stage: 'signature', rejected: false }), {
    event: 'native_purchase_verification_failed', provider: 'apple', stage: 'signature', httpStatus: 503,
    reason: 'APPLE_SIGNATURE_VERIFICATION', verificationStatus: VerificationStatus.RETRYABLE_VERIFICATION_FAILURE,
  });
});

test('Apple API failures keep only the HTTP status and never provider details', () => {
  const report = paymentFailureReport(new APIException(503, 5000001, 'private-receipt'), {
    provider: 'apple', stage: 'reconciliation', rejected: false,
  });
  assert.equal(report.reason, 'APPLE_API_REQUEST_FAILED');
  assert.equal(report.upstreamStatus, 503);
  assert.doesNotMatch(JSON.stringify(report), /private|5000001|receipt/);
});

test('the existing database transport failure identifies a bounded status only', () => {
  for (const code of [400, 401, 429, 500, 503, 504, 599]) {
    const report = paymentFailureReport(new Error(`Database request failed (${code}).`), {
      provider: 'apple', stage: 'reconciliation', rejected: false,
    });
    assert.equal(report.reason, 'DATABASE_REQUEST_FAILED');
    assert.equal(report.upstreamStatus, code);
    assert.equal(report.httpStatus, 503);
  }
});

test('unrecognized database or Apple messages never leak into diagnostics', () => {
  for (const error of [new Error('Database request failed (503). private-secret'),
    new Error('Database request failed (200).'), new APIException(900, 1, 'private-key')]) {
    const report = paymentFailureReport(error, {provider: 'apple', stage: 'reconciliation', rejected: false});
    assert.equal(report.reason, 'UNCLASSIFIED');
    assert.equal(report.upstreamStatus, undefined);
    assert.doesNotMatch(JSON.stringify(report), /private|secret|key/);
  }
});

test('network and missing provider metadata retain safe classifications', () => {
  const args = {provider: 'apple', stage: 'reconciliation', rejected: false};
  assert.equal(paymentFailureReport(new TypeError('fetch failed'), args).reason, 'NETWORK_REQUEST_FAILED');
  for (const code of ['RENEWAL_UNAVAILABLE', 'AMBIGUOUS_SUBSCRIPTION']) {
    assert.equal(paymentFailureReport(Object.assign(new Error('private-response'), {code}), args).reason, code);
  }
});

async function failAt(stage, loggerThrows = false) {
  const reports = [];
  const secretError = Object.assign(new Error('private-payload'), { code: 'EVENT_BUSY' });
  const fail = async () => { throw secretError; };
  const handler = verificationHandler({
    authenticateCafe: async () => null,
    runtimeFor: stage === 'provider-setup' ? fail : async () => ({ provider: {
      notification: stage === 'signature' ? fail : async () => ({ provider: 'apple', eventId: 'private-event' }),
    } }),
    reconcilerFor: () => ({ notification: fail }),
    logFailure: report => { reports.push(report); if (loggerThrows) throw new Error('log unavailable'); },
  });
  const res = { code: 200, setHeader() {}, status(n) { this.code = n; return this; }, json(body) { this.body = body; return this; } };
  await handler({ method: 'POST', query: { action: 'apple-events' }, headers: { authorization: 'private-token' }, body: { signedPayload: 'private-receipt' } }, res);
  return { reports, res };
}

test('callback failure stages distinguish setup, signature and ledger work without false success', async () => {
  for (const stage of ['provider-setup', 'signature', 'reconciliation']) {
    const { reports, res } = await failAt(stage);
    assert.equal(res.code, 503); assert.equal(res.body.received, undefined);
    assert.equal(reports.length, 1); assert.equal(reports[0].stage, stage); assert.equal(reports[0].reason, 'EVENT_BUSY');
    assert.doesNotMatch(JSON.stringify({ reports, body: res.body }), /private-/);
  }
});

test('a failed logger cannot acknowledge an unprocessed payment event', async () => {
  const { res } = await failAt('reconciliation', true);
  assert.equal(res.code, 503); assert.equal(res.body.received, undefined);
});
