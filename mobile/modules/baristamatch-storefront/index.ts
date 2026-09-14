import { requireOptionalNativeModule } from 'expo';
import { Platform } from 'react-native';

type StorefrontModule = {
  getStorefrontCountryCode(): Promise<string | null>;
};

/**
 * Reads the current Apple App Store storefront, using ISO 3166-1 alpha-3 codes.
 * Query again when the app returns to the foreground and before checkout.
 * Unknown storefronts, unsupported platforms, and older binaries return null.
 */
export async function getStorefrontCountryCode(): Promise<string | null> {
  if (Platform.OS !== 'ios') return null;

  try {
    const nativeModule = requireOptionalNativeModule<StorefrontModule>(
      'BaristaMatchStorefront',
    );
    if (!nativeModule) return null;

    const countryCode = await nativeModule.getStorefrontCountryCode();
    return typeof countryCode === 'string' && /^[A-Z]{3}$/.test(countryCode)
      ? countryCode
      : null;
  } catch {
    return null;
  }
}
