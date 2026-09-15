import AsyncStorage from '@react-native-async-storage/async-storage';
import { reloadAppAsync } from 'expo';
import { createEnvironmentController, type AppEnvironment } from './environmentController';

// Public client configuration only. Authorization remains in each environment's backend.
const reviewEnvironment: AppEnvironment = {
  review: true,
  supabaseUrl: 'https://iqtpsxxlpncaeabbcxht.supabase.co',
  publishableKey: 'sb_publishable_470rDNz5G4PrUD5mvMu4Eg_LPcLOM4x',
  apiBase: 'https://testing.baristajobmatch.com/api',
};
const configuredUrl = process.env.EXPO_PUBLIC_SUPABASE_URL || '';
const configured: AppEnvironment = {
  review: configuredUrl.replace(/\/$/, '') === reviewEnvironment.supabaseUrl,
  supabaseUrl: configuredUrl,
  publishableKey: process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY || '',
  apiBase: (process.env.EXPO_PUBLIC_API_BASE_URL || 'https://www.baristajobmatch.com/api').replace(/\/$/, ''),
};
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
export const switchAppMode = (target: 'review' | 'configured', signedOut: () => Promise<boolean>) =>
  controller.switchMode(target, signedOut, () => reloadAppAsync('BaristaMatch account environment changed'));
