import { useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { supabase } from '@/lib/supabase';

export default function Index() {
  const [message, setMessage] = useState('Opening BaristaMatch…');

  useEffect(() => {
    let active = true,routed=false,hadSession=false;
    const go=(path:'/login'|'/home')=>{if(!active||routed)return;routed=true;router.replace(path)};
    const timeout=setTimeout(()=>go('/login'),8000);
    (async()=>{try{const {data,error}=await supabase.auth.getSession();if(error)throw error;const user=data.session?.user;if(!user)return go('/login');hadSession=true;const {data:profile}=await supabase.from('profiles').select('role').eq('id',user.id).maybeSingle();if(profile?.role==='cafe_owner_manager')await supabase.rpc('ensure_cafe_subscription');go('/home')}catch{if(!active)return;setMessage(hadSession?'Opening your saved session…':'Starting a fresh session…');go(hadSession?'/home':'/login')}})();
    return () => {
      active = false;
      clearTimeout(timeout);
    };
  }, []);

  return <View style={styles.center}><ActivityIndicator size="large" color="#321708" /><Text style={styles.message}>{message}</Text></View>;
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#fbf7f1' },
  message: { marginTop: 14, fontSize: 14, fontWeight: '700', color: '#746a61' },
});
