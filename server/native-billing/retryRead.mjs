const connectionCodes = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN']);

export function temporaryReadFailure(error) {
  if (error?.constructor?.name === 'APIException') {
    return [500, 502, 503, 504].includes(error.httpStatusCode);
  }
  if (/^Database request failed \((500|502|503|504)\)\.$/.test(error?.message ?? '')) return true;
  if (error?.name === 'TypeError' && error.message === 'fetch failed') return true;
  return error?.name === 'FetchError' && error.type === 'system' && connectionCodes.has(error.code);
}

/** Only wrap reads (or explicitly idempotent housekeeping), never a purchase,
 * event lease, transaction acknowledgement or uncertain database write. Each
 * retry reads current state again. Permanent errors and exhausted retries fail
 * closed, preserving the caller's existing recovery/verification behavior. */
export async function retryBillingRead(operation, {
  wait = ms => new Promise(resolve => setTimeout(resolve, ms)),
} = {}) {
  for (let attempt = 0; ; attempt++) {
    try { return await operation(); }
    catch (error) {
      if (attempt === 2 || !temporaryReadFailure(error)) throw error;
      await wait(attempt === 0 ? 200 : 600);
    }
  }
}
