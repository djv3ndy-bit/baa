import type { NativePurchase, NativePurchaseApi } from '../native-subscription/expoStoreGateway';
import { storeResponse } from '../native-subscription/storeTimeout';
import type { AppEnvironment } from './environmentController';

type ReviewStoreApi<P extends NativePurchase> = NativePurchaseApi<P> & {
  getAppTransactionIOS?: () => Promise<{ environment: string; bundleId: string } | null>;
};

/** A UI mode cannot turn a live Apple checkout into Sandbox. Fail closed before opening it. */
export function sandboxOnlyStore<P extends NativePurchase>(sdk: ReviewStoreApi<P>): NativePurchaseApi<P> {
  async function requireSandbox() {
    const transaction = await storeResponse(sdk.getAppTransactionIOS ? sdk.getAppTransactionIOS() : Promise.resolve(null));
    if (transaction?.environment !== 'Sandbox' || transaction.bundleId !== 'com.baristajobmatch.app') {
      throw new Error('Test purchases require an Apple Sandbox installation.');
    }
  }
  return {
    ...sdk,
    async initConnection() {
      const connected = await sdk.initConnection();
      if (connected === false) return false;
      try { await requireSandbox(); return connected; }
      catch (error) { await sdk.endConnection().catch(() => {}); throw error; }
    },
    async requestPurchase(input) { await requireSandbox(); return sdk.requestPurchase(input); },
    async restorePurchases() { await requireSandbox(); return sdk.restorePurchases(); },
  };
}

/** Play exposes no pre-purchase Sandbox identity. This only permits the SDK in
 * the explicitly configured isolated Android test build; it does not prove a
 * Google account is a license tester. The operator must use a registered license
 * tester and confirm the displayed test payment method. The isolated server
 * independently requires Google's testPurchase proof before granting access. */
export function googleLicenseTestingStore<P extends NativePurchase>(sdk: NativePurchaseApi<P>, options: {
  enabled: boolean; platform: string; environment: AppEnvironment;
}): NativePurchaseApi<P> {
  const requireIsolatedBuild = () => {
    const environment = options.environment;
    if (options.enabled !== true || options.platform !== 'android' || environment.review !== true
      || environment.apiBase !== 'https://testing.baristajobmatch.com/api'
      || environment.supabaseUrl !== 'https://iqtpsxxlpncaeabbcxht.supabase.co'
      || environment.publishableKey !== 'sb_publishable_470rDNz5G4PrUD5mvMu4Eg_LPcLOM4x') {
      throw new Error('Google Play testing requires the isolated Android test build.');
    }
  };
  requireIsolatedBuild();
  return {
    ...sdk,
    async initConnection() { requireIsolatedBuild(); return sdk.initConnection(); },
    async requestPurchase(input) {
      requireIsolatedBuild();
      if (input.type !== 'subs' || !input.request?.google || input.request.apple) {
        throw new Error('The isolated Android test build requires a Google Play subscription.');
      }
      return sdk.requestPurchase(input);
    },
    async restorePurchases() { requireIsolatedBuild(); return sdk.restorePurchases(); },
  };
}
