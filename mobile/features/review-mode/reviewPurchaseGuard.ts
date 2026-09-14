import type { NativePurchase, NativePurchaseApi } from '../native-subscription/expoStoreGateway';
import { storeResponse } from '../native-subscription/storeTimeout';

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
