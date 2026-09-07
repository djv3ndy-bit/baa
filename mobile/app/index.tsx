import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, SafeAreaView, Text, View } from 'react-native';
import { router } from 'expo-router';
import { getCurrentContext } from '@/lib/session';

export default function Index() {
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setError(false);
    void getCurrentContext().then(({ user, role }) => {
      if (!active) return;
      router.replace(!user ? '/login' : role ? '/home' : { pathname: '/signup', params: { complete: '1' } });
    }).catch(() => { if (active) setError(true); });
    return () => { active = false; };
  }, [attempt]);
  return <SafeAreaView style={{ flex: 1, backgroundColor: '#fff4e8' }}><View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 16 }}>
    {error ? <>
      <Text style={{ color: '#321708', textAlign: 'center' }}>Your account could not be loaded. Check your connection and try again.</Text>
      <Pressable accessibilityRole="button" onPress={() => setAttempt(value => value + 1)} style={{ padding: 16, backgroundColor: '#321708', borderRadius: 12 }}><Text style={{ color: '#fff' }}>Try again</Text></Pressable>
      <Pressable accessibilityRole="button" onPress={() => router.replace('/login')} style={{ padding: 16 }}><Text>Return to login</Text></Pressable>
    </> : <><ActivityIndicator color="#321708" /><Text>Opening your account…</Text></>}
  </View></SafeAreaView>;
}
