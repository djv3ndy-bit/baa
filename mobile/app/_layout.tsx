import { useEffect } from 'react';
import { Stack, usePathname } from 'expo-router';
import { Platform } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { AppErrorBoundary } from '@/components/AppErrorBoundary';
import { listenForPhoneNotifications, registerForPhoneNotifications } from '@/lib/pushNotifications';
import { supabase } from '@/lib/supabase';
import { authenticatedApi } from '@/lib/api';

export default function RootLayout() {
  const pathname=usePathname();
  const isLogin = pathname === '/login';
  useEffect(() => {
    const stopListening=listenForPhoneNotifications();
    registerForPhoneNotifications().catch(error=>console.warn('Phone notification registration failed',error?.message||error));
    const {data:{subscription}}=supabase.auth.onAuthStateChange(event=>{if(event==='SIGNED_IN')registerForPhoneNotifications().catch(error=>console.warn('Phone notification registration failed',error?.message||error))});
    return()=>{stopListening();subscription.unsubscribe()};
  }, []);
  useEffect(()=>{
    let cancelled=false;
    supabase.auth.getSession().then(({data})=>{
      if(cancelled||!data.session?.access_token)return;
      authenticatedApi('/analytics', {channel:'app',platform:Platform.OS,path:(pathname||'/').replace(/^\/chat\/[^/]+/, '/chat/conversation')}, 'POST', data.session.user.id).catch(()=>{});
    }).catch(()=>{});
    return()=>{cancelled=true};
  },[pathname]);
  return (
    <AppErrorBoundary>
      <StatusBar style={isLogin ? 'light' : 'dark'} />
      {/* Android 16 is edge-to-edge. RN's per-screen SafeAreaView is iOS-only.
          Expo Router supplies the safe-area provider. The login screen handles its own photo-header insets on both platforms. */}
      <SafeAreaView style={{ flex: 1 }} edges={Platform.OS === 'android' && !isLogin ? ['top', 'right', 'bottom', 'left'] : []}>
        <Stack screenOptions={{ headerShown: false, animation: 'fade' }} />
      </SafeAreaView>
    </AppErrorBoundary>
  );
}
