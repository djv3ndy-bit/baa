import { Platform } from 'react-native';
import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { router } from 'expo-router';
import { supabase } from './supabase';

Notifications.setNotificationHandler({
  handleNotification: async () => ({shouldShowBanner:true,shouldShowList:true,shouldPlaySound:true,shouldSetBadge:false}),
});

function openNotification(response: Notifications.NotificationResponse | null){
  const route=response?.notification.request.content.data?.route;
  if(typeof route==='string'&&route.startsWith('/'))router.push(route as never);
}

export async function registerForPhoneNotifications(){
  if(!Device.isDevice)return;
  const {data:{session}}=await supabase.auth.getSession();
  if(!session?.user)return;
  if(Platform.OS==='android')await Notifications.setNotificationChannelAsync('baristamatch-alerts',{name:'BaristaMatch alerts',importance:Notifications.AndroidImportance.HIGH,sound:'default',vibrationPattern:[0,250,250,250]});
  const current=await Notifications.getPermissionsAsync();
  let status=current.status;
  if(status!=='granted')status=(await Notifications.requestPermissionsAsync()).status;
  if(status!=='granted')return;
  const projectId=Constants.expoConfig?.extra?.eas?.projectId??Constants.easConfig?.projectId;
  if(!projectId)throw new Error('Notification project is not configured.');
  const expoPushToken=(await Notifications.getExpoPushTokenAsync({projectId})).data;
  const {error}=await supabase.from('device_push_tokens').upsert({expo_push_token:expoPushToken,user_id:session.user.id,platform:Platform.OS,enabled:true,updated_at:new Date().toISOString()},{onConflict:'expo_push_token'});
  if(error)throw error;
}

export async function unregisterThisDeviceNotifications(){
  if(!Device.isDevice)return;
  const permission=await Notifications.getPermissionsAsync();
  if(permission.status!=='granted')return;
  const projectId=Constants.expoConfig?.extra?.eas?.projectId??Constants.easConfig?.projectId;
  if(!projectId)return;
  const expoPushToken=(await Notifications.getExpoPushTokenAsync({projectId})).data;
  const {error}=await supabase.from('device_push_tokens').delete().eq('expo_push_token',expoPushToken);
  if(error)throw error;
}

export function listenForPhoneNotifications(){
  Notifications.getLastNotificationResponseAsync().then(openNotification).catch(()=>{});
  const subscription=Notifications.addNotificationResponseReceivedListener(openNotification);
  return()=>subscription.remove();
}
