import { useEffect } from 'react';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { AppErrorBoundary } from '@/components/AppErrorBoundary';
import { listenForPhoneNotifications, registerForPhoneNotifications } from '@/lib/pushNotifications';
import { supabase } from '@/lib/supabase';

export default function RootLayout() {
  useEffect(() => {
    const stopListening=listenForPhoneNotifications();
    registerForPhoneNotifications().catch(error=>console.warn('Phone notification registration failed',error?.message||error));
    const {data:{subscription}}=supabase.auth.onAuthStateChange(event=>{if(event==='SIGNED_IN')registerForPhoneNotifications().catch(error=>console.warn('Phone notification registration failed',error?.message||error))});
    return()=>{stopListening();subscription.unsubscribe()};
  }, []);
  return (
    <AppErrorBoundary>
      <StatusBar style="dark" />
      <Stack screenOptions={{ headerShown: false, animation: 'fade' }} />
    </AppErrorBoundary>
  );
}
