import type { ApprovedStorePlan } from './expoStoreGateway';

// Verified in App Store Connect: product 6810922488, group 22375740.
// This is catalog configuration, not a release flag or proof of purchase.
export const appleCafeMonthly: ApprovedStorePlan = {
  id: 'com.baristajobmatch.cafe.pro.monthly',
  provider: 'apple',
  storefront: 'US',
  prices: { USD: 9.99 },
};

// Google remains unavailable until its real product/base plan and U.S.-only
// availability are configured and verified. Do not invent a Play product ID.
export function approvedStorePlan(platform: string): ApprovedStorePlan | null {
  return platform === 'ios' ? { ...appleCafeMonthly, prices: { ...appleCafeMonthly.prices } } : null;
}
