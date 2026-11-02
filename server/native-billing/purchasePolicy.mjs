import { configuredBillingContext } from './billingContext.mjs';

/** Server configuration and the private DB resolver are the only authorities.
 * The Sandbox override never enables ordinary Production or Google purchases. */
export function nativePurchasePolicy({ environment, billingEnabled = false,
  nativePurchasesEnabled = false, appleSandboxPurchasesEnabled = false } = {}) {
  return (serverContext, provider) => {
    if (billingEnabled !== true || !['apple','google'].includes(provider)) return false;
    let context;
    try { context = configuredBillingContext(serverContext, environment, provider); }
    catch { return false; }
    // Preserve the existing enabled path, including isolated nonproduction QA.
    if (nativePurchasesEnabled === true) return true;
    return appleSandboxPurchasesEnabled === true && provider === 'apple' && environment === 'Production'
      && context.environment === 'Sandbox' && context.appleSandboxTester === true;
  };
}

/** Exact literal parsing matches the existing feature switches. Unset is OFF. */
export function nativePurchasePolicyFromEnvironment(env = {}) {
  return nativePurchasePolicy({
    environment: env.NATIVE_BILLING_ENVIRONMENT,
    billingEnabled: env.BILLING_ENABLED === 'true',
    nativePurchasesEnabled: env.NATIVE_PURCHASES_ENABLED === 'true',
    appleSandboxPurchasesEnabled: env.APPLE_SANDBOX_PURCHASES_ENABLED === 'true',
  });
}
