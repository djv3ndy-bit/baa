import { useEffect, useRef, useState, useCallback } from 'react';
import { ActivityIndicator, Keyboard, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { supabase } from '@/lib/supabase';
import { getCurrentContext } from '@/lib/session';
import { ConversationKeyboardView, ConversationTextInput } from '@/components/ConversationKeyboardView';

const ReviewKeyboardView = Platform.OS === 'ios' ? View : ConversationKeyboardView;

export default function ReviewLogin() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const request = useRef(false);
  const mounted = useRef(true);
  const scroll = useRef<ScrollView>(null);
  const positions = useRef({ email: 0, password: 0 });
  const focused = useRef<'email' | 'password' | null>(null);
  const revealField = () => {
    const field = focused.current;
    if (field) scroll.current?.scrollTo({ y: Math.max(0, positions.current[field] - 16), animated: false });
  };
  useEffect(() => {
    const shown = Keyboard.addListener('keyboardDidShow', () => requestAnimationFrame(revealField));
    return () => shown.remove();
  }, []);
  const focus = (field: 'email' | 'password') => { focused.current = field; requestAnimationFrame(revealField); };
  const fieldLayout = (field: 'email' | 'password', y: number) => {
    positions.current[field] = y;
    if (focused.current === field) requestAnimationFrame(revealField);
  };
  useFocusEffect(useCallback(() => { mounted.current = true; return () => { mounted.current = false; }; }, []));
  async function signIn() {
    if (request.current) return;
    Keyboard.dismiss();
    if (!email.trim() || !password) { setError('Enter your test-account email and password.'); return; }
    request.current = true; setBusy(true); setError('');
    try {
      const { data, error: authError } = await supabase.auth.signInWithPassword({ email: email.trim().toLowerCase(), password });
      if (authError || !data.user) throw new Error('Sign-in was not confirmed.');
      const context = await getCurrentContext();
      if (!context.role || context.user?.id !== data.user.id) throw new Error('The test profile is unavailable.');
      if (mounted.current) router.replace('/home');
    } catch {
      if (mounted.current) setError('Test sign-in could not finish. Check the test credentials and your connection, then try again.');
    } finally {
      request.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  return <ReviewKeyboardView style={styles.page}>
    <ScrollView ref={scroll} automaticallyAdjustKeyboardInsets={Platform.OS === 'ios'} onLayout={revealField} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag">
      <Text accessibilityRole="header" style={styles.heading}>App review sign-in</Text>
      <Text style={styles.copy}>Use the dedicated test account supplied for review. This session uses isolated test data. Purchases are available only when Apple confirms a Sandbox installation.</Text>
      <Text style={styles.label}>Test-account email</Text>
      <ConversationTextInput onFocus={() => focus('email')} onBlur={() => { focused.current = null; }} onLayout={event => fieldLayout('email', event.nativeEvent.layout.y)} testID="review-email-input" accessibilityLabel="Test-account email" value={email} onChangeText={setEmail} editable={!busy} autoCapitalize="none" autoCorrect={false} keyboardType="email-address" textContentType="username" style={styles.input} />
      <Text style={styles.label}>Test-account password</Text>
      <ConversationTextInput onFocus={() => focus('password')} onBlur={() => { focused.current = null; }} onLayout={event => fieldLayout('password', event.nativeEvent.layout.y)} testID="review-password-input" accessibilityLabel="Test-account password" value={password} onChangeText={setPassword} editable={!busy} secureTextEntry textContentType="password" returnKeyType="done" onSubmitEditing={signIn} style={styles.input} />
      {!!error && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
      <Pressable accessibilityRole="button" accessibilityState={{ disabled: busy, busy }} disabled={busy} onPress={signIn} style={styles.button}>
        {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Sign in to test account</Text>}
      </Pressable>
      <Pressable accessibilityRole="button" disabled={busy} onPress={() => router.push('/review-mode')} style={styles.secondary}><Text style={styles.link}>Test mode information and exit</Text></Pressable>
    </ScrollView>
  </ReviewKeyboardView>;
}
const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: '#fff9f3' },
  content: { flexGrow: 1, justifyContent: 'center', padding: 24, width: '100%', maxWidth: 560, alignSelf: 'center' },
  heading: { fontSize: 30, fontWeight: '700', color: '#321708', marginBottom: 12 },
  copy: { fontSize: 17, lineHeight: 25, color: '#746a61', marginBottom: 20 },
  label: { fontSize: 17, fontWeight: '700', color: '#321708', marginBottom: 8 },
  input: { minHeight: 52, padding: 14, borderWidth: 1, borderColor: '#d7cabc', borderRadius: 12, backgroundColor: '#fff', fontSize: 18, color: '#321708', marginBottom: 18 },
  error: { color: '#8c291f', fontSize: 16, marginBottom: 16 },
  button: { backgroundColor: '#a95820', minHeight: 52, padding: 15, borderRadius: 12, alignItems: 'center' },
  buttonText: { color: '#fff', fontWeight: '700', fontSize: 17 },
  secondary: { minHeight: 48, padding: 14, alignItems: 'center' },
  link: { fontSize: 16, fontWeight: '700', color: '#7b3d16', textAlign: 'center' },
});
