import { useEffect, useRef } from 'react';
import { Stack, usePathname, useRootNavigationState } from 'expo-router';
import { Platform } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { AppErrorBoundary } from '@/components/AppErrorBoundary';
import { listenForPhoneNotifications, registerForPhoneNotifications } from '@/lib/pushNotifications';
import { supabase } from '@/lib/supabase';
import { authenticatedApi } from '@/lib/api';
import { AppEnvironmentGate } from '@/features/review-mode/AppEnvironmentGate';
import { ReviewModeBanner, ReviewModeEntry } from '@/features/review-mode/ReviewModeControls';
import { getAppEnvironment } from '@/features/review-mode/environment';

export default function RootLayout() {
  return <AppEnvironmentGate><ReadyRootLayout /></AppEnvironmentGate>;
}

function ReadyRootLayout() {
  const pathname=usePathname();
  const rootNavigation = useRootNavigationState();
  const notificationNavigationReady = useRef(false);
  const phoneNotifications = useRef<ReturnType<typeof listenForPhoneNotifications> | null>(null);
  notificationNavigationReady.current = !!rootNavigation?.key && !['/', '/login', '/signup', '/auth/callback'].includes(pathname);
  const isLogin = pathname === '/login';
  useEffect(() => {
    const stopListening=listenForPhoneNotifications({ isNavigationReady: () => notificationNavigationReady.current });
    phoneNotifications.current = stopListening;
    registerForPhoneNotifications().catch(error=>console.warn('Phone notification registration failed',error?.message||error));
    const {data:{subscription}}=supabase.auth.onAuthStateChange(event=>{if(event==='SIGNED_IN')registerForPhoneNotifications().catch(error=>console.warn('Phone notification registration failed',error?.message||error))});
    return()=>{stopListening();if (phoneNotifications.current === stopListening) phoneNotifications.current = null;subscription.unsubscribe()};
  }, []);
  useEffect(() => { phoneNotifications.current?.retryPending(); }, [pathname, rootNavigation?.key]);
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
      <StatusBar style={isLogin && !getAppEnvironment().review ? 'light' : 'dark'} />
      {/* Android 16 is edge-to-edge. RN's per-screen SafeAreaView is iOS-only.
          Expo Router supplies the safe-area provider. The login screen handles its own photo-header insets on both platforms. */}
      <SafeAreaView style={{ flex: 1 }} edges={getAppEnvironment().review || pathname === '/review-mode' ? ['top', 'right', 'bottom', 'left'] : Platform.OS === 'android' && !isLogin ? ['top', 'right', 'bottom', 'left'] : []}>
        <ReviewModeBanner />
        <Stack screenOptions={({ route }) => ({
          headerShown: false,
          animation: ['home', 'jobs', 'discover', 'matches', 'messages', 'profile'].includes(route.name) ? 'none' : 'fade',
        })} />
        {isLogin && <ReviewModeEntry />}
      </SafeAreaView>
    </AppErrorBoundary>
  );
}
