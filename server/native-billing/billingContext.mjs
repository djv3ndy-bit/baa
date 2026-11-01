import { PurchaseVerificationError } from './verifiedStatus.mjs';

export const APPLE_STORE_GUARD = 'apple-app-transaction-v1';
/** Accept only the sanitized service-role DB resolver result, never request data. */
export function checkedBillingContext(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !['Production', 'Sandbox'].includes(value.environment)
    || typeof value.appleSandboxTester !== 'boolean'
    || (value.appleSandboxTester && value.environment !== 'Sandbox')) throw new PurchaseVerificationError('SERVER_CONFIGURATION');
  return { environment: value.environment, appleSandboxTester: value.appleSandboxTester };
}
export function storeContextView(context) {
  const value = checkedBillingContext(context);
  return { storeEnvironment: value.environment, appleSandboxTester: value.appleSandboxTester };
}
export function configuredBillingContext(value, environment, provider=null) {
  const context=checkedBillingContext(value);
  if (!['Production','Sandbox'].includes(environment) || (context.appleSandboxTester && provider && provider!=='apple')
    || (context.environment!==environment && !(environment==='Production' && context.appleSandboxTester && context.environment==='Sandbox'))) {
    throw new PurchaseVerificationError('SERVER_CONFIGURATION');
  }
  return context;
}
/** Compatibility admission only. This header never selects an environment. */
export function requireStoreGuard(context, protocol) {
  if (checkedBillingContext(context).appleSandboxTester && protocol !== APPLE_STORE_GUARD) {
    const error = new Error('A supported store guard is required.'); error.code = 'STORE_GUARD_REQUIRED'; throw error;
  }
}
export function requestStoreGuard(req) {
  const value = req.headers?.['x-bjm-store-guard'];
  return typeof value === 'string' && value === APPLE_STORE_GUARD ? value : null;
}

/** Inputs are already cryptographically verified by the provider/reconciler.
 * False means a historical webhook is acknowledged without changing access. */
export function sandboxReconciliationAuthorizer({contextFor,activeCafe,environment}) {
  return async ({provider,environment:receiptEnvironment,status,owner,previous,accountId}) => {
    if(provider!=='apple' || receiptEnvironment!=='Sandbox' || environment!=='Production')return true;
    const historical=previous?.revision>0 && previous.userId===owner.userId;
    if(historical && ['expired','revoked'].includes(status.status))return true;
    if(historical && !accountId && !await activeCafe(owner.userId))return false;
    const context=checkedBillingContext(await contextFor(owner.userId,'apple'));
    if(context.appleSandboxTester && context.environment==='Sandbox')return true;
    if(historical && !accountId)return false;
    throw new PurchaseVerificationError('ACCOUNT_UNAVAILABLE');
  };
}
