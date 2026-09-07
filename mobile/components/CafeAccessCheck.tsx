import { ActivityIndicator, Pressable, SafeAreaView, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';

export function CafeAccessCheck({ error, retry }: { error: string; retry: () => Promise<void> }) {
  return <SafeAreaView style={styles.safe}><View style={styles.content}>
    {error ? <><Text accessibilityRole="alert" style={styles.copy}>{error}</Text><Pressable accessibilityRole="button" style={styles.button} onPress={() => { void retry(); }}><Text style={styles.label}>Try again</Text></Pressable><Pressable accessibilityRole="button" style={styles.button} onPress={() => router.replace('/home')}><Text style={styles.label}>Back to home</Text></Pressable></> : <><ActivityIndicator size="large" color="#b75a1d" /><Text style={styles.copy}>Checking your café account…</Text></>}
  </View></SafeAreaView>;
}
const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#fffaf3' },
  content: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 16, padding: 24 },
  copy: { color: '#746a61', textAlign: 'center', fontSize: 16, lineHeight: 24 },
  button: { minHeight: 44, padding: 12 },
  label: { color: '#a95820', fontWeight: '700', fontSize: 16 },
});
