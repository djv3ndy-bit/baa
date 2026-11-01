import { authenticatedCafe, adminRows } from './_billing.js';
import { providerRuntimeCache, readProviderConfiguration, readContextConfiguration, readAppleEventConfiguration } from '../server/native-billing/runtime.mjs';
import { nativeBillingRepository } from '../server/native-billing/repository.mjs';
import { createReconciler } from '../server/native-billing/reconcile.mjs';
import { verificationHandler } from '../server/native-billing/verificationHandler.mjs';
import { configuredBillingContext, sandboxReconciliationAuthorizer } from '../server/native-billing/billingContext.mjs';
import { verifiedAppleEvent } from '../server/native-billing/appleEventRouter.mjs';

const repository = nativeBillingRepository(adminRows);
const runtime=providerRuntimeCache();
async function contextFor(userId,provider) {
  return configuredBillingContext(await repository.context(userId,provider),process.env.NATIVE_BILLING_ENVIRONMENT,provider);
}
export default verificationHandler({
  authenticateCafe: authenticatedCafe,
  contextFor,
  runtimeFor(provider,context) {
    return runtime(context ? readContextConfiguration(provider,context) : readProviderConfiguration(provider));
  },
  appleEvent: payload=>verifiedAppleEvent(environment=>runtime(readAppleEventConfiguration(environment)),payload,process.env.NATIVE_BILLING_ENVIRONMENT),
  reconcilerFor(provider, runtime) {
    return createReconciler({ repository, providers: { [provider]: runtime.provider }, environment: runtime.environment,
      authorize:sandboxReconciliationAuthorizer({contextFor,activeCafe:userId=>repository.activeCafe(userId),environment:process.env.NATIVE_BILLING_ENVIRONMENT}) });
  },
});
