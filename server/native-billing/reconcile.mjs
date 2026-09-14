import { createHash, randomUUID } from 'node:crypto';
import { PurchaseVerificationError } from './verifiedStatus.mjs';

const check = (condition, code) => { if (!condition) throw new PurchaseVerificationError(code); };

/** The repository is service-role-only. Every retry fetches provider state
 * AFTER reading its revision, so a slow request cannot undo a later refund.
 * Notifications use the same path as purchases and restoration. */
export function createReconciler({ repository, providers, environment, maxAttempts = 3 }) {
  check(['Sandbox', 'Production'].includes(environment), 'SERVER_CONFIGURATION');
  check(Number.isInteger(maxAttempts) && maxAttempts > 0 && maxAttempts <= 5, 'SERVER_CONFIGURATION');

  async function reconcile({ provider, proof, accountId }) {
    const adapter = Object.hasOwn(providers, provider) && providers[provider];
    check(adapter, 'PROVIDER_UNAVAILABLE');
    const identity = await adapter.identify(proof);
    const owner = await repository.owner(identity.binding);
    check(owner && (!accountId || owner.userId === accountId), 'ACCOUNT_MISMATCH');
    if (accountId) check(await repository.activeCafe(accountId), 'ACCOUNT_UNAVAILABLE');
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const previous = await repository.read(provider, environment, identity.providerSubscriptionId);
      check(!previous || previous.userId === owner.userId, 'ACCOUNT_MISMATCH');
      const status = await adapter.verify(proof, identity.binding);
      check(status.provider === provider && status.environment === environment && status.binding === identity.binding
        && status.providerSubscriptionId === identity.providerSubscriptionId, 'PURCHASE_MISMATCH');
      if (accountId) check(await repository.activeCafe(accountId), 'ACCOUNT_UNAVAILABLE');
      const result = await repository.apply({ ...status, userId: owner.userId, expectedRevision: previous?.revision ?? 0 });
      if (result === 'retry') continue;
      check(['applied', 'duplicate', 'superseded'].includes(result), 'PERSISTENCE_UNCONFIRMED');
      if (result === 'superseded') return { ...status, access: 'free', status: 'revoked', canManage: false, autoRenews: false, superseded: true };
      // If acknowledgement fails, the durable verified entitlement remains.
      // The notification/client receives a retryable failure, never permission
      // to buy again; the next attempt checks the provider's ack status afresh.
      if (status.needsAcknowledgement) {
        check(typeof adapter.acknowledge === 'function', 'ACKNOWLEDGEMENT_UNAVAILABLE');
        await adapter.acknowledge(proof);
      }
      return status;
    }
    throw new PurchaseVerificationError('RECONCILIATION_BUSY');
  }

  async function notification({ provider, eventId, proof, payload, test = false }) {
    check(Object.hasOwn(providers, provider), 'PROVIDER_UNAVAILABLE');
    check(typeof eventId === 'string' && eventId.length > 0 && eventId.length <= 255, 'INVALID_EVENT');
    check(typeof payload === 'string' && payload.length > 0 && payload.length <= 262_144, 'INVALID_EVENT');
    const claimId = randomUUID();
    const key = { provider, environment, eventId, claimId };
    const claim = await repository.claimEvent({ ...key, payloadHash: createHash('sha256').update(payload).digest('hex') });
    if (claim === 'duplicate') return { kind: 'duplicate' };
    check(claim === 'claimed', 'EVENT_BUSY');
    try {
      // Callers must verify the signature/OIDC identity before invoking this
      // function. A provider test notification never grants subscription access.
      const status = test ? null : await reconcile({ provider, proof });
      check(await repository.finishEvent({ ...key, success: true }), 'EVENT_LEASE_EXPIRED');
      return { kind: 'processed', status };
    } catch (error) {
      try { await repository.finishEvent({ ...key, success: false }); } catch { /* Lease expiry also permits a provider retry. */ }
      throw error;
    }
  }

  return { reconcile, notification };
}
