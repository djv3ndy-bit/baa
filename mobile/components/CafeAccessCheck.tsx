import { ActivityIndicator, Pressable, SafeAreaView, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { dashboardPrism as prism } from '@/lib/dashboardPrism';

export function CafeAccessCheck({ error, retry, appearance }: { error: string; retry: () => Promise<void>; appearance?: 'prism' }) {
  const usePrism = appearance === 'prism';
  return <SafeAreaView style={[styles.safe, usePrism && styles.prismSafe]}><View style={styles.content}>
    {error ? <><Text accessibilityRole="alert" style={[styles.copy, usePrism && styles.prismCopy]}>{error}</Text><Pressable accessibilityRole="button" style={styles.button} onPress={() => { void retry(); }}><Text style={[styles.label, usePrism && styles.prismLabel]}>Try again</Text></Pressable><Pressable accessibilityRole="button" style={styles.button} onPress={() => router.replace('/home')}><Text style={[styles.label, usePrism && styles.prismLabel]}>Back to home</Text></Pressable></> : <><ActivityIndicator size="large" color={usePrism ? prism.ink : '#b75a1d'} /><Text style={[styles.copy, usePrism && styles.prismCopy]}>Checking your café account…</Text></>}
  </View></SafeAreaView>;
}
const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#fffaf3' },
  prismSafe: { backgroundColor: prism.background },
  prismCopy: { color: prism.muted },
  prismLabel: { color: prism.ink, fontWeight: '600' },
  content: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 16, padding: 24 },
  copy: { color: '#746a61', textAlign: 'center', fontSize: 16, lineHeight: 24 },
  button: { minHeight: 44, padding: 12 },
  label: { color: '#a95820', fontWeight: '700', fontSize: 16 },
});
