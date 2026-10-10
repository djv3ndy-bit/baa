import AsyncStorage from '@react-native-async-storage/async-storage';
import { reloadAppAsync } from 'expo';
import { Platform } from 'react-native';
import { createEnvironmentController, type AppEnvironment } from './environmentController';

// Public client configuration only. Authorization remains in each environment's backend.
const appleReviewEnvironment: AppEnvironment = {
  review: true,
  supabaseUrl: 'https://iqtpsxxlpncaeabbcxht.supabase.co',
  publishableKey: 'sb_publishable_470rDNz5G4PrUD5mvMu4Eg_LPcLOM4x',
  apiBase: 'https://testing.baristajobmatch.com/api',
};
const androidReviewKey = process.env.EXPO_PUBLIC_ANDROID_TEST_SUPABASE_PUBLISHABLE_KEY || '';
const validAndroidReviewKey = /^sb_publishable_[A-Za-z0-9_-]+$/.test(androidReviewKey)
  && androidReviewKey !== appleReviewEnvironment.publishableKey;
const reviewEnvironment: AppEnvironment = Platform.OS === 'android' ? {
  review: true,
  supabaseUrl: 'https://ojvjlvojvozvhktbclcg.supabase.co',
  publishableKey: validAndroidReviewKey ? androidReviewKey : '',
  apiBase: 'https://android-testing.baristajobmatch.com/api',
} : appleReviewEnvironment;
const configuredUrl = process.env.EXPO_PUBLIC_SUPABASE_URL || '';
const configuredReview = configuredUrl.replace(/\/$/, '') === reviewEnvironment.supabaseUrl;
const configured: AppEnvironment = {
  review: configuredReview,
  supabaseUrl: configuredUrl,
  // Android review never falls back to the generic production/Apple key.
  publishableKey: Platform.OS === 'android' && configuredReview
    ? reviewEnvironment.publishableKey : process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY || '',
  apiBase: (process.env.EXPO_PUBLIC_API_BASE_URL || 'https://www.baristajobmatch.com/api').replace(/\/$/, ''),
};
if (Platform.OS === 'android') {
  if (configuredUrl.replace(/\/$/, '') === appleReviewEnvironment.supabaseUrl
    || configured.apiBase === appleReviewEnvironment.apiBase) {
    throw new Error('Android testing must not use the Apple test database or API.');
  }
  if ((configuredReview || process.env.EXPO_PUBLIC_GOOGLE_PLAY_LICENSE_TESTING === 'true')
    && (!configuredReview || configured.apiBase !== reviewEnvironment.apiBase || !validAndroidReviewKey)) {
    throw new Error('Android testing requires its dedicated test API, database and publishable key.');
  }
}
if (configured.review && configured.apiBase !== reviewEnvironment.apiBase) {
  throw new Error('The test database must use the isolated test API.');
}
if (!configured.review && configured.apiBase === reviewEnvironment.apiBase) {
  throw new Error('The isolated test API must use the test database.');
}
const controller = createEnvironmentController(AsyncStorage, configured, reviewEnvironment);
export const initializeAppEnvironment = controller.initialize;
export const getAppEnvironment = controller.get;
export const canReturnToLive = controller.canReturnToLive;
export const reviewRestartRequired = controller.restartRequired;
export const getPasswordResetRedirect = () => Platform.OS === 'android' && controller.get().review
  ? 'https://android-testing.baristajobmatch.com/reset-password'
  : 'https://www.baristajobmatch.com/reset-password';
export const getMobileAuthWebBridge = () => Platform.OS === 'android' && controller.get().review
  ? 'https://android-testing.baristajobmatch.com/mobile-auth-callback.html'
  : 'https://www.baristajobmatch.com/mobile-auth-callback.html';
export const switchAppMode = (target: 'review' | 'configured', signedOut: () => Promise<boolean>) =>
  controller.switchMode(target, signedOut, () => reloadAppAsync('BaristaMatch account environment changed'));
