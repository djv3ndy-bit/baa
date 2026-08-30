import { useEffect } from 'react';
import { Stack, usePathname } from 'expo-router';
import { Platform } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { AppErrorBoundary } from '@/components/AppErrorBoundary';
import { listenForPhoneNotifications, registerForPhoneNotifications } from '@/lib/pushNotifications';
import { supabase } from '@/lib/supabase';

export default function RootLayout() {
  const pathname=usePathname();
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
      fetch('https://www.baristajobmatch.com/api/analytics',{method:'POST',headers:{Authorization:`Bearer ${data.session.access_token}`,'Content-Type':'application/json'},body:JSON.stringify({channel:'app',platform:Platform.OS,path:pathname||'/'})}).catch(()=>{});
    }).catch(()=>{});
    return()=>{cancelled=true};
  },[pathname]);
  return (
    <AppErrorBoundary>
      <StatusBar style="dark" />
      <Stack screenOptions={{ headerShown: false, animation: 'fade' }} />
    </AppErrorBoundary>
  );
}
