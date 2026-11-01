import { useCallback, useState } from 'react';
import { ActivityIndicator, Linking, Platform, Pressable, SafeAreaView, StyleSheet, Text, View } from 'react-native';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';

import { mobileCallbackUrlFromParams, parseMobileAuthCallback } from '@/lib/authCallback';
import { completeMobileAuth, getCurrentContext } from '@/lib/session';

export default function AuthCallbackScreen() {
  const [failed, setFailed] = useState(false);
  const params = useLocalSearchParams();
  const routeUrl = mobileCallbackUrlFromParams(params);
  const [retry, setRetry] = useState(0);
  useFocusEffect(useCallback(() => {
    let active = true;
    let handled = false;
    setFailed(false);
    let timer: ReturnType<typeof setTimeout> | null = null;
    async function handleUrl(url: string | null) {
      if (!active || handled) return;
      const parsed = parseMobileAuthCallback(url);
      if (!parsed.ok && parsed.reason === 'invalid_callback') return;
      handled = true;
      if (timer) clearTimeout(timer);
      try {
        const user = await completeMobileAuth(url);
        const context = await getCurrentContext();
        if (!active) return;
        if (context.user?.id !== user.id) throw new Error('session_changed');
        router.replace(context.role ? '/home' : { pathname: '/signup', params: { complete: '1' } });
      } catch {
        if (active) setFailed(true);
      }
    }
    const subscription = Linking.addEventListener('url', event => { void handleUrl(event.url); });
    if (routeUrl) void handleUrl(routeUrl);
    void Linking.getInitialURL().then(url => {
      if (!active) return;
      void handleUrl(url);
      timer = setTimeout(() => { if (active && !handled) setFailed(true); }, 1500);
    }).catch(() => { if (active) setFailed(true); });
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
      subscription.remove();
    };
  }, [retry, routeUrl]));

  return <SafeAreaView style={styles.safe}><View style={styles.card}>
    {failed ? <>
      <Text style={styles.title}>Sign-in could not finish.</Text>
      <Text style={styles.copy}>Check your connection and retry. If the link expired, return to login and request a new one.</Text>
      <Pressable accessibilityRole="button" onPress={() => setRetry(value => value + 1)} style={styles.primary}><Text style={styles.primaryText}>Try again</Text></Pressable>
      <Pressable accessibilityRole="button" onPress={() => router.replace('/login')} style={styles.linkButton}><Text style={styles.linkText}>Return to login</Text></Pressable>
    </> : <>
      <ActivityIndicator color="#a95820" size="large" />
      <Text style={styles.title}>Finishing your sign-in…</Text>
      <Text style={styles.copy}>Keep this screen open for a moment.</Text>
    </>}
  </View></SafeAreaView>;
}

const styles = StyleSheet.create({
  safe: { flex: 1, justifyContent: 'center', padding: 24, backgroundColor: '#fff4e8' },
  card: { backgroundColor: '#fff', borderRadius: 24, padding: 28, alignItems: 'center', shadowColor: '#321708', shadowOpacity: 0.1, shadowRadius: 20, shadowOffset: { width: 0, height: 8 } },
  title: { marginTop: 18, color: '#321708', fontFamily: Platform.OS === 'ios' ? 'Georgia' : 'serif', fontSize: 27, fontWeight: '700', textAlign: 'center' },
  copy: { marginTop: 10, marginBottom: 12, color: '#746a61', fontSize: 15, lineHeight: 22, textAlign: 'center' },
  primary: { width: '100%', marginTop: 14, borderRadius: 10, paddingVertical: 15, alignItems: 'center', backgroundColor: '#a95820' },
  primaryText: { color: '#fff', fontSize: 16, fontWeight: '800' },
  secondary: { width: '100%', marginTop: 10, borderRadius: 10, paddingVertical: 15, alignItems: 'center', borderWidth: 1, borderColor: '#a95820', backgroundColor: '#fff8f2' },
  secondaryText: { color: '#7b3d16', fontSize: 16, fontWeight: '800' },
  linkButton: { marginTop: 12, padding: 10 },
  linkText: { color: '#746a61', fontSize: 15, fontWeight: '700' },
});
