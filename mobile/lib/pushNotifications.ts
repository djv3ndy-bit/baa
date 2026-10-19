import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { router } from 'expo-router';
import { supabase } from './supabase';
import { notificationDestination } from './notificationRouting';
import { getAppEnvironment } from '../features/review-mode/environment';
import { createAndroidFcmRegistration, isolatedAndroidFcmEnabled, publicAndroidFcmEnabled, PUBLIC_ANDROID_FCM_SCOPE } from './androidFcmRegistration';
import { androidNotificationRecipient, clearAndroidAccountNotifications } from './androidNotificationCleanup';

Notifications.setNotificationHandler({
  handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: false }),
});

export type PhoneNotificationOutcome = { status: 'enabled' | 'denied' | 'unavailable' | 'no-session'; canAskAgain?: boolean };
const TOKEN_KEY = 'baristamatch_phone_token_v1';
const registrations = new Set<Promise<PhoneNotificationOutcome>>();
const handled = new Set<string>();
const retiredAndroidNotifications = new Set<string>(), exitingAndroidOwners = new Set<string>();
const androidOwnerExitVersions = new Map<string, number>();
const androidExitListeners = new Set<(owner: string) => void>();
let androidExitVersion = 0, androidResponseVersion = 0;
function retireAndroidNotification(identifier: string) {
  retiredAndroidNotifications.add(identifier);
  if (retiredAndroidNotifications.size > 100) retiredAndroidNotifications.delete(retiredAndroidNotifications.values().next().value!);
}
function retireAndroidOwner(owner: string) {
  androidOwnerExitVersions.set(owner, ++androidExitVersion); exitingAndroidOwners.add(owner);
  for (const listener of androidExitListeners) listener(owner);
}
const projectId = () => Constants.expoConfig?.extra?.eas?.projectId ?? Constants.easConfig?.projectId;
const permissionEnabled = (permission: Notifications.NotificationPermissionsStatus) => permission.granted || permission.ios?.status === Notifications.IosAuthorizationStatus.PROVISIONAL;
const directAndroid = () => {
  if (Platform.OS !== 'android' || process.env.EXPO_PUBLIC_ANDROID_DIRECT_FCM_ENABLED !== 'true') return false;
  const environment = getAppEnvironment();
  return environment.review
    ? isolatedAndroidFcmEnabled(Platform.OS, process.env.EXPO_PUBLIC_ANDROID_DIRECT_FCM_ENABLED,
      environment, process.env.EXPO_PUBLIC_ANDROID_TEST_SUPABASE_PUBLISHABLE_KEY || '')
    : publicAndroidFcmEnabled(Platform.OS, process.env.EXPO_PUBLIC_ANDROID_DIRECT_FCM_ENABLED,
      process.env.EXPO_PUBLIC_ANDROID_PUBLIC_RELEASE, environment,
      process.env.EXPO_PUBLIC_ANDROID_PUBLIC_SUPABASE_PUBLISHABLE_KEY || '',
      process.env.EXPO_PUBLIC_ANDROID_NATIVE_BILLING_API_BASE_URL || '');
};
const androidFcm = createAndroidFcmRegistration({
  requireEnabled: directAndroid,
  registrationScope: () => getAppEnvironment().review ? undefined : PUBLIC_ANDROID_FCM_SCOPE,
  async userId() { const { data, error } = await supabase.auth.getSession(); if (error) throw new Error('Notification sign-in could not be checked.'); return data.session?.user.id || null; },
  storage: AsyncStorage,
  async channel() {
    // SDK 54 may retain an earlier Expo registration. Direct mode owns token
    // refresh from here onward; never alter the iOS/normal Expo setting.
    await Notifications.setAutoServerRegistrationEnabledAsync(false);
    return Notifications.setNotificationChannelAsync('baristamatch-alerts', { name: 'BaristaMatch alerts', importance: Notifications.AndroidImportance.HIGH, sound: 'default', vibrationPattern: [0, 250, 250, 250] });
  },
  permissions: Notifications.getPermissionsAsync,
  requestPermission: Notifications.requestPermissionsAsync,
  token: Notifications.getDevicePushTokenAsync,
  async invalidateNativeToken() { await Notifications.setAutoServerRegistrationEnabledAsync(false); await Notifications.unregisterForNotificationsAsync(); },
  async clearNotifications(owner) {
    retireAndroidOwner(owner);
    await clearAndroidAccountNotifications(owner, {
      scheduled: Notifications.getAllScheduledNotificationsAsync, presented: Notifications.getPresentedNotificationsAsync,
      cancel: Notifications.cancelScheduledNotificationAsync, dismiss: Notifications.dismissNotificationAsync,
      lastResponse: Notifications.getLastNotificationResponseAsync, clearLastResponse: Notifications.clearLastNotificationResponseAsync,
      responseVersion: () => androidResponseVersion,
      retire: retireAndroidNotification,
    });
  },
  async save(token, userId) {
    const { error } = await supabase.from('android_device_push_tokens').upsert({ fcm_token: token, user_id: userId,
      platform: 'android', firebase_project_id: 'baristamatch', package_name: 'com.baristajobmatch.app', enabled: true }, { onConflict: 'fcm_token' });
    if (error) throw new Error('Android notifications could not be registered.');
  },
  async remove(token, userId) {
    const { error } = await supabase.from('android_device_push_tokens').delete().eq('fcm_token', token).eq('user_id', userId);
    if (error) throw new Error('Android notifications could not be removed.');
  },
  tokenListener(callback) { const subscription = Notifications.addPushTokenListener(callback); return () => subscription.remove(); },
  authListener(callback) { const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => callback(session?.user.id || null)); return () => subscription.unsubscribe(); },
});

async function register(requestPermission: boolean): Promise<PhoneNotificationOutcome> {
  if (Platform.OS === 'android' && process.env.EXPO_PUBLIC_ANDROID_DIRECT_FCM_ENABLED === 'true') {
    try {
      if (!directAndroid()) throw new Error('Android notifications are unavailable.');
      const before = await supabase.auth.getSession();
      const result = await androidFcm.register(requestPermission);
      if (result.status === 'enabled' && before.data.session) {
        const { data } = await supabase.auth.getSession();
        if (data.session?.user.id === before.data.session.user.id) exitingAndroidOwners.delete(data.session.user.id);
      }
      return result;
    }
    catch { throw new Error('Android notifications could not be enabled. Please try again.'); }
  }
  if (!Device.isDevice || !['ios', 'android'].includes(Platform.OS)) return { status: 'unavailable' };
  const first = await supabase.auth.getSession();
  if (first.error) throw first.error;
  const session = first.data.session;
  if (!session?.user) return { status: 'no-session' };
  if (Platform.OS === 'android') await Notifications.setNotificationChannelAsync('baristamatch-alerts', { name: 'BaristaMatch alerts', importance: Notifications.AndroidImportance.HIGH, sound: 'default', vibrationPattern: [0, 250, 250, 250] });
  let permission = await Notifications.getPermissionsAsync();
  if (!permissionEnabled(permission) && requestPermission && permission.canAskAgain) permission = await Notifications.requestPermissionsAsync();
  if (!permissionEnabled(permission)) return { status: 'denied', canAskAgain: permission.canAskAgain };
  const project = projectId();
  if (!project) return { status: 'unavailable' };
  const token = (await Notifications.getExpoPushTokenAsync({ projectId: project })).data;
  const latest = await supabase.auth.getSession();
  if (latest.error) throw latest.error;
  if (!latest.data.session) return { status: 'no-session' };
  if (latest.data.session.user.id !== session.user.id) throw new Error('Your account changed. Open notification settings again.');
  const { error } = await supabase.from('device_push_tokens').upsert({ expo_push_token: token, user_id: session.user.id, platform: Platform.OS, enabled: true, updated_at: new Date().toISOString() }, { onConflict: 'expo_push_token' });
  if (error) throw error;
  await AsyncStorage.setItem(TOKEN_KEY, JSON.stringify({ token, userId: session.user.id }));
  return { status: 'enabled' };
}

export function registerForPhoneNotifications(options: { requestPermission?: boolean } = {}): Promise<PhoneNotificationOutcome> {
  const pending = register(options.requestPermission === true);
  registrations.add(pending);
  void pending.finally(() => registrations.delete(pending)).catch(() => {});
  return pending;
}

export async function unregisterThisDeviceNotifications(expectedUserId?: string) {
  if (Platform.OS === 'android' && process.env.EXPO_PUBLIC_ANDROID_DIRECT_FCM_ENABLED === 'true') {
    try { await androidFcm.unregister(expectedUserId); return; }
    catch { throw new Error('Android notifications could not be removed. Please try again.'); }
  }
  await Promise.allSettled([...registrations]);
  if (!Device.isDevice) return;
  const { data, error: sessionError } = await supabase.auth.getSession();
  if (sessionError) throw sessionError;
  const userId = data.session?.user.id;
  if (expectedUserId && userId !== expectedUserId) throw new Error('Your account changed. Open settings again before signing out.');
  if (!userId) return;
  let saved: { token: string; userId: string } | null = null;
  try { saved = JSON.parse(await AsyncStorage.getItem(TOKEN_KEY) || 'null'); } catch {}
  let token = saved?.userId === userId ? saved.token : '';
  if (!token) {
    const permission = await Notifications.getPermissionsAsync(), project = projectId();
    if (!permissionEnabled(permission) || !project) return;
    token = (await Notifications.getExpoPushTokenAsync({ projectId: project })).data;
  }
  const latest = await supabase.auth.getSession();
  if (latest.error) throw latest.error;
  if (latest.data.session?.user.id !== userId) throw new Error('Your account changed. Open settings again before signing out.');
  const { error } = await supabase.from('device_push_tokens').delete().eq('expo_push_token', token).eq('user_id', userId);
  if (error) throw error;
  if (saved?.userId === userId) await AsyncStorage.removeItem(TOKEN_KEY);
}

/** Notification cleanup cannot turn a confirmed account deletion into failure.
 * Keep the controller's retry handle when invalidation fails, then always run
 * the original account-bound auth-store cleanup. */
export async function clearAndroidNotificationsAfterDeletion(expectedUserId: string, clearSession: () => Promise<boolean>): Promise<boolean> {
  if (Platform.OS === 'android' && process.env.EXPO_PUBLIC_ANDROID_DIRECT_FCM_ENABLED === 'true') {
    try { await androidFcm.confirmedDeletion(expectedUserId); } catch { /* Retry at the next isolated Android startup. */ }
  }
  return clearSession();
}

export function listenForPhoneNotifications(options: { isNavigationReady?: () => boolean } = {}) {
  const direct = directAndroid();
  const stopAndroidFcm = direct ? androidFcm.listen() : () => {};
  let live = true, received = false, pending: Notifications.NotificationResponse | null = null;
  let observedUser: string | null | undefined;
  const retirePending = (owner: string) => {
    if (pending && androidNotificationRecipient(pending.notification.request) === owner) {
      retireAndroidNotification(pending.notification.request.identifier); pending = null;
    }
  };
  if (direct) androidExitListeners.add(retirePending);
  async function open(response: Notifications.NotificationResponse | null) {
    if (!live || !response) return;
    const destination = notificationDestination(response.notification.request.content.data);
    if (!destination) return;
    const key = `${response.notification.request.identifier}:${response.actionIdentifier}`;
    const owner = androidNotificationRecipient(response.notification.request);
    const exitVersion = owner ? androidOwnerExitVersions.get(owner) : undefined;
    const retired = () => direct && (retiredAndroidNotifications.has(response.notification.request.identifier)
      || !!owner && (exitingAndroidOwners.has(owner) || androidOwnerExitVersions.get(owner) !== exitVersion));
    if (retired()) { retireAndroidNotification(response.notification.request.identifier); return; }
    if (handled.has(key)) return;
    pending = response;
    // A restored Android session can resolve before the startup screen's home
    // redirect. Keep the native response until that redirect has completed.
    if (direct && options.isNavigationReady?.() === false) return;
    const { data, error } = await supabase.auth.getSession();
    if (!live || error || !data.session || pending !== response || handled.has(key) || retired()) return;
    if (direct) {
      const latest = await supabase.auth.getSession();
      if (!live || pending !== response || handled.has(key) || retired()) return;
      if (latest.error || latest.data.session?.user.id !== data.session.user.id
        || response.notification.request.content.data.recipientUserId !== latest.data.session.user.id) { pending = null; return; }
      if (options.isNavigationReady?.() === false) return;
      // A failed navigation must not consume the only cold-start response.
      try { router.push(destination as never); } catch { return; }
    }
    handled.add(key); if (handled.size > 100) handled.delete(handled.values().next().value!);
    pending = null;
    if (!direct) router.push(destination as never);
    void Notifications.clearLastNotificationResponseAsync().catch(() => {});
  }
  const initialExitVersion = androidExitVersion;
  void Notifications.getLastNotificationResponseAsync().then(response => {
    const owner = response && androidNotificationRecipient(response.notification.request);
    if (!received && !(direct && owner && (androidOwnerExitVersions.get(owner) || 0) > initialExitVersion)) return open(response);
  }).catch(() => {});
  const listener = Notifications.addNotificationResponseReceivedListener(response => { if (direct) androidResponseVersion++; received = true; void open(response).catch(() => {}); });
  const retryPending = () => { if (live && pending) void open(pending).catch(() => {}); };
  const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
    const next = session?.user.id || null;
    if (direct && observedUser && (event === 'SIGNED_OUT' || next !== observedUser)) retireAndroidOwner(observedUser);
    observedUser = next;
    if (direct && event === 'SIGNED_IN' && next) exitingAndroidOwners.delete(next);
    if ((event === 'SIGNED_IN' || (direct && event === 'INITIAL_SESSION')) && pending) setTimeout(retryPending, 0);
  });
  const stop = () => { live = false; pending = null; androidExitListeners.delete(retirePending); listener.remove(); subscription.unsubscribe(); stopAndroidFcm(); };
  return Object.assign(stop, { retryPending: () => { if (direct) retryPending(); } });
}
