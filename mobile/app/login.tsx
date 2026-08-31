import { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Image, KeyboardAvoidingView, Linking, Platform, Pressable, SafeAreaView, StyleSheet, Text as NativeText, TextInput, TextProps, useWindowDimensions, View } from 'react-native';
import { router } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { supabase } from '@/lib/supabase';

const oauthAppCallback = 'baristamatch://auth/callback';
const oauthRedirect = 'https://www.baristajobmatch.com/mobile-auth-callback.html';
const oauthStart = 'https://www.baristajobmatch.com/mobile-auth-start.html';

WebBrowser.maybeCompleteAuthSession();

function Text(props: TextProps) {
  return <NativeText maxFontSizeMultiplier={1.5} {...props} />;
}

function readOAuthParams(url: string) {
  const encoded = url.includes('#') ? url.split('#')[1] : url.split('?')[1];
  return new URLSearchParams(encoded || '');
}

export default function LoginScreen() {
  const { width, height } = useWindowDimensions();
  const compact = height < 740 || width < 360;
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [loading, setLoading] = useState(false);
  const [socialLoading, setSocialLoading] = useState<'google' | 'apple' | null>(null);

  async function routeSignedIn(userId:string,knownRole?:string|null){const role=knownRole||(await supabase.from('profiles').select('role').eq('id',userId).maybeSingle()).data?.role;if(role==='cafe_owner_manager')await supabase.rpc('ensure_cafe_subscription');router.replace('/home')}

  useEffect(() => {
    const subscription = Linking.addEventListener('url', ({ url }) => handleOAuth(url));
    Linking.getInitialURL().then(handleOAuth);
    return () => subscription.remove();
  }, []);

  async function handleOAuth(url: string | null) {
    if (!url?.startsWith(oauthAppCallback)) return;
    const params = readOAuthParams(url);
    const errorDescription = params.get('error_description');
    if (errorDescription) {
      setSocialLoading(null);
      return Alert.alert('Sign-in failed', decodeURIComponent(errorDescription));
    }
    const accessToken = params.get('access_token');
    const refreshToken = params.get('refresh_token');
    if (!accessToken || !refreshToken) {
      setSocialLoading(null);
      return Alert.alert('Sign-in failed', 'The sign-in response was incomplete. Please try again.');
    }
    const { data, error } = await supabase.auth.setSession({ access_token: accessToken, refresh_token: refreshToken });
    setSocialLoading(null);
    if (error) return Alert.alert('Sign-in failed', error.message);
    if (!data.user) return;
    const { data: existingProfile, error: profileError } = await supabase.from('profiles').select('id,role').eq('id', data.user.id).maybeSingle();
    if (profileError) return Alert.alert('Could not finish signing in', 'Check your connection and try again.');
    if (existingProfile) return routeSignedIn(data.user.id,existingProfile.role);
    const fullName = String(data.user.user_metadata?.full_name || data.user.user_metadata?.name || '').trim();
    Alert.alert('How will you use BaristaMatch?', 'Choose your account type to finish setting up your profile.', [
      { text: 'I am a barista', onPress: () => createSocialProfile(data.user!.id, 'barista', fullName) },
      { text: 'I manage a café', onPress: () => createSocialProfile(data.user!.id, 'cafe_owner_manager', fullName) },
    ]);
  }

  async function createSocialProfile(userId: string, role: 'barista' | 'cafe_owner_manager', name: string) {
    const isCafe = role === 'cafe_owner_manager';
    const { error } = await supabase.from('profiles').upsert({
      id: userId,
      role,
      display_name: isCafe ? null : (name || null),
      cafe_name: isCafe ? (name || null) : null,
    }, { onConflict: 'id' });
    if (error) return Alert.alert('Could not finish your profile', error.message);
    if(isCafe)await supabase.rpc('ensure_cafe_subscription');
    router.replace('/home');
  }

  async function signIn() {
    if (!email.trim() || !password) return Alert.alert('Missing information', 'Enter your email and password.');
    setLoading(true);
    try {
      const { data,error } = await supabase.auth.signInWithPassword({ email: email.trim().toLowerCase(), password });
      if (error) return Alert.alert('Unable to log in', error.message === 'Invalid login credentials' ? 'The email or password is incorrect.' : error.message);
      if(data.user)await routeSignedIn(data.user.id);
    } catch {
      Alert.alert('Connection problem', 'Check your internet connection and try again.');
    } finally {
      setLoading(false);
    }
  }

  async function signInWithProvider(provider: 'google' | 'apple') {
    setSocialLoading(provider);
    try {
      const { data, error } = await supabase.auth.signInWithOAuth({ provider, options: { redirectTo: oauthRedirect, skipBrowserRedirect: true } });
      if (error || !data.url) {
        return Alert.alert(`${provider === 'google' ? 'Google' : 'Apple'} sign-in unavailable`, error?.message || 'Please try again.');
      }
      const brandedAuthUrl = `${oauthStart}#${encodeURIComponent(data.url)}`;
      const result = await WebBrowser.openAuthSessionAsync(brandedAuthUrl, oauthAppCallback, { preferEphemeralSession: false });
      if (result.type === 'success') await handleOAuth(result.url);
    } catch {
      Alert.alert(`${provider === 'google' ? 'Google' : 'Apple'} sign-in unavailable`, 'Unable to open the secure sign-in page.');
    } finally {
      setSocialLoading(null);
    }
  }

  const busy = loading || socialLoading !== null;

  return (
    <SafeAreaView style={styles.safe}>
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={styles.page}>
          <View style={[styles.hero, { flexBasis: compact ? '37%' : '41%' }, compact && styles.heroCompact]}>
            <View style={styles.heroGlow} />
            <Image source={require('../assets/website-favicon.png')} resizeMode="contain" style={[styles.logo, compact && styles.logoCompact]} />
            <Text adjustsFontSizeToFit numberOfLines={1} style={[styles.brand, compact && styles.brandCompact]}>Barista<Text style={styles.brandAccent}>Match</Text></Text>
            <Text style={[styles.tagline, compact && styles.taglineCompact]}>Where cafés meet baristas.</Text>
            <View style={[styles.accentLine, compact && styles.accentLineCompact]} />
          </View>

          <View style={[styles.sheet, compact && styles.sheetCompact]}>
            <View style={[styles.handle, compact && styles.handleCompact]} />
            <Text style={[styles.label, compact && styles.labelCompact]}>Email</Text>
            <View style={[styles.inputShell, compact && styles.inputShellCompact]}>
              <Text style={styles.fieldIcon}>✉</Text>
              <TextInput allowFontScaling={false} maxFontSizeMultiplier={1} autoCapitalize="none" autoCorrect={false} autoComplete="email" keyboardType="email-address" returnKeyType="next" textContentType="emailAddress" value={email} onChangeText={setEmail} style={styles.input} placeholder="Enter your email" placeholderTextColor="#8b8885" />
            </View>

            <Text style={[styles.label, compact && styles.labelCompact]}>Password</Text>
            <View style={[styles.inputShell, compact && styles.inputShellCompact]}>
              <View style={styles.lockIcon}><View style={styles.lockShackle} /><View style={styles.lockBody} /></View>
              <TextInput allowFontScaling={false} maxFontSizeMultiplier={1} secureTextEntry={!passwordVisible} autoComplete="current-password" returnKeyType="go" textContentType="password" onSubmitEditing={signIn} value={password} onChangeText={setPassword} style={styles.input} placeholder="Enter your password" placeholderTextColor="#8b8885" />
              <Pressable accessibilityRole="button" accessibilityLabel={passwordVisible ? 'Hide password' : 'Show password'} onPress={() => setPasswordVisible(value => !value)} style={styles.eyeButton}>
                <View style={styles.eye}><View style={styles.eyePupil} /></View>
              </Pressable>
            </View>

            <Pressable accessibilityRole="link" onPress={() => router.push('/forgot-password')} style={styles.forgotButton}><Text style={styles.forgotText}>Forgot password?</Text></Pressable>

            <Pressable onPress={signIn} disabled={busy} style={({ pressed }) => [styles.primary, compact && styles.primaryCompact, pressed && styles.pressed, busy && styles.disabled]}>
              {loading ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryText}>Log in</Text>}
            </Pressable>

            <View style={[styles.divider, compact && styles.dividerCompact]}><View style={styles.dividerLine} /><Text style={styles.or}>or</Text><View style={styles.dividerLine} /></View>
            <View style={styles.socialRow}>
              <Pressable accessibilityRole="button" accessibilityLabel="Continue with Google" onPress={() => signInWithProvider('google')} disabled={busy} style={({ pressed }) => [styles.socialButton, compact && styles.socialButtonCompact, pressed && styles.pressed, busy && styles.disabled]}>
                {socialLoading === 'google' ? <ActivityIndicator color="#321708" /> : <GoogleMark />}
                <Text numberOfLines={1} style={styles.socialText}>Continue with Google</Text>
              </Pressable>
              <Pressable accessibilityRole="button" accessibilityLabel="Continue with Apple" onPress={() => signInWithProvider('apple')} disabled={busy} style={({ pressed }) => [styles.socialButton, compact && styles.socialButtonCompact, pressed && styles.pressed, busy && styles.disabled]}>
                {socialLoading === 'apple' ? <ActivityIndicator color="#111" /> : <Text style={styles.appleMark}></Text>}
                <Text numberOfLines={1} style={styles.socialText}>Continue with Apple</Text>
              </Pressable>
            </View>
            <Pressable accessibilityRole="link" onPress={() => router.push('/signup')} style={[styles.createButton, compact && styles.createButtonCompact]}><Text style={styles.createText}>Create an account</Text></Pressable>
          </View>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function GoogleMark() {
  return (
    <View accessibilityElementsHidden style={styles.googleMark}>
      <Text style={[styles.googlePart, styles.googleBlue]}>G</Text>
      <View style={styles.googleWhiteCutout} />
      <View style={styles.googleBar} />
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#fff4e8' }, flex: { flex: 1 }, page: { flex: 1, backgroundColor: '#fff4e8', overflow: 'hidden' },
  hero: { alignItems: 'center', justifyContent: 'center', paddingTop: 16, paddingBottom: 40, overflow: 'hidden' },
  heroCompact: { paddingTop: 6, paddingBottom: 28 },
  heroGlow: { position: 'absolute', width: 520, height: 320, borderRadius: 260, bottom: -205, backgroundColor: '#f4dcc6', opacity: 0.48 },
  logo: { width: 90, height: 90, marginBottom: 5 },
  logoCompact: { width: 70, height: 70, marginBottom: 1 },
  brand: { color: '#4a2412', fontFamily: Platform.OS === 'ios' ? 'Georgia' : 'serif', fontWeight: '700', fontSize: 34, letterSpacing: -1 },
  brandCompact: { fontSize: 29, letterSpacing: -.7, paddingHorizontal: 16 },
  brandAccent: { color: '#b86525' }, tagline: { marginTop: 6, color: '#2f211a', fontSize: 16, fontWeight: '500' },
  taglineCompact: { marginTop: 3, fontSize: 14 },
  accentLine: { width: 72, height: 3, borderRadius: 3, backgroundColor: '#b86525', marginTop: 16 },
  accentLineCompact: { width: 68, marginTop: 12 },
  sheet: { flex: 1, marginTop: -24, backgroundColor: '#fff', borderTopLeftRadius: 30, borderTopRightRadius: 30, paddingHorizontal: 26, paddingTop: 12, paddingBottom: 12, shadowColor: '#321708', shadowOpacity: 0.08, shadowRadius: 20, shadowOffset: { width: 0, height: -6 } },
  sheetCompact: { marginTop: -22, paddingHorizontal: 20, paddingTop: 10, paddingBottom: 8, borderTopLeftRadius: 26, borderTopRightRadius: 26 },
  handle: { width: 48, height: 5, borderRadius: 5, alignSelf: 'center', backgroundColor: '#c9c7c5', marginBottom: 14 },
  handleCompact: { width: 44, height: 4, marginBottom: 10 },
  label: { color: '#1e1b19', fontSize: 15, fontWeight: '700', marginBottom: 7, marginTop: 4 },
  labelCompact: { fontSize: 14, marginBottom: 5, marginTop: 2 },
  inputShell: { height: 52, borderWidth: 1, borderColor: '#d7d4d1', borderRadius: 10, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, marginBottom: 10 },
  inputShellCompact: { height: 48, paddingHorizontal: 10, marginBottom: 8 },
  fieldIcon: { width: 31, color: '#a85216', fontSize: 22, textAlign: 'center' }, input: { flex: 1, height: '100%', paddingHorizontal: 10, color: '#231913', fontSize: 16 },
  lockIcon: { width: 31, height: 25, alignItems: 'center', justifyContent: 'flex-end' }, lockShackle: { position: 'absolute', top: 1, width: 12, height: 12, borderWidth: 1.8, borderColor: '#a85216', borderRadius: 7 }, lockBody: { width: 17, height: 15, borderWidth: 1.8, borderColor: '#a85216', borderRadius: 3, backgroundColor: '#fff' },
  eyeButton: { height: 44, width: 42, alignItems: 'center', justifyContent: 'center' }, eye: { width: 23, height: 15, borderWidth: 1.6, borderColor: '#3a3836', borderRadius: 14, alignItems: 'center', justifyContent: 'center' }, eyePupil: { width: 6, height: 6, borderRadius: 3, backgroundColor: '#3a3836' },
  primary: { height: 50, marginTop: 3, borderRadius: 9, backgroundColor: '#a9571f', alignItems: 'center', justifyContent: 'center' }, primaryText: { color: '#fff', fontSize: 17, fontWeight: '700' },
  primaryCompact: { height: 48, marginTop: 2 },
  divider: { flexDirection: 'row', alignItems: 'center', gap: 13, marginVertical: 14 }, dividerLine: { height: 1, flex: 1, backgroundColor: '#ddd9d5' }, or: { color: '#645d57', fontSize: 14 },
  dividerCompact: { marginVertical: 11 },
  socialRow: { flexDirection: 'row', gap: 10 }, socialButton: { flex: 1, minWidth: 0, height: 48, borderWidth: 1, borderColor: '#d5d1ce', borderRadius: 9, backgroundColor: '#fff', flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, paddingHorizontal: 6 },
  socialButtonCompact: { height: 44, gap: 5, paddingHorizontal: 5 },
  socialText: { color: '#171311', fontSize: 11, fontWeight: '600', flexShrink: 1 },
  googleMark: { width: 23, height: 23, position: 'relative', overflow: 'hidden' }, googlePart: { position: 'absolute', left: 0, top: -2, fontSize: 24, lineHeight: 27, fontWeight: '900' }, googleBlue: { color: '#4285f4' }, googleWhiteCutout: { position: 'absolute', right: 0, top: 2, width: 9, height: 9, backgroundColor: '#fff' }, googleBar: { position: 'absolute', right: 0, top: 10, width: 11, height: 4, backgroundColor: '#4285f4', borderRadius: 1 },
  appleMark: { color: '#050505', fontSize: 25, lineHeight: 27 },
  forgotButton:{alignSelf:'flex-end',paddingVertical:8},forgotText:{color:'#a44f18',fontSize:12,fontWeight:'700'},createButton: { alignSelf: 'center', paddingHorizontal: 18, paddingVertical: 12, marginTop: 6 }, createButtonCompact: { paddingVertical: 8, marginTop: 2 }, createText: { color: '#a44f18', fontSize: 16, fontWeight: '600' }, pressed: { opacity: 0.8 }, disabled: { opacity: 0.55 },
});
