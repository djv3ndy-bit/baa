import { createHmac } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { checkedBillingContext } from './billingContext.mjs';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const nonterminal = new Set(['active', 'grace', 'payment_required']);
const verifiedStates = new Set([...nonterminal, 'expired', 'revoked']);
const namespace = 'bjm:owned-apple-status-refresh:v1';
const opaque = value => typeof value === 'string' && /^[\x21-\x7e]{1,255}$/.test(value);
const timestamp = value => typeof value === 'string' && /T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value)
  && Number.isFinite(Date.parse(value));
const optionalTimestamp = value => value === null || timestamp(value);

function checkedSnapshot(value, accountId, productId, now) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.userId !== accountId || !uuid.test(value.userId)
    || value.provider !== 'apple' || value.environment !== 'Sandbox'
    || !opaque(value.subscriptionId) || !uuid.test(value.binding)
    || value.productId !== productId || !nonterminal.has(value.status)
    || typeof value.autoRenews !== 'boolean'
    || !Number.isSafeInteger(value.revision) || value.revision < 1
    || !Number.isSafeInteger(value.generation) || value.generation < 1
    || !['verifiedAt', 'currentPeriodEnd', 'authorizedAt', 'expiresAt', 'windowStartsAt', 'windowEndsAt'].every(key => timestamp(value[key]))
    || !optionalTimestamp(value.gracePeriodEnd)) return null;
  const effectiveEnd = value.status === 'grace' && value.gracePeriodEnd !== null
    ? value.gracePeriodEnd : value.currentPeriodEnd;
  if (Date.parse(effectiveEnd) > now || Date.parse(value.verifiedAt) > now - 60_000
    || Date.parse(value.authorizedAt) > now || Date.parse(value.expiresAt) <= now
    || Date.parse(value.windowStartsAt) > now || Date.parse(value.windowEndsAt) <= now) return null;
  // Copy only trusted snapshot fields needed by the atomic guarded apply. Keep
  // PostgreSQL timestamp strings intact: millisecond conversion loses precision.
  return Object.fromEntries(['userId', 'provider', 'environment', 'subscriptionId', 'binding', 'productId',
    'status', 'autoRenews', 'revision', 'generation', 'verifiedAt', 'currentPeriodEnd', 'gracePeriodEnd',
    'authorizedAt', 'expiresAt', 'windowStartsAt', 'windowEndsAt'].map(key => [key, value[key]]));
}

function matchesVerified(status, snapshot) {
  return status && typeof status === 'object' && !Array.isArray(status)
    && status.provider === 'apple' && status.environment === 'Sandbox'
    && status.providerSubscriptionId === snapshot.subscriptionId && status.binding === snapshot.binding
    && status.productId === snapshot.productId && opaque(status.transactionId)
    && verifiedStates.has(status.status) && typeof status.autoRenews === 'boolean'
    && timestamp(status.currentPeriodEnd) && optionalTimestamp(status.gracePeriodEnd);
}

/** Existing owned chains only. The DB snapshot and final CAS independently
 * enforce the live app_review authority, expiry, generation, account and SKU.
 * Nothing from this helper is returned to a public status response. */
export function ownedAppleRefresh({ repository, providerFor, contextFor, environment,
  productId, budgetSecret, timeoutMs = 4000, now = Date.now, monotonicNow = () => performance.now() }) {
  return async (account, contextInput) => {
    let context;
    try { context = checkedBillingContext(contextInput); } catch { return false; }
    if (environment !== 'Production' || !context.appleSandboxTester || context.environment !== 'Sandbox'
      || !account || !uuid.test(account.id) || account.role !== 'cafe_owner_manager' || account.suspendedAt
      || typeof productId !== 'string' || !productId || !Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 4000) return false;

    const controller = new AbortController();
    const deadline = monotonicNow() + timeoutMs;
    let expired = false;
    const current = () => !expired && !controller.signal.aborted && monotonicNow() < deadline;
    let timer;
    const timeout = new Promise(resolve => {
      timer = setTimeout(() => { expired = true; controller.abort(); resolve(false); }, timeoutMs);
    });
    const run = async () => {
      try {
        const options = { signal: controller.signal };
        const raw = await repository.ownedAppleRefresh(account.id, options);
        if (!current()) return false;
        const snapshot = checkedSnapshot(raw, account.id, productId, now());
        if (!snapshot) return false;
        const secret = typeof budgetSecret === 'function' ? budgetSecret() : budgetSecret;
        if (typeof secret !== 'string' || secret.length < 32) return false;
        const key = parts => createHmac('sha256', secret).update(JSON.stringify(parts)).digest('hex');
        const buckets = [
          { bucket_key: key([namespace, 'owner-chain', account.id, snapshot.subscriptionId, snapshot.environment, snapshot.generation]), max_requests: 1, window_seconds: 300 },
          { bucket_key: key([namespace, 'global', environment, snapshot.environment]), max_requests: 30, window_seconds: 300 },
        ];
        if (!current()) return false;
        const budget = await repository.consumeOwnedAppleRefreshBudget(buckets, options);
        if (!current() || budget?.allowed !== true || budget.retry_after_seconds !== 0) return false;
        const provider = await providerFor(context, options);
        if (!current() || typeof provider?.verifyExisting !== 'function') return false;
        // One current Apple read, using only the server-owned original chain.
        const status = await provider.verifyExisting(snapshot.subscriptionId, snapshot.binding, options);
        if (!current() || !matchesVerified(status, snapshot)) return false;
        const latest = checkedBillingContext(await contextFor(account.id, 'apple', options));
        if (!current() || !latest.appleSandboxTester || latest.environment !== 'Sandbox') return false;
        // No retry/CAS loop and no insertion fallback. Once this SQL request has
        // begun it may commit even if its response is lost at the deadline; its
        // existing-only authority/revision guards remain the source of truth.
        const result = await repository.applyOwnedAppleRefresh(snapshot, status, options);
        return current() && ['applied', 'duplicate'].includes(result);
      } catch {
        // Provider, budget and uncertain write failures leave the ordinary
        // stored-summary path intact. Never log JWS, chain IDs or key material.
        return false;
      }
    };
    try { return await Promise.race([run(), timeout]); }
    finally { expired = true; clearTimeout(timer); controller.abort(); }
  };
}
