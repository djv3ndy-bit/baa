import { useEffect, useState, type PropsWithChildren } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { initializeSupabaseEnvironment } from '@/lib/supabase';

export function AppEnvironmentGate({ children }: PropsWithChildren) {
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setFailed(false);
    const timer = setTimeout(() => { if (active) setFailed(true); }, 8000);
    void initializeSupabaseEnvironment().then(() => {
      if (active) setReady(true);
    }).catch(() => { if (active) setFailed(true); }).finally(() => clearTimeout(timer));
    return () => { active = false; clearTimeout(timer); };
  }, [attempt]);
  if (ready) return children;
  return <View style={styles.page}>
    {failed ? <>
      <Text style={styles.text}>Your saved app session could not be opened. Please try again.</Text>
      <Pressable accessibilityRole="button" onPress={() => setAttempt(value => value + 1)} style={styles.button}><Text style={styles.buttonText}>Try again</Text></Pressable>
    </> : <><ActivityIndicator color="#a95820" /><Text style={styles.text}>Opening BaristaMatch…</Text></>}
  </View>;
}
const styles = StyleSheet.create({
  page: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#fff9f3', padding: 24, gap: 16 },
  text: { color: '#321708', fontSize: 17, textAlign: 'center' },
  button: { padding: 16, borderRadius: 12, backgroundColor: '#a95820' },
  buttonText: { color: '#fff', fontSize: 17, fontWeight: '700' },
});
