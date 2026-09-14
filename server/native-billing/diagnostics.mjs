const codes = new Set([
  'ACCOUNT_MISMATCH', 'PURCHASE_MISMATCH', 'PRODUCT_MISMATCH', 'ENVIRONMENT_MISMATCH',
  'INVALID_PROOF', 'INVALID_TRANSACTION', 'INVALID_EVENT', 'EVENT_UNAUTHORIZED',
  'ACCOUNT_UNAVAILABLE', 'SERVER_CONFIGURATION', 'PROVIDER_UNAVAILABLE',
  'PERSISTENCE_UNCONFIRMED', 'ACKNOWLEDGEMENT_UNAVAILABLE', 'RECONCILIATION_BUSY',
  'EVENT_BUSY', 'EVENT_LEASE_EXPIRED', 'UNSUPPORTED_PURCHASE', 'UNKNOWN_STATE',
  'RENEWAL_MISMATCH', 'RENEWAL_UNAVAILABLE', 'AMBIGUOUS_SUBSCRIPTION', 'INVALID_EXPIRY', 'INVALID_RESPONSE',
]);
const stages = new Set(['request', 'authentication', 'provider-setup', 'signature', 'reconciliation']);

/** Only bounded classifications reach logs. Never include requests, error messages,
 * stacks, causes, tokens, account IDs, receipts or provider response bodies. */
export function paymentFailureReport(error, { provider, stage, rejected }) {
  const report = {
    event: 'native_purchase_verification_failed',
    provider: ['apple', 'google'].includes(provider) ? provider : 'unknown',
    stage: stages.has(stage) ? stage : 'request',
    httpStatus: rejected === true ? 403 : 503,
    reason: 'UNCLASSIFIED',
  };
  if (codes.has(error?.code)) report.reason = error.code;
  else if (['AbortError', 'TimeoutError'].includes(error?.name)) report.reason = 'TIMEOUT';
  else if (error?.constructor?.name === 'VerificationException' && Number.isInteger(error.status)
    && error.status >= 0 && error.status <= 7) {
    report.reason = 'APPLE_SIGNATURE_VERIFICATION';
    report.verificationStatus = error.status;
  }
  else if (error?.constructor?.name === 'APIException' && Number.isInteger(error.httpStatusCode)
    && error.httpStatusCode >= 400 && error.httpStatusCode <= 599) {
    report.reason = 'APPLE_API_REQUEST_FAILED';
    report.upstreamStatus = error.httpStatusCode;
  }
  else if (typeof error?.message === 'string' && /^Database request failed \([45]\d\d\)\.$/.test(error.message)) {
    // The existing server transport emits exactly this bounded format. Do not
    // copy database messages, response bodies, queries or paths into logs.
    report.reason = 'DATABASE_REQUEST_FAILED';
    report.upstreamStatus = Number(error.message.slice(25, 28));
  }
  else if (error?.name === 'TypeError' && error.message === 'fetch failed') {
    report.reason = 'NETWORK_REQUEST_FAILED';
  }
  return report;
}

export function logPaymentFailure(report) { console.error(JSON.stringify(report)); }
