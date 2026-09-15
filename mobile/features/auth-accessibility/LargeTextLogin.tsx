import { useEffect, useRef } from 'react';
import { ActivityIndicator, Image, Keyboard, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';

type Props = {
  email: string;
  password: string;
  passwordVisible: boolean;
  loading: boolean;
  socialLoading: 'google' | 'apple' | null;
  onEmail: (value: string) => void;
  onPassword: (value: string) => void;
  onTogglePassword: () => void;
  onLogin: () => void;
  onProvider: (provider: 'google' | 'apple') => void;
  onForgotPassword: () => void;
  onCreateAccount: () => void;
};

/** A naturally sized version of the existing form for enlarged system text.
 * Authentication, duplicate-submit protection and routing remain with its caller.
 */
export function LargeTextLogin(props: Props) {
  const insets = useSafeAreaInsets();
  const { fontScale } = useWindowDimensions();
  const passwordInput = useRef<TextInput>(null);
  const scroll = useRef<ScrollView>(null);
  const positions = useRef({ email: 0, password: 0 });
  const focusedField = useRef<'email' | 'password' | null>(null);
  const revealField = () => {
    const field = focusedField.current;
    if (field) scroll.current?.scrollTo({ y: Math.max(0, positions.current[field] - 16), animated: false });
  };
  useEffect(() => {
    const subscription = Keyboard.addListener('keyboardDidShow', revealField);
    return () => subscription.remove();
  }, []);
  const focus = (field: 'email' | 'password') => {
    focusedField.current = field;
    requestAnimationFrame(revealField);
  };
  const busy = props.loading || props.socialLoading !== null;
  return <KeyboardAvoidingView style={[styles.page, { paddingTop: insets.top, paddingBottom: insets.bottom }]} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
    <StatusBar style="dark" />
    <ScrollView ref={scroll} contentContainerStyle={[styles.content, { paddingTop: 20, paddingBottom: 24 }]}
      keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" contentInsetAdjustmentBehavior="never">
      <Image accessible={false} source={require('../../assets/brand-mark.png')} style={styles.logo} resizeMode="contain" />
      <Text style={styles.brand}>Barista<Text style={styles.accent}>Match</Text></Text>
      <Text accessibilityRole="header" style={[styles.heading, fontScale > 2.5 && styles.compactHeading]}>Welcome back.</Text>
      <Text style={styles.copy}>Where cafés meet baristas.</Text>

      <Text style={styles.label}>Email</Text>
      <TextInput accessibilityLabel="Email" placeholder="Enter your email" placeholderTextColor="#77706a"
        onLayout={event => { positions.current.email = event.nativeEvent.layout.y; }} onFocus={() => focus('email')}
        value={props.email} onChangeText={props.onEmail} editable={!busy} style={styles.input}
        autoCapitalize="none" autoCorrect={false} autoComplete="email" textContentType="emailAddress"
        keyboardType="email-address" returnKeyType="next" submitBehavior="submit"
        onSubmitEditing={() => passwordInput.current?.focus()} />
      <Text style={styles.label}>Password</Text>
      <TextInput ref={passwordInput} accessibilityLabel="Password" placeholder="Password" placeholderTextColor="#77706a"
        onLayout={event => { positions.current.password = event.nativeEvent.layout.y; }} onFocus={() => focus('password')}
        value={props.password} onChangeText={props.onPassword} editable={!busy} style={styles.input}
        autoCapitalize="none" autoCorrect={false} autoComplete="current-password" textContentType="password"
        secureTextEntry={!props.passwordVisible} returnKeyType="go" onSubmitEditing={props.onLogin} />
      <Pressable accessibilityRole="button" disabled={busy} onPress={props.onTogglePassword} style={styles.link}>
        <Text style={styles.linkText}>{props.passwordVisible ? 'Hide password' : 'Show password'}</Text>
      </Pressable>
      <Pressable accessibilityRole="link" disabled={busy} onPress={props.onForgotPassword} style={styles.link}>
        <Text style={styles.linkText}>Forgot password?</Text>
      </Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel="Log in" accessibilityState={{ disabled: busy, busy: props.loading }}
        disabled={busy} onPress={props.onLogin} style={[styles.primary, busy && styles.disabled]}>
        {props.loading ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryText}>Log in</Text>}
      </Pressable>
      <Text style={styles.separator}>or continue with</Text>
      {(['google', 'apple'] as const).map(provider => <Pressable key={provider} accessibilityRole="button"
        accessibilityLabel={`Continue with ${provider === 'google' ? 'Google' : 'Apple'}`}
        accessibilityState={{ disabled: busy, busy: props.socialLoading === provider }} disabled={busy}
        onPress={() => props.onProvider(provider)} style={[styles.social, busy && styles.disabled]}>
        {props.socialLoading === provider ? <ActivityIndicator color="#321708" /> : <Image accessible={false}
          source={provider === 'google' ? require('../../assets/google-sign-in.png') : require('../../assets/apple-sign-in.png')}
          style={styles.socialIcon} resizeMode="contain" />}
        <Text style={styles.socialText}>{provider === 'google' ? 'Google' : 'Apple'}</Text>
      </Pressable>)}
      <Pressable accessibilityRole="link" accessibilityLabel="Create an account" disabled={busy}
        onPress={props.onCreateAccount} style={styles.link}>
        <Text style={styles.copy}>New here? <Text style={styles.linkText}>Create an account</Text></Text>
      </Pressable>
    </ScrollView>
  </KeyboardAvoidingView>;
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: '#fffaf4' },
  content: { flexGrow: 1, paddingHorizontal: 24, gap: 12 },
  logo: { width: 64, height: 64 },
  brand: { color: '#321708', fontFamily: Platform.OS === 'ios' ? 'Georgia' : 'serif', fontWeight: '700', fontSize: 23 },
  accent: { color: '#a95820' },
  heading: { color: '#321708', fontSize: 28, fontWeight: '700', marginTop: 12 },
  compactHeading: { fontSize: 20 },
  copy: { color: '#746a61', fontSize: 16 },
  label: { color: '#321708', fontWeight: '700', fontSize: 16, marginTop: 8 },
  input: { minHeight: 52, paddingVertical: 14, paddingHorizontal: 14, borderWidth: 1, borderColor: '#ded7d1', borderRadius: 12, color: '#17110d', backgroundColor: '#fff', fontSize: 18 },
  link: { minHeight: 48, justifyContent: 'center', paddingVertical: 10 },
  linkText: { color: '#a95820', fontSize: 16, fontWeight: '700' },
  primary: { minHeight: 52, padding: 16, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: '#a95820' },
  primaryText: { color: '#fff', fontSize: 18, fontWeight: '700', textAlign: 'center' },
  separator: { color: '#746a61', fontSize: 16, textAlign: 'center', marginVertical: 8 },
  social: { minHeight: 52, padding: 16, borderWidth: 1, borderColor: '#ded7d1', borderRadius: 12, backgroundColor: '#fff', flexDirection: 'row', alignItems: 'center', gap: 16 },
  socialIcon: { width: 26, height: 26, flexShrink: 0 },
  socialText: { flex: 1, color: '#321708', fontSize: 18, fontWeight: '600' },
  disabled: { opacity: 0.55 },
});
