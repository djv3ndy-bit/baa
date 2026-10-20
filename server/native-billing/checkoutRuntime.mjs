import { nativeCheckoutService } from './checkoutService.mjs';
import { readProviderConfiguration, createProviderRuntime } from './runtime.mjs';

const appleProductId = 'com.baristajobmatch.cafe.pro.monthly';

// One runtime cache per server composition. The Google gate is independent of
// the public UI flag; its absence is always disabled. No catalog ID is guessed.
export function createNativeAccountService({ repository, inspectWebsiteBilling,
  environment = () => process.env, readConfiguration = readProviderConfiguration,
  createRuntime = createProviderRuntime,
}) {
  const runtimes = new Map();
  return function nativeAccountService() {
    const env = environment();
    const billingEnvironment = env.NATIVE_BILLING_ENVIRONMENT;
    if (!['Sandbox', 'Production'].includes(billingEnvironment)
      || (billingEnvironment === 'Production') !== (env.VERCEL_ENV === 'production')) {
      throw new Error('Native billing environment unavailable');
    }
    const google = { enabled: env.NATIVE_GOOGLE_PURCHASES_ENABLED === 'true',
      productId: env.GOOGLE_PLAY_PRODUCT_ID, basePlanId: env.GOOGLE_PLAY_BASE_PLAN_ID };
    return nativeCheckoutService({ repository, environment: billingEnvironment,
      enabled: env.NATIVE_PURCHASES_ENABLED === 'true' && env.BILLING_ENABLED === 'true',
      productId: appleProductId, google, inspectWebsiteBilling,
      async ready(provider = 'apple') {
        const config = readConfiguration(provider, env);
        const expectedProduct = provider === 'apple' ? appleProductId : google.productId;
        if (config.provider !== provider || config.environment !== billingEnvironment || config.productId !== expectedProduct
          || (provider === 'google' && config.basePlanId !== google.basePlanId)) throw new Error('Store product mismatch');
        // Configuration is immutable within a deployment. Include non-secret
        // catalog/environment identity so tests and catalog changes cannot mix stores.
        const key = JSON.stringify([provider, billingEnvironment, expectedProduct, config.basePlanId ?? null]);
        if (!runtimes.has(key)) {
          runtimes.set(key, Promise.resolve().then(() => createRuntime(config)).catch(error => { runtimes.delete(key); throw error; }));
        }
        await runtimes.get(key);
      },
    });
  };
}
