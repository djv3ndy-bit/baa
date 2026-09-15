import { authenticatedCafe, adminRows } from './_billing.js';
import { createProviderRuntime, readProviderConfiguration } from '../server/native-billing/runtime.mjs';
import { nativeBillingRepository } from '../server/native-billing/repository.mjs';
import { createReconciler } from '../server/native-billing/reconcile.mjs';
import { verificationHandler } from '../server/native-billing/verificationHandler.mjs';

const repository = nativeBillingRepository(adminRows);
const runtimes = new Map();
export default verificationHandler({
  authenticateCafe: authenticatedCafe,
  runtimeFor(provider) {
    if (!runtimes.has(provider)) {
      const config = readProviderConfiguration(provider);
      runtimes.set(provider, createProviderRuntime(config).catch(error => { runtimes.delete(provider); throw error; }));
    }
    return runtimes.get(provider);
  },
  reconcilerFor(provider, runtime) {
    return createReconciler({ repository, providers: { [provider]: runtime.provider }, environment: runtime.environment });
  },
});
