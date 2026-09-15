export const sandboxRefundProduct = 'com.baristajobmatch.cafe.pro.monthly';
export const sandboxRefundAccount = 'e7d9c613-1164-43dc-9a37-bf8d5172aee5';

export function assertRefundTestContext(value: {
  platform: string; flag?: string; api?: string; database?: string;
  accountId?: string; role?: string;
}) {
  if (value.platform !== 'ios' || value.flag !== 'isolated-apple-sandbox'
    || value.api !== 'https://testing.baristajobmatch.com/api'
    || value.database !== 'https://iqtpsxxlpncaeabbcxht.supabase.co'
    || value.accountId !== sandboxRefundAccount || value.role !== 'cafe_owner_manager') {
    throw new Error('Refund probe requires the isolated test café.');
  }
}

export function assertSandboxRefundPurchase(value: {
  store?: string; environmentIOS?: string | null; productId?: string;
  purchaseState?: string; purchaseToken?: string | null; appBundleIdIOS?: string | null;
}) {
  if (value.store !== 'apple' || value.environmentIOS !== 'Sandbox'
    || value.productId !== sandboxRefundProduct || value.purchaseState !== 'purchased'
    || value.appBundleIdIOS !== 'com.baristajobmatch.app' || !value.purchaseToken) {
    throw new Error('Refund probe requires a verified Apple Sandbox purchase.');
  }
}
