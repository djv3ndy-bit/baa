import { Platform } from 'react-native';
import { authenticatedApi, requireAccountSession } from './api';
import { requestJson } from './request';
import { appEnvironmentChangePending, getAppEnvironment } from '../features/review-mode/environment';
import type { AppEnvironment } from '../features/review-mode/environmentController';

const PUBLIC_BILLING_API = 'https://baristamatch-android-baristamatch.vercel.app/api';
const SHARED_SUPABASE = 'https://lmwqrxoitraofaftpwhe.supabase.co';
const MARKETPLACE_API = 'https://www.baristajobmatch.com/api';
const REVIEW_BILLING_API = 'https://android-testing.baristajobmatch.com/api';
const REVIEW_SUPABASE = 'https://ojvjlvojvozvhktbclcg.supabase.co';

type AccountSession = { access_token: string; user: { id: string } };
type Dependencies = {
  platform: string;
  environment: () => AppEnvironment;
  environmentChangePending: () => boolean;
  publicBillingApi: () => string;
  publicRelease: () => string | undefined;
  publicKey: () => string;
  session: (expectedUserId?: string) => Promise<AccountSession>;
  regularApi: typeof authenticatedApi;
  request: typeof requestJson;
};

/** Only native billing uses this transport; marketplace and Stripe management keep their existing API. */
export function createNativeBillingApi(dependencies: Dependencies) {
  return async function nativeBillingApi<T>(path: string, body: Record<string, unknown>, method: 'GET' | 'POST' = 'POST', expectedUserId?: string): Promise<T> {
    // Preserve the existing Apple/Expo transport without reading Android configuration.
    if (dependencies.platform !== 'android') return dependencies.regularApi<T>(path, body, method, expectedUserId);

    const allowed = method === 'GET' ? path === '/native-billing?action=status'
      : method === 'POST' && (path === '/native-purchases' || /^\/native-billing\?action=(prepare|start|cancel)$/.test(path));
    if (!allowed) throw new Error('This subscription request is not supported.');
    if (!expectedUserId) throw new Error('Please reopen your account subscription settings.');
    if (dependencies.environmentChangePending()) throw new Error('The app connection is changing. Close and reopen subscription settings.');

    const environment = dependencies.environment();
    const snapshot = { ...environment };
    const publicBillingApi = environment.review ? '' : dependencies.publicBillingApi();
    const publicRelease = environment.review ? '' : dependencies.publicRelease();
    const publicKey = environment.review ? '' : dependencies.publicKey();
    const base = environment.review ? REVIEW_BILLING_API : PUBLIC_BILLING_API;
    if (environment.review
      ? environment.supabaseUrl !== REVIEW_SUPABASE || environment.apiBase !== REVIEW_BILLING_API
        || !/^sb_publishable_[A-Za-z0-9_-]+$/.test(environment.publishableKey)
      : environment.review !== false || environment.supabaseUrl !== SHARED_SUPABASE
        || environment.apiBase !== MARKETPLACE_API || publicBillingApi !== PUBLIC_BILLING_API
        || publicRelease !== 'true' || !/^sb_publishable_[A-Za-z0-9_-]+$/.test(publicKey)
        || environment.publishableKey !== publicKey) {
      throw new Error('The Android subscription connection is not configured. Please contact support.');
    }

    const checkEnvironment = () => {
      const current = dependencies.environment();
      if (dependencies.environmentChangePending() || current !== environment
        || current.review !== snapshot.review || current.supabaseUrl !== snapshot.supabaseUrl
        || current.apiBase !== snapshot.apiBase || current.publishableKey !== snapshot.publishableKey
        || (!snapshot.review && (dependencies.publicBillingApi() !== publicBillingApi
          || dependencies.publicRelease() !== publicRelease || dependencies.publicKey() !== publicKey))) {
        throw new Error('The app connection changed. Close and reopen subscription settings.');
      }
    };
    const session = await dependencies.session(expectedUserId);
    checkEnvironment();
    if (!session.access_token || session.user.id !== expectedUserId) throw new Error('The signed-in account changed. Please review the request again.');
    const result = await dependencies.request<T>(`${base}${path}`, {
      method,
      headers: { Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json' },
      ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
    });
    // Never let a late response update a different account or the next app environment.
    checkEnvironment();
    const currentSession = await dependencies.session(expectedUserId);
    checkEnvironment();
    if (!currentSession.access_token || currentSession.user.id !== expectedUserId) throw new Error('The signed-in account changed. Please review the request again.');
    return result;
  };
}

export const authenticatedNativeBillingApi = createNativeBillingApi({
  platform: Platform.OS,
  environment: getAppEnvironment,
  environmentChangePending: appEnvironmentChangePending,
  publicBillingApi: () => process.env.EXPO_PUBLIC_ANDROID_NATIVE_BILLING_API_BASE_URL || '',
  publicRelease: () => process.env.EXPO_PUBLIC_ANDROID_PUBLIC_RELEASE,
  publicKey: () => process.env.EXPO_PUBLIC_ANDROID_PUBLIC_SUPABASE_PUBLISHABLE_KEY || '',
  session: requireAccountSession,
  regularApi: authenticatedApi,
  request: requestJson,
});
