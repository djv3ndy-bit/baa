import { useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { supabase } from '@/lib/supabase';

export default function Index() {
  const [message, setMessage] = useState('Opening BaristaMatch…');

  useEffect(() => {
    let active = true;
    let routed = false;
    const routeOnce = (signedIn: boolean) => {
      if (!active || routed) return;
      routed = true;
      router.replace(signedIn ? '/home' : '/login');
    };
    const timeout = setTimeout(() => routeOnce(false), 8000);
    supabase.auth.getSession()
      .then(({ data, error }) => {
        if (error) throw error;
        routeOnce(Boolean(data.session));
      })
      .catch(() => {
        if (!active) return;
        setMessage('Starting a fresh session…');
        routeOnce(false);
      });
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
