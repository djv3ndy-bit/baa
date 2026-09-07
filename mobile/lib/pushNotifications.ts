import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { router } from 'expo-router';
import { supabase } from './supabase';
import { notificationDestination } from './notificationRouting';

Notifications.setNotificationHandler({
  handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: false }),
});

export type PhoneNotificationOutcome = { status: 'enabled' | 'denied' | 'unavailable' | 'no-session'; canAskAgain?: boolean };
const TOKEN_KEY = 'baristamatch_phone_token_v1';
const registrations = new Set<Promise<PhoneNotificationOutcome>>();
const handled = new Set<string>();
const projectId = () => Constants.expoConfig?.extra?.eas?.projectId ?? Constants.easConfig?.projectId;
const permissionEnabled = (permission: Notifications.NotificationPermissionsStatus) => permission.granted || permission.ios?.status === Notifications.IosAuthorizationStatus.PROVISIONAL;

async function register(requestPermission: boolean): Promise<PhoneNotificationOutcome> {
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

export function listenForPhoneNotifications() {
  let live = true, received = false, pending: Notifications.NotificationResponse | null = null;
  async function open(response: Notifications.NotificationResponse | null) {
    if (!live || !response) return;
    const destination = notificationDestination(response.notification.request.content.data);
    if (!destination) return;
    const key = `${response.notification.request.identifier}:${response.actionIdentifier}`;
    if (handled.has(key)) return;
    pending = response;
    const { data, error } = await supabase.auth.getSession();
    if (!live || error || !data.session || pending !== response || handled.has(key)) return;
    handled.add(key); if (handled.size > 100) handled.delete(handled.values().next().value!);
    pending = null;
    router.push(destination as never);
    void Notifications.clearLastNotificationResponseAsync().catch(() => {});
  }
  void Notifications.getLastNotificationResponseAsync().then(response => { if (!received) return open(response); }).catch(() => {});
  const listener = Notifications.addNotificationResponseReceivedListener(response => { received = true; void open(response).catch(() => {}); });
  const { data: { subscription } } = supabase.auth.onAuthStateChange(event => { if (event === 'SIGNED_IN' && pending) setTimeout(() => { if (live && pending) void open(pending).catch(() => {}); }, 0); });
  return () => { live = false; pending = null; listener.remove(); subscription.unsubscribe(); };
}
