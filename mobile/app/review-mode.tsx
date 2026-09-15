import { useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text } from 'react-native';
import { router } from 'expo-router';
import { supabase } from '@/lib/supabase';
import { canReturnToLive, getAppEnvironment, reviewRestartRequired, switchAppMode } from '@/features/review-mode/environment';

export default function ReviewModeScreen() {
  const review = getAppEnvironment().review;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const request = useRef(false);
  async function changeMode() {
    if (request.current) return;
    request.current = true; setBusy(true); setError('');
    try {
      await switchAppMode(review ? 'configured' : 'review', async () => {
        const { data, error: sessionError } = await supabase.auth.getSession();
        if (sessionError) throw sessionError;
        return !data.session;
      });
      setError('Close and reopen BaristaMatch to finish changing app mode.');
    } catch (error) {
      setError(reviewRestartRequired() ? 'Close and reopen BaristaMatch to finish changing app mode.' : error instanceof Error ? error.message : 'The app mode could not be changed. Please try again.');
    } finally { request.current = false; setBusy(false); }
  }
  return <ScrollView contentContainerStyle={styles.page}>
    <Text accessibilityRole="header" style={styles.heading}>{review ? 'You are in test mode' : 'App review and testing'}</Text>
    <Text style={styles.copy}>Test mode connects to dedicated review accounts and isolated test data. It does not change live accounts or subscriptions. Use only the test credentials supplied for review.</Text>
    <Text style={styles.copy}>Sign out of your current account in Settings before changing modes. The app restarts to keep the two sessions separate.</Text>
    <Text style={styles.copy}>Apple test purchases require a Sandbox installation on iOS 16 or later. Changing app mode does not change your Apple purchase account.</Text>
    {review && !canReturnToLive() && <Text style={styles.copy}>This build is for testing only. Live accounts are available in the regular app.</Text>}
    {!!error && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
    {(!review || canReturnToLive()) && <Pressable accessibilityRole="button" disabled={busy || reviewRestartRequired()} accessibilityState={{ disabled: busy || reviewRestartRequired(), busy }} onPress={changeMode} style={styles.button}>
      {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>{review ? 'Exit test mode and restart' : 'Enter test mode and restart'}</Text>}
    </Pressable>}
    <Pressable accessibilityRole="button" disabled={busy} onPress={() => router.push('/settings')} style={styles.secondary}><Text style={styles.link}>Open Settings to sign out</Text></Pressable>
    <Pressable accessibilityRole="button" disabled={busy} onPress={() => router.replace('/')} style={styles.secondary}><Text style={styles.link}>Back to BaristaMatch</Text></Pressable>
  </ScrollView>;
}
const styles = StyleSheet.create({
  page: { flexGrow: 1, justifyContent: 'center', backgroundColor: '#fff9f3', padding: 24, gap: 16 },
  heading: { color: '#321708', fontSize: 30, fontWeight: '700' },
  copy: { color: '#746a61', fontSize: 17, lineHeight: 25 },
  error: { color: '#8c291f', fontSize: 17 },
  button: { padding: 16, minHeight: 52, alignItems: 'center', borderRadius: 12, backgroundColor: '#a95820' },
  buttonText: { color: '#fff', fontSize: 17, fontWeight: '700' },
  secondary: { padding: 12, minHeight: 44, alignItems: 'center' },
  link: { color: '#7b3d16', fontSize: 17, fontWeight: '700', textAlign: 'center' },
});
