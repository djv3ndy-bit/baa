import { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Image, KeyboardAvoidingView, Linking, Platform, Pressable, SafeAreaView, ScrollView, StyleSheet, Text, TextInput, useWindowDimensions, View } from 'react-native';
import { router } from 'expo-router';
import { supabase } from '@/lib/supabase';

const oauthRedirect = 'baristamatch://auth/callback';

function readOAuthParams(url: string) {
  const encoded = url.includes('#') ? url.split('#')[1] : url.split('?')[1];
  return new URLSearchParams(encoded || '');
}

export default function LoginScreen() {
  const { width } = useWindowDimensions();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [loading, setLoading] = useState(false);
  const [socialLoading, setSocialLoading] = useState<'google' | 'apple' | null>(null);

  useEffect(() => {
    async function handleOAuth(url: string | null) {
      if (!url?.startsWith(oauthRedirect)) return;
      const params = readOAuthParams(url);
      const errorDescription = params.get('error_description');
      if (errorDescription) {
        setSocialLoading(null);
        return Alert.alert('Sign-in failed', decodeURIComponent(errorDescription));
      }
      const accessToken = params.get('access_token');
      const refreshToken = params.get('refresh_token');
      if (!accessToken || !refreshToken) return;
      const { data, error } = await supabase.auth.setSession({ access_token: accessToken, refresh_token: refreshToken });
      setSocialLoading(null);
      if (error) return Alert.alert('Sign-in failed', error.message);
      if (!data.user) return;
      const { data: existingProfile, error: profileError } = await supabase.from('profiles').select('id').eq('id', data.user.id).maybeSingle();
      if (profileError) return Alert.alert('Could not finish signing in', 'Check your connection and try again.');
      if (existingProfile) return router.replace('/home');
      const fullName = String(data.user.user_metadata?.full_name || data.user.user_metadata?.name || '').trim();
      Alert.alert('How will you use BaristaMatch?', 'Choose your account type to finish setting up your profile.', [
        { text: 'I am a barista', onPress: () => createSocialProfile(data.user!.id, 'barista', fullName) },
        { text: 'I manage a café', onPress: () => createSocialProfile(data.user!.id, 'cafe_owner_manager', fullName) },
      ]);
    }

    const subscription = Linking.addEventListener('url', ({ url }) => handleOAuth(url));
    Linking.getInitialURL().then(handleOAuth);
    return () => subscription.remove();
  }, []);

  async function createSocialProfile(userId: string, role: 'barista' | 'cafe_owner_manager', name: string) {
    const isCafe = role === 'cafe_owner_manager';
    const { error } = await supabase.from('profiles').upsert({
      id: userId,
      role,
      display_name: isCafe ? null : (name || null),
      cafe_name: isCafe ? (name || null) : null,
    }, { onConflict: 'id' });
    if (error) return Alert.alert('Could not finish your profile', error.message);
    router.replace('/home');
  }

  async function signIn() {
    if (!email.trim() || !password) return Alert.alert('Missing information', 'Enter your email and password.');
    setLoading(true);
    try {
      const { error } = await supabase.auth.signInWithPassword({ email: email.trim().toLowerCase(), password });
      if (error) return Alert.alert('Unable to log in', error.message === 'Invalid login credentials' ? 'The email or password is incorrect.' : error.message);
      router.replace('/home');
    } catch {
      Alert.alert('Connection problem', 'Check your internet connection and try again.');
    } finally {
      setLoading(false);
    }
  }

  async function signInWithProvider(provider: 'google' | 'apple') {
    setSocialLoading(provider);
    const { data, error } = await supabase.auth.signInWithOAuth({ provider, options: { redirectTo: oauthRedirect, skipBrowserRedirect: true } });
    if (error || !data.url) {
      setSocialLoading(null);
      return Alert.alert(`${provider === 'google' ? 'Google' : 'Apple'} sign-in unavailable`, error?.message || 'Please try again.');
    }
    try {
      if (!(await Linking.canOpenURL(data.url))) throw new Error('Unsupported sign-in URL');
      await Linking.openURL(data.url);
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
        <ScrollView contentContainerStyle={styles.page} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
          <View style={styles.hero}>
            <View style={styles.heroGlow} />
            <Image source={require('../assets/website-favicon.png')} resizeMode="contain" style={styles.logo} />
            <Text style={styles.brand}>Barista <Text style={styles.brandAccent}>Job</Text> Match</Text>
            <Text style={styles.tagline}>Where cafés meet baristas.</Text>
            <View style={styles.accentLine} />
          </View>

          <View style={styles.sheet}>
            <View style={styles.handle} />
            <Text style={styles.label}>Email</Text>
            <View style={styles.inputShell}>
              <Text style={styles.fieldIcon}>✉</Text>
              <TextInput autoCapitalize="none" autoCorrect={false} autoComplete="email" keyboardType="email-address" returnKeyType="next" textContentType="emailAddress" value={email} onChangeText={setEmail} style={styles.input} placeholder="Enter your email" placeholderTextColor="#8b8885" />
            </View>

            <Text style={styles.label}>Password</Text>
            <View style={styles.inputShell}>
              <View style={styles.lockIcon}><View style={styles.lockShackle} /><View style={styles.lockBody} /></View>
              <TextInput secureTextEntry={!passwordVisible} autoComplete="current-password" returnKeyType="go" textContentType="password" onSubmitEditing={signIn} value={password} onChangeText={setPassword} style={styles.input} placeholder="Enter your password" placeholderTextColor="#8b8885" />
              <Pressable accessibilityRole="button" accessibilityLabel={passwordVisible ? 'Hide password' : 'Show password'} onPress={() => setPasswordVisible(value => !value)} style={styles.eyeButton}>
                <View style={styles.eye}><View style={styles.eyePupil} /></View>
              </Pressable>
            </View>

            <Pressable onPress={signIn} disabled={busy} style={({ pressed }) => [styles.primary, pressed && styles.pressed, busy && styles.disabled]}>
              {loading ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryText}>Log in</Text>}
            </Pressable>

            <View style={styles.divider}><View style={styles.dividerLine} /><Text style={styles.or}>or</Text><View style={styles.dividerLine} /></View>
            <View style={[styles.socialRow, width < 390 && styles.socialStack]}>
              <Pressable accessibilityRole="button" accessibilityLabel="Continue with Google" onPress={() => signInWithProvider('google')} disabled={busy} style={({ pressed }) => [styles.socialButton, pressed && styles.pressed, busy && styles.disabled]}>
                {socialLoading === 'google' ? <ActivityIndicator color="#321708" /> : <Text style={styles.googleMark}>G</Text>}
                <Text numberOfLines={1} style={styles.socialText}>Continue with Google</Text>
              </Pressable>
              <Pressable accessibilityRole="button" accessibilityLabel="Continue with Apple" onPress={() => signInWithProvider('apple')} disabled={busy} style={({ pressed }) => [styles.socialButton, pressed && styles.pressed, busy && styles.disabled]}>
                {socialLoading === 'apple' ? <ActivityIndicator color="#111" /> : <Text style={styles.appleMark}></Text>}
                <Text numberOfLines={1} style={styles.socialText}>Continue with Apple</Text>
              </Pressable>
            </View>
            <Pressable accessibilityRole="link" onPress={() => router.push('/signup')} style={styles.createButton}><Text style={styles.createText}>Create an account</Text></Pressable>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#fff4e8' }, flex: { flex: 1 }, page: { flexGrow: 1, backgroundColor: '#fff4e8' },
  hero: { minHeight: 330, alignItems: 'center', justifyContent: 'center', paddingTop: 20, paddingBottom: 46, overflow: 'hidden' },
  heroGlow: { position: 'absolute', width: 520, height: 320, borderRadius: 260, bottom: -205, backgroundColor: '#f4dcc6', opacity: 0.48 },
  logo: { width: 118, height: 118, marginBottom: 5 },
  brand: { color: '#4a2412', fontFamily: Platform.OS === 'ios' ? 'Georgia' : 'serif', fontWeight: '700', fontSize: 42, letterSpacing: -1.5 },
  brandAccent: { color: '#b86525' }, tagline: { marginTop: 8, color: '#2f211a', fontSize: 18, fontWeight: '500' },
  accentLine: { width: 80, height: 3, borderRadius: 3, backgroundColor: '#b86525', marginTop: 21 },
  sheet: { flex: 1, marginTop: -28, minHeight: 510, backgroundColor: '#fff', borderTopLeftRadius: 30, borderTopRightRadius: 30, paddingHorizontal: 28, paddingTop: 14, paddingBottom: 34, shadowColor: '#321708', shadowOpacity: 0.08, shadowRadius: 20, shadowOffset: { width: 0, height: -6 } },
  handle: { width: 50, height: 5, borderRadius: 5, alignSelf: 'center', backgroundColor: '#c9c7c5', marginBottom: 22 },
  label: { color: '#1e1b19', fontSize: 16, fontWeight: '700', marginBottom: 9, marginTop: 6 },
  inputShell: { height: 58, borderWidth: 1, borderColor: '#d7d4d1', borderRadius: 10, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, marginBottom: 14 },
  fieldIcon: { width: 31, color: '#a85216', fontSize: 22, textAlign: 'center' }, input: { flex: 1, height: '100%', paddingHorizontal: 10, color: '#231913', fontSize: 16 },
  lockIcon: { width: 31, height: 25, alignItems: 'center', justifyContent: 'flex-end' }, lockShackle: { position: 'absolute', top: 1, width: 12, height: 12, borderWidth: 1.8, borderColor: '#a85216', borderRadius: 7 }, lockBody: { width: 17, height: 15, borderWidth: 1.8, borderColor: '#a85216', borderRadius: 3, backgroundColor: '#fff' },
  eyeButton: { height: 44, width: 42, alignItems: 'center', justifyContent: 'center' }, eye: { width: 23, height: 15, borderWidth: 1.6, borderColor: '#3a3836', borderRadius: 14, alignItems: 'center', justifyContent: 'center' }, eyePupil: { width: 6, height: 6, borderRadius: 3, backgroundColor: '#3a3836' },
  primary: { height: 56, marginTop: 4, borderRadius: 9, backgroundColor: '#a9571f', alignItems: 'center', justifyContent: 'center' }, primaryText: { color: '#fff', fontSize: 18, fontWeight: '700' },
  divider: { flexDirection: 'row', alignItems: 'center', gap: 13, marginVertical: 20 }, dividerLine: { height: 1, flex: 1, backgroundColor: '#ddd9d5' }, or: { color: '#645d57', fontSize: 15 },
  socialRow: { flexDirection: 'row', gap: 12 }, socialStack: { flexDirection: 'column' }, socialButton: { flex: 1, minWidth: 0, height: 52, borderWidth: 1, borderColor: '#d5d1ce', borderRadius: 9, backgroundColor: '#fff', flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 9, paddingHorizontal: 8 },
  socialText: { color: '#171311', fontSize: 12, fontWeight: '600', flexShrink: 1 }, googleMark: { color: '#4285f4', fontSize: 22, fontWeight: '900' }, appleMark: { color: '#050505', fontSize: 25, lineHeight: 27 },
  createButton: { alignSelf: 'center', paddingHorizontal: 18, paddingVertical: 16, marginTop: 10 }, createText: { color: '#a44f18', fontSize: 17, fontWeight: '600' }, pressed: { opacity: 0.8 }, disabled: { opacity: 0.55 },
});
