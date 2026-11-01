import type { ApprovedStorePlan } from './expoStoreGateway';

// Verified in App Store Connect: product 6810922488, group 22375740.
// This is catalog configuration, not a release flag or proof of purchase.
export const appleCafeMonthly: ApprovedStorePlan = {
  id: 'com.baristajobmatch.cafe.pro.monthly',
  provider: 'apple',
  storefront: 'US',
  prices: { USD: 9.99 },
};

// Use the real Play Console subscription and base plan IDs, matching the
// server's GOOGLE_PLAY_PRODUCT_ID / GOOGLE_PLAY_BASE_PLAN_ID. Missing or invalid
// configuration keeps Android purchases unavailable. The store and server
// independently confirm U.S. availability, monthly terms and purchase access.
export function approvedStorePlan(platform: string): ApprovedStorePlan | null {
  if (platform === 'ios') return { ...appleCafeMonthly, prices: { ...appleCafeMonthly.prices } };
  if (platform !== 'android') return null;
  const productId = process.env.EXPO_PUBLIC_GOOGLE_PLAY_PRODUCT_ID;
  const basePlanId = process.env.EXPO_PUBLIC_GOOGLE_PLAY_BASE_PLAN_ID;
  // Subscription IDs are 1–40 characters; base plan IDs follow RFC-1034.
  if (typeof productId !== 'string' || !/^[a-z0-9][a-z0-9_.]{0,39}$/.test(productId)
    || productId.startsWith('android.test') || typeof basePlanId !== 'string'
    || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(basePlanId)) return null;
  return { id: productId, basePlanId, provider: 'google', storefront: 'US', prices: { USD: 9.99 } };
}
