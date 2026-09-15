import { Pressable, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { getAppEnvironment } from './environment';

export function ReviewModeBanner() {
  if (!getAppEnvironment().review) return null;
  return <View style={styles.banner}>
    <Text style={styles.copy}>Test mode · Isolated accounts</Text>
    <Pressable accessibilityRole="button" accessibilityLabel="Test mode information and exit" onPress={() => router.push('/review-mode')} style={styles.info}><Text style={styles.link}>Info / Exit</Text></Pressable>
  </View>;
}

export function ReviewModeEntry() {
  const insets = useSafeAreaInsets();
  if (getAppEnvironment().review) return null;
  return <Pressable accessibilityRole="button" onPress={() => router.push('/review-mode')} style={[styles.entry, { top: insets.top + 4 }]}><Text style={styles.entryText}>App review</Text></Pressable>;
}
const styles = StyleSheet.create({
  banner: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', backgroundColor: '#f9e7cf', paddingHorizontal: 16 },
  copy: { fontSize: 14, fontWeight: '700', color: '#321708', flexShrink: 1, paddingVertical: 10 },
  info: { minHeight: 44, justifyContent: 'center', padding: 10 },
  link: { fontSize: 14, fontWeight: '700', color: '#7b3d16' },
  entry: { position: 'absolute', right: 16, minHeight: 44, justifyContent: 'center', paddingHorizontal: 12, borderRadius: 22, backgroundColor: '#321708cc' },
  entryText: { color: '#fff9f3', fontSize: 14, fontWeight: '700' },
});
