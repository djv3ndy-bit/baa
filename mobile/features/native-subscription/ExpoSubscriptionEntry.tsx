import { Platform } from 'react-native';
import NativeSubscriptionScreen from './NativeSubscriptionScreen';
import { ExpoStoreGateway, type NativePurchase, type NativePurchaseApi } from './expoStoreGateway';
import { approvedStorePlan } from './storeCatalog';
import type { StorePurchase } from './purchaseCoordinator';
import { getAppEnvironment } from '../review-mode/environment';
import { sandboxOnlyStore } from '../review-mode/reviewPurchaseGuard';

// This flag controls presentation only. The server independently enforces the
// saved café role, billing environment, product, access and checkout reservation.
export const nativeSubscriptionScreenEnabled = process.env.EXPO_PUBLIC_NATIVE_SUBSCRIPTIONS_ENABLED === 'true';

function createStore(onUnfinished: (purchase: StorePurchase) => void) {
  const plan = approvedStorePlan(Platform.OS);
  if (!plan) return null;
  // Load the native module only for a configured store and a verified café.
  // Its exact 5.5.1 API is checked in review/validation against SDK declarations.
  const sdk = require('expo-iap') as NativePurchaseApi<NativePurchase>;
  return new ExpoStoreGateway(getAppEnvironment().review ? sandboxOnlyStore(sdk) : sdk, plan, onUnfinished, undefined, undefined,
    process.env.EXPO_PUBLIC_BILLING_DIAGNOSTICS === 'true'
      ? event => console.info(`[BaristaMatch Store] ${event}`) : undefined);
}
export default function ExpoSubscriptionEntry() {
  return <NativeSubscriptionScreen createStore={createStore} />;
}
