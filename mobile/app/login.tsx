import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Image, Keyboard, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text as NativeText, TextInput, TextProps, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router, useFocusEffect } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { supabase } from '@/lib/supabase';
import { completeMobileAuth, getCurrentContext } from '@/lib/session';
import { LOGIN_LAYOUT_METRICS, resolveLoginLayout } from '@/lib/loginLayout';

const oauthAppCallback = 'baristamatch://auth/callback';
const oauthRedirect = 'https://www.baristajobmatch.com/mobile-auth-callback.html';
const oauthStart = 'https://www.baristajobmatch.com/mobile-auth-start.html';

WebBrowser.maybeCompleteAuthSession();

function Text(props: TextProps) {
  return <NativeText maxFontSizeMultiplier={1.5} {...props} />;
}

export default function LoginScreen() {
  const { width, height, fontScale } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const [keyboardVisible, setKeyboardVisible] = useState(false);
  const [contentOverflows, setContentOverflows] = useState(false);
  const [focusedField, setFocusedField] = useState<'email' | 'password' | null>(null);
  const passwordInput = useRef<TextInput>(null);
  const layout = resolveLoginLayout({
    width,
    height,
    fontScale,
    topInset: insets.top,
    bottomInset: insets.bottom,
    keyboardVisible,
  });
  const metrics = LOGIN_LAYOUT_METRICS[layout.mode];
  const compact = layout.mode === 'compact';
  const short = layout.mode === 'short';
  const heroHeight = layout.heroHeight;
  const scrollEnabled = layout.requiresScroll || contentOverflows;
  const inputHeight = Math.max(metrics.inputHeight, metrics.inputHeight * Math.min(fontScale, 1.5));
  const hideHeroTagline = keyboardVisible && fontScale > 1.15;

  useEffect(() => {
    const show = Keyboard.addListener(Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow', () => setKeyboardVisible(true));
    const hide = Keyboard.addListener(Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide', () => setKeyboardVisible(false));
    return () => { show.remove(); hide.remove(); };
  }, []);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [loading, setLoading] = useState(false);
  const [socialLoading, setSocialLoading] = useState<'google' | 'apple' | null>(null);

  const request = useRef(false);
  const active = useRef(false);
  useFocusEffect(useCallback(() => {
    active.current = true;
    return () => { active.current = false; };
  }, []));

  async function routeSignedIn(userId: string) {
    const context = await getCurrentContext();
    if (!active.current || context.user?.id !== userId) return;
    router.replace(context.role ? '/home' : { pathname: '/signup', params: { complete: '1' } });
  }

  async function signIn() {
    if (request.current) return;
    if (!email.trim() || !password) return Alert.alert('Missing information', 'Enter your email and password.');
    request.current = true;
    setLoading(true);
    try {
      const { data, error } = await supabase.auth.signInWithPassword({ email: email.trim().toLowerCase(), password });
      if (error) throw new Error(error.message === 'Invalid login credentials' ? 'The email or password is incorrect.' : error.message);
      if (data.user) await routeSignedIn(data.user.id);
    } catch (error: any) {
      if (active.current) Alert.alert('Unable to log in', error?.message || 'Check your internet connection and try again.');
    } finally {
      request.current = false;
      setLoading(false);
    }
  }

  async function signInWithProvider(provider: 'google' | 'apple') {
    if (request.current) return;
    request.current = true;
    setSocialLoading(provider);
    try {
      const { data, error } = await supabase.auth.signInWithOAuth({ provider, options: { redirectTo: oauthRedirect, skipBrowserRedirect: true } });
      if (error || !data.url) throw new Error('provider_unavailable');
      const brandedAuthUrl = `${oauthStart}#${encodeURIComponent(data.url)}`;
      const result = await WebBrowser.openAuthSessionAsync(brandedAuthUrl, oauthAppCallback, { preferEphemeralSession: false });
      if (result.type === 'success') {
        const user = await completeMobileAuth(result.url);
        await routeSignedIn(user.id);
      }
    } catch {
      if (active.current) Alert.alert(`${provider === 'google' ? 'Google' : 'Apple'} sign-in unavailable`, 'The secure sign-in could not finish. Please try again.');
    } finally {
      request.current = false;
      setSocialLoading(null);
    }
  }

  const busy = loading || socialLoading !== null;

  return (
    <View style={styles.safe}>
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView
          style={styles.flex}
          contentContainerStyle={[styles.page, { minHeight: height }]}
          scrollEnabled={scrollEnabled}
          alwaysBounceVertical={false}
          bounces={scrollEnabled}
          overScrollMode="never"
          contentInsetAdjustmentBehavior="never"
          onContentSizeChange={(_, contentHeight) => setContentOverflows(contentHeight > height + 1)}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
          showsVerticalScrollIndicator={false}
        >
          <View style={[styles.hero, compact && styles.heroCompact, short && styles.heroShort, layout.reducedHeader && styles.heroReduced, { height: heroHeight, paddingTop: insets.top + 12 }]}>
            <Image accessible={false} source={require('../assets/login-cafe-editorial.jpg')} resizeMode="cover" style={StyleSheet.absoluteFillObject} />
            <View pointerEvents="none" style={styles.heroShade} />
            <View style={[styles.brandBlock, compact && styles.brandBlockCompact, short && styles.brandBlockShort]}>
              {!layout.reducedHeader && <Image accessible={false} source={require('../assets/brand-mark.png')} resizeMode="contain" style={[styles.logo, compact && styles.logoCompact, short && styles.logoShort]} />}
              <Text accessibilityRole="header" adjustsFontSizeToFit numberOfLines={1} style={[styles.brand, compact && styles.brandCompact, short && styles.brandShort]}>
                Barista<Text style={styles.brandAccent}>Match</Text>
              </Text>
              {!hideHeroTagline && <Text style={[styles.tagline, compact && styles.taglineCompact, short && styles.taglineShort]}>Where cafés meet baristas.</Text>}
            </View>
          </View>

          <View style={[styles.sheet, compact && styles.sheetCompact, short && styles.sheetShort, { marginTop: -metrics.overlap, paddingBottom: Math.max(insets.bottom, 16) }]}>
            <View style={styles.form}>
              <Text accessibilityRole="header" style={[styles.heading, compact && styles.headingCompact, short && styles.headingShort]}>Welcome back.</Text>
              <Text style={[styles.subtitle, compact && styles.subtitleCompact, short && styles.subtitleShort]}>Where cafés meet baristas.</Text>

              <Text style={[styles.label, compact && styles.labelCompact, short && styles.labelShort]}>Email</Text>
              <View style={[styles.inputShell, compact && styles.inputShellCompact, short && styles.inputShellShort, { minHeight: inputHeight }, focusedField === 'email' && styles.inputFocused]}>
                <View accessible={false} style={styles.fieldIcon}><View style={styles.envelope}><View style={styles.envelopeFlap} /></View></View>
                <TextInput
                  accessibilityLabel="Email"
                  editable={!busy}
                  maxFontSizeMultiplier={1.5}
                  autoCapitalize="none"
                  autoCorrect={false}
                  autoComplete="email"
                  keyboardType="email-address"
                  returnKeyType="next"
                  submitBehavior="submit"
                  textContentType="emailAddress"
                  onSubmitEditing={() => passwordInput.current?.focus()}
                  onFocus={() => setFocusedField('email')}
                  onBlur={() => setFocusedField(null)}
                  value={email}
                  onChangeText={setEmail}
                  style={styles.input}
                  placeholder="Enter your email"
                  placeholderTextColor="#77706a"
                />
              </View>

              <Text style={[styles.label, styles.passwordLabel, compact && styles.labelCompact, compact && styles.passwordLabelCompact, short && styles.labelShort, short && styles.passwordLabelShort]}>Password</Text>
              <View style={[styles.inputShell, compact && styles.inputShellCompact, short && styles.inputShellShort, { minHeight: inputHeight }, focusedField === 'password' && styles.inputFocused]}>
                <View accessible={false} style={styles.fieldIcon}><View style={styles.lockShackle} /><View style={styles.lockBody} /></View>
                <TextInput
                  ref={passwordInput}
                  accessibilityLabel="Password"
                  editable={!busy}
                  maxFontSizeMultiplier={1.5}
                  autoCapitalize="none"
                  autoCorrect={false}
                  secureTextEntry={!passwordVisible}
                  autoComplete="current-password"
                  returnKeyType="go"
                  textContentType="password"
                  onSubmitEditing={signIn}
                  onFocus={() => setFocusedField('password')}
                  onBlur={() => setFocusedField(null)}
                  value={password}
                  onChangeText={setPassword}
                  style={styles.input}
                  placeholder="Enter your password"
                  placeholderTextColor="#77706a"
                />
                <Pressable accessibilityRole="button" accessibilityLabel={passwordVisible ? 'Hide password' : 'Show password'} disabled={busy} onPress={() => setPasswordVisible(value => !value)} style={styles.eyeButton}>
                  <View style={styles.eye}><View style={styles.eyePupil} /></View>
                </Pressable>
              </View>

              <Pressable accessibilityRole="link" disabled={busy} onPress={() => router.push('/forgot-password')} style={styles.forgotButton}>
                <Text style={styles.forgotText}>Forgot password?</Text>
              </Pressable>

              <Pressable accessibilityRole="button" accessibilityLabel="Log in" accessibilityState={{ disabled: busy, busy: loading }} onPress={signIn} disabled={busy} style={({ pressed }) => [styles.primary, compact && styles.primaryCompact, short && styles.primaryShort, pressed && styles.pressed, busy && styles.disabled]}>
                {loading ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryText}>Log in</Text>}
              </Pressable>

              <View style={[styles.divider, compact && styles.dividerCompact, short && styles.dividerShort]}><View style={styles.dividerLine} /><Text style={styles.or}>or continue with</Text><View style={styles.dividerLine} /></View>
              <View style={styles.socialRow}>
                <Pressable accessibilityRole="button" accessibilityLabel="Continue with Google" accessibilityState={{ disabled: busy, busy: socialLoading === 'google' }} onPress={() => signInWithProvider('google')} disabled={busy} style={({ pressed }) => [styles.socialButton, compact && styles.socialButtonCompact, short && styles.socialButtonShort, pressed && styles.pressed, busy && styles.disabled]}>
                  {socialLoading === 'google' ? <ActivityIndicator color="#321708" /> : <Image accessible={false} source={require('../assets/google-sign-in.png')} style={styles.socialMark} />}
                  <Text style={styles.socialText}>Google</Text>
                </Pressable>
                <Pressable accessibilityRole="button" accessibilityLabel="Continue with Apple" accessibilityState={{ disabled: busy, busy: socialLoading === 'apple' }} onPress={() => signInWithProvider('apple')} disabled={busy} style={({ pressed }) => [styles.socialButton, compact && styles.socialButtonCompact, short && styles.socialButtonShort, pressed && styles.pressed, busy && styles.disabled]}>
                  {socialLoading === 'apple' ? <ActivityIndicator color="#111" /> : <Image accessible={false} source={require('../assets/apple-sign-in.png')} style={styles.appleMark} />}
                  <Text style={styles.socialText}>Apple</Text>
                </Pressable>
              </View>
              <Pressable accessibilityRole="link" accessibilityLabel="Create an account" disabled={busy} onPress={() => router.push('/signup')} style={[styles.createButton, compact && styles.createButtonCompact, short && styles.createButtonShort]}>
                <Text style={styles.createPrompt}>New here? <Text style={styles.createText}>Create an account</Text></Text>
              </Pressable>
            </View>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#fffaf4' },
  flex: { flex: 1 },
  page: { flexGrow: 1, backgroundColor: '#fffaf4' },
  hero: { justifyContent: 'center', paddingBottom: 30, backgroundColor: '#352114', overflow: 'hidden', flexShrink: 0 },
  heroCompact: { paddingBottom: 22 },
  heroShort: { paddingBottom: 14 },
  heroReduced: { paddingBottom: 12 },
  heroShade: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(28, 14, 6, 0.30)' },
  brandBlock: { alignItems: 'flex-start', marginHorizontal: 28, maxWidth: 440, transform: [{ translateY: -4 }] },
  brandBlockCompact: { marginHorizontal: 22 },
  brandBlockShort: { marginHorizontal: 18, transform: [{ translateY: 0 }] },
  logo: { width: 56, height: 56, marginLeft: 46, marginBottom: 2, tintColor: '#fff2df' },
  logoCompact: { width: 50, height: 50, marginLeft: 42 },
  logoShort: { width: 42, height: 42, marginLeft: 36, marginBottom: 0 },
  brand: { color: '#fff6e8', fontFamily: Platform.OS === 'ios' ? 'Georgia' : 'serif', fontWeight: '700', fontSize: 31, lineHeight: 37, letterSpacing: -1, textShadowColor: '#241307', textShadowRadius: 8, textShadowOffset: { width: 0, height: 1 } },
  brandCompact: { fontSize: 28, lineHeight: 34 },
  brandShort: { fontSize: 25, lineHeight: 31 },
  brandAccent: { color: '#e5a166' },
  tagline: { color: '#fff6e8', marginTop: 3, fontSize: 13, lineHeight: 17, fontWeight: '500', textShadowColor: '#241307', textShadowRadius: 6, textShadowOffset: { width: 0, height: 1 } },
  taglineCompact: { marginTop: 2, fontSize: 12, lineHeight: 16 },
  taglineShort: { marginTop: 1, fontSize: 11, lineHeight: 15 },
  sheet: { flexGrow: 1, backgroundColor: '#fffaf4', borderTopLeftRadius: 30, borderTopRightRadius: 30, paddingHorizontal: 26, paddingTop: 20, justifyContent: 'flex-start' },
  sheetCompact: { paddingHorizontal: 22, paddingTop: 16, borderTopLeftRadius: 28, borderTopRightRadius: 28 },
  sheetShort: { paddingHorizontal: 18, paddingTop: 12, borderTopLeftRadius: 24, borderTopRightRadius: 24 },
  form: { width: '100%', maxWidth: 440, alignSelf: 'center' },
  heading: { color: '#351b0d', fontFamily: Platform.OS === 'ios' ? 'Georgia' : 'serif', fontSize: 38, lineHeight: 43, fontWeight: '700', letterSpacing: -1.1 },
  headingCompact: { fontSize: 34, lineHeight: 39 },
  headingShort: { fontSize: 30, lineHeight: 36, letterSpacing: -0.8 },
  subtitle: { color: '#706055', fontSize: 17, lineHeight: 21, marginTop: 2, marginBottom: 14 },
  subtitleCompact: { fontSize: 16, lineHeight: 20, marginBottom: 10 },
  subtitleShort: { fontSize: 15, lineHeight: 19, marginTop: 1, marginBottom: 8 },
  label: { color: '#30231a', fontSize: 14, lineHeight: 18, fontWeight: '700', marginBottom: 5 },
  labelCompact: { lineHeight: 17 },
  labelShort: { fontSize: 13, lineHeight: 16, marginBottom: 4 },
  passwordLabel: { marginTop: 9 },
  passwordLabelCompact: { marginTop: 8 },
  passwordLabelShort: { marginTop: 7 },
  inputShell: { borderWidth: 1, borderColor: '#d5c8bb', borderRadius: 11, backgroundColor: '#fff', flexDirection: 'row', alignItems: 'center', paddingLeft: 12, paddingRight: 4 },
  inputShellCompact: { borderRadius: 10 },
  inputShellShort: { paddingLeft: 10, borderRadius: 10 },
  inputFocused: { borderColor: '#a45722', backgroundColor: '#fffdf9' },
  input: { flex: 1, minWidth: 0, height: '100%', paddingVertical: 0, paddingHorizontal: 10, color: '#30231a', fontSize: 16 },
  fieldIcon: { width: 22, height: 26, alignItems: 'center', justifyContent: 'center' },
  envelope: { width: 19, height: 14, borderWidth: 1.6, borderColor: '#a45620', borderRadius: 2, overflow: 'hidden' },
  envelopeFlap: { width: 12, height: 12, borderRightWidth: 1.6, borderBottomWidth: 1.6, borderColor: '#a45620', transform: [{ rotate: '45deg' }], position: 'absolute', top: -7, left: 2 },
  lockShackle: { position: 'absolute', top: 2, width: 11, height: 13, borderWidth: 1.6, borderColor: '#a45620', borderRadius: 7 },
  lockBody: { position: 'absolute', bottom: 2, width: 17, height: 15, borderWidth: 1.6, borderColor: '#a45620', borderRadius: 3, backgroundColor: '#fff' },
  eyeButton: { minHeight: 44, width: 44, alignItems: 'center', justifyContent: 'center' },
  eye: { width: 22, height: 14, borderWidth: 1.6, borderColor: '#62594f', borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  eyePupil: { width: 6, height: 6, borderRadius: 3, backgroundColor: '#62594f' },
  forgotButton: { alignSelf: 'flex-end', height: 44, justifyContent: 'center', paddingLeft: 12 },
  forgotText: { color: '#95501f', fontSize: 13, fontWeight: '600' },
  primary: { height: 50, borderRadius: 11, backgroundColor: '#b56525', alignItems: 'center', justifyContent: 'center' },
  primaryCompact: { height: 48 },
  primaryShort: { height: 46, borderRadius: 10 },
  primaryText: { color: '#fff', fontSize: 19, fontWeight: '700' },
  divider: { height: 40, flexDirection: 'row', alignItems: 'center', gap: 12 },
  dividerCompact: { height: 36 },
  dividerShort: { height: 34, gap: 10 },
  dividerLine: { height: 1, flex: 1, backgroundColor: '#d8cbbd' },
  or: { color: '#75685b', fontSize: 12 },
  socialRow: { flexDirection: 'row', gap: 10 },
  socialButton: { flex: 1, minWidth: 0, height: 48, paddingHorizontal: 8, borderWidth: 1, borderColor: '#d5c8bb', borderRadius: 11, backgroundColor: '#fff', flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 9 },
  socialButtonCompact: { height: 46, gap: 8 },
  socialButtonShort: { height: 44, borderRadius: 10, gap: 7 },
  socialMark: { width: 23, height: 23 },
  appleMark: { width: 29, height: 29 },
  socialText: { color: '#201914', fontSize: 16, fontWeight: '600', flexShrink: 1 },
  createButton: { alignSelf: 'center', minHeight: 44, maxWidth: '100%', justifyContent: 'center', paddingHorizontal: 6, paddingVertical: 4, marginTop: 5 },
  createButtonCompact: { marginTop: 2 },
  createButtonShort: { marginTop: 1 },
  createPrompt: { color: '#75685b', fontSize: 14, lineHeight: 18, textAlign: 'center' },
  createText: { color: '#95501f', fontWeight: '700' },
  pressed: { opacity: 0.8 },
  disabled: { opacity: 0.55 },
});
