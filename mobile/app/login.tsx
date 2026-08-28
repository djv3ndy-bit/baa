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
  const { height } = useWindowDimensions();
  const compact = height < 750;
  const [showLogin, setShowLogin] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);

  useEffect(() => {
    async function handleOAuth(url: string | null) {
      if (!url?.startsWith(oauthRedirect)) return;
      const params = readOAuthParams(url);
      const errorDescription = params.get('error_description');
      if (errorDescription) {
        setGoogleLoading(false);
        return Alert.alert('Google sign-in failed', decodeURIComponent(errorDescription));
      }
      const accessToken = params.get('access_token');
      const refreshToken = params.get('refresh_token');
      if (!accessToken || !refreshToken) return;
      const { data, error } = await supabase.auth.setSession({ access_token: accessToken, refresh_token: refreshToken });
      setGoogleLoading(false);
      if (error) return Alert.alert('Google sign-in failed', error.message);
      if (!data.user) return;
      const { data: existingProfile, error: profileError } = await supabase.from('profiles').select('id').eq('id', data.user.id).maybeSingle();
      if (profileError) return Alert.alert('Could not finish signing in', 'Check your connection and try again.');
      if (existingProfile) return router.replace('/home');
      const fullName = String(data.user.user_metadata?.full_name || data.user.user_metadata?.name || '').trim();
      Alert.alert('How will you use BaristaMatch?', 'Choose your account type to finish setting up Google sign-in.', [
        { text: 'I am a barista', onPress: () => createGoogleProfile(data.user!.id, 'barista', fullName) },
        { text: 'I manage a café', onPress: () => createGoogleProfile(data.user!.id, 'cafe_owner_manager', fullName) },
      ]);
    }

    const subscription = Linking.addEventListener('url', ({ url }) => handleOAuth(url));
    Linking.getInitialURL().then(handleOAuth);
    return () => subscription.remove();
  }, []);

  async function createGoogleProfile(userId: string, role: 'barista' | 'cafe_owner_manager', name: string) {
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

  async function signInWithGoogle() {
    setGoogleLoading(true);
    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: oauthRedirect, skipBrowserRedirect: true },
    });
    if (error || !data.url) {
      setGoogleLoading(false);
      return Alert.alert('Google sign-in unavailable', error?.message || 'Please try again.');
    }
    const supported = await Linking.canOpenURL(data.url);
    if (!supported) {
      setGoogleLoading(false);
      return Alert.alert('Google sign-in unavailable', 'Unable to open the secure Google sign-in page.');
    }
    try {
      await Linking.openURL(data.url);
    } catch {
      Alert.alert('Google sign-in unavailable', 'Unable to open the secure Google sign-in page.');
    } finally {
      // Prevent a cancelled browser sign-in from leaving the button frozen.
      setGoogleLoading(false);
    }
  }

  return (
    <SafeAreaView style={styles.safe}>
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView
          contentContainerStyle={[styles.page, !showLogin && styles.pageFixed, compact && !showLogin && styles.pageCompact]}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
          scrollEnabled={showLogin}
        >
          <View style={styles.glowOne} />
          <View style={styles.brandRow}>
            <Image source={require('../assets/website-favicon.png')} resizeMode="contain" style={styles.logo} />
            <Text style={styles.brand}>BaristaJob<Text style={styles.match}>Match</Text></Text>
            {!showLogin && <Pressable onPress={() => setShowLogin(true)} style={styles.loginPill}><Text style={styles.loginPillText}>Log in</Text></Pressable>}
          </View>
          {!showLogin ? <>
            <View style={[styles.hero, compact && styles.heroCompact]}>
              <Text style={[styles.title, compact && styles.titleCompact]}>Great cafés and{`\n`}great baristas{`\n`}<Text style={styles.titleAccent}>belong together.</Text></Text>
              <Text style={[styles.subtitle, compact && styles.subtitleCompact]}>A simpler way to discover, match, and chat.</Text>
              <View style={[styles.trustRow, compact && styles.trustRowCompact]}>
                <Text style={styles.trustItem}>⌖  Local first</Text>
                <Text style={styles.trustItem}>♡  Real matches</Text>
                <Text style={styles.trustItem}>○  Private chat</Text>
              </View>
            </View>
            <View style={[styles.pathSection, compact && styles.pathSectionCompact]}>
              <Text style={[styles.pathTitle, compact && styles.pathTitleCompact]}>Choose your path</Text>
              <RoleChoice
                image={require('../assets/barista-pouring-icon.png')}
                title="Find my next café"
                copy="Create your barista profile and discover jobs nearby."
                onPress={() => router.push({ pathname: '/signup', params: { role: 'barista' } })}
              />
              <RoleChoice
                image={require('../assets/cafe-storefront-icon.png')}
                title="Build my café team"
                copy="Post jobs and connect with qualified candidates."
                cafe
                onPress={() => router.push({ pathname: '/signup', params: { role: 'cafe_owner_manager' } })}
              />
            </View>
          </> : <>
            <Pressable onPress={() => setShowLogin(false)}><Text style={styles.back}>‹ Back</Text></Pressable>
            <View style={styles.card}>
              <Text style={styles.cardTitle}>Welcome back</Text>
              <Text style={styles.cardCopy}>Log in to continue to BaristaJobMatch.</Text>
              <Pressable accessibilityRole="button" accessibilityLabel="Continue with Google" onPress={signInWithGoogle} disabled={googleLoading || loading} style={({ pressed }) => [styles.google, pressed && styles.pressed, (googleLoading || loading) && styles.disabled]}>
                <View style={styles.googleMark}><Text style={styles.googleLetter}>G</Text></View>
                {googleLoading ? <ActivityIndicator color="#321708" /> : <Text style={styles.googleText}>Continue with Google</Text>}
              </Pressable>
              <View style={styles.divider}><View style={styles.line} /><Text style={styles.or}>OR CONTINUE WITH EMAIL</Text><View style={styles.line} /></View>
              <Text style={styles.label}>Email address</Text>
              <TextInput autoCapitalize="none" autoCorrect={false} autoComplete="email" keyboardType="email-address" returnKeyType="next" textContentType="emailAddress" value={email} onChangeText={setEmail} style={styles.input} placeholder="you@example.com" placeholderTextColor="#b0a59d" />
              <Text style={styles.label}>Password</Text>
              <TextInput secureTextEntry autoComplete="current-password" returnKeyType="go" textContentType="password" onSubmitEditing={signIn} value={password} onChangeText={setPassword} style={styles.input} placeholder="Your password" placeholderTextColor="#b0a59d" />
              <Pressable accessibilityRole="link" onPress={() => router.push('/forgot-password')} style={styles.forgot}><Text style={styles.forgotText}>Forgot password?</Text></Pressable>
              <Pressable onPress={signIn} disabled={loading || googleLoading} style={({ pressed }) => [styles.primary, pressed && styles.pressed, (loading || googleLoading) && styles.disabled]}>
                {loading ? <><ActivityIndicator color="#fff" /><Text style={styles.primaryText}>Logging in…</Text></> : <><Text style={styles.primaryText}>Log in</Text><Text style={styles.arrow}>→</Text></>}
              </Pressable>
              <View style={styles.createRow}><Text style={styles.newText}>New to BaristaJobMatch?</Text><Pressable onPress={() => router.push('/signup')}><Text style={styles.link}> Create an account</Text></Pressable></View>
            </View>
          </>}
          <Text style={[styles.foot, compact && !showLogin && styles.footCompact]}>Made for the coffee community.</Text>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function RoleChoice({ image, title, copy, cafe, onPress }: { image: number; title: string; copy: string; cafe?: boolean; onPress: () => void }) {
  return <Pressable onPress={onPress} style={({ pressed }) => [styles.roleChoice, pressed && styles.pressed]}>
    <View style={[styles.roleImageWrap, cafe && styles.roleImageCafe]}><Image source={image} resizeMode="contain" style={styles.roleImage} /></View>
    <View style={styles.roleCopy}><Text style={styles.roleTitle}>{title}</Text><Text style={styles.roleDescription}>{copy}</Text></View>
    <Text style={[styles.roleArrow, cafe && styles.roleArrowCafe]}>→</Text>
  </Pressable>;
}

const styles = StyleSheet.create({
  safe:{flex:1,backgroundColor:'#fffdf9'},flex:{flex:1},page:{padding:20,paddingTop:12,paddingBottom:34,overflow:'hidden'},pageFixed:{flexGrow:1,paddingBottom:12},pageCompact:{paddingTop:5,paddingHorizontal:17},
  glowOne:{position:'absolute',width:260,height:260,borderRadius:130,backgroundColor:'#f5e5d5',opacity:.72,top:-125,right:-105},
  brandRow:{flexDirection:'row',alignItems:'center',gap:7,minHeight:54},logo:{width:42,height:42},brand:{fontSize:21,fontWeight:'900',color:'#321708',letterSpacing:-.9},match:{color:'#b76022'},loginPill:{marginLeft:'auto',borderWidth:1,borderColor:'#d5c1b1',borderRadius:999,paddingHorizontal:15,paddingVertical:9,backgroundColor:'#fff'},loginPillText:{fontSize:12,fontWeight:'900',color:'#321708'},
  hero:{paddingTop:28,paddingBottom:24},title:{fontSize:42,lineHeight:43,fontWeight:'900',letterSpacing:-2.1,color:'#17110d'},titleAccent:{color:'#b76022'},subtitle:{fontSize:16,lineHeight:24,color:'#4e433d',marginTop:16,maxWidth:340},trustRow:{flexDirection:'row',flexWrap:'wrap',gap:10,marginTop:18},trustItem:{fontSize:11,fontWeight:'800',color:'#3b302a',backgroundColor:'#fff7ef',borderWidth:1,borderColor:'#eedccd',borderRadius:999,paddingHorizontal:11,paddingVertical:8},
  heroCompact:{paddingTop:13,paddingBottom:12},titleCompact:{fontSize:34,lineHeight:34,letterSpacing:-1.7},subtitleCompact:{fontSize:13,lineHeight:18,marginTop:9},trustRowCompact:{gap:5,marginTop:10},
  pathSection:{marginHorizontal:-20,paddingHorizontal:20,paddingTop:20,paddingBottom:26,backgroundColor:'#fbf7f1'},pathTitle:{fontSize:20,fontWeight:'900',color:'#321708',marginBottom:13},roleChoice:{minHeight:82,flexDirection:'row',alignItems:'center',gap:12,backgroundColor:'#fff',borderWidth:1,borderColor:'#eadfd5',borderRadius:18,padding:13,marginBottom:10,shadowColor:'#321708',shadowOpacity:.05,shadowRadius:12,shadowOffset:{width:0,height:6}},roleImageWrap:{width:54,height:54,borderRadius:15,backgroundColor:'#fff3e9',alignItems:'center',justifyContent:'center'},roleImageCafe:{backgroundColor:'#edf6ef'},roleImage:{width:49,height:49},roleCopy:{flex:1},roleTitle:{fontSize:16,fontWeight:'900',color:'#321708'},roleDescription:{fontSize:11,lineHeight:16,color:'#71665f',marginTop:4},roleArrow:{fontSize:22,fontWeight:'900',color:'#b76022'},roleArrowCafe:{color:'#287443'},back:{fontSize:16,fontWeight:'800',color:'#b76022',marginTop:20,marginBottom:14},
  pathSectionCompact:{marginHorizontal:-17,paddingHorizontal:17,paddingTop:12,paddingBottom:10},pathTitleCompact:{fontSize:17,marginBottom:8},
  card:{backgroundColor:'#fff',borderRadius:22,padding:20,borderWidth:1,borderColor:'#eadfd5',shadowColor:'#321708',shadowOpacity:.1,shadowRadius:22,shadowOffset:{width:0,height:12}},cardTitle:{fontSize:27,fontWeight:'900',letterSpacing:-.7,color:'#321708'},cardCopy:{fontSize:13,color:'#71665f',marginTop:5,marginBottom:17},google:{height:54,borderRadius:999,borderWidth:1,borderColor:'#d5c1b1',backgroundColor:'#fff',flexDirection:'row',alignItems:'center',justifyContent:'center',gap:11},googleMark:{width:26,height:26,borderRadius:13,backgroundColor:'#f4f7ff',alignItems:'center',justifyContent:'center'},googleLetter:{fontSize:17,fontWeight:'900',color:'#4285f4'},googleText:{fontSize:15,fontWeight:'800',color:'#321708'},
  divider:{flexDirection:'row',alignItems:'center',gap:9,marginVertical:18},line:{height:1,backgroundColor:'#e9ddd3',flex:1},or:{fontSize:8.5,fontWeight:'900',letterSpacing:1.1,color:'#998b82'},label:{fontSize:12,fontWeight:'900',color:'#4b2b1a',marginBottom:7,marginTop:10},input:{height:52,backgroundColor:'#fff',borderWidth:1,borderColor:'#e1d4c9',borderRadius:14,paddingHorizontal:15,fontSize:16,color:'#20140d'},
  forgot:{alignSelf:'flex-end',paddingVertical:10,paddingLeft:14},forgotText:{fontSize:12,fontWeight:'900',color:'#b76022'},primary:{marginTop:8,height:55,backgroundColor:'#321708',borderRadius:999,flexDirection:'row',alignItems:'center',justifyContent:'center',gap:14},primaryText:{color:'#fff',fontWeight:'900',fontSize:16},arrow:{color:'#fff',fontSize:21,lineHeight:23},pressed:{opacity:.84},disabled:{opacity:.55},createRow:{flexDirection:'row',alignItems:'center',justifyContent:'center',marginTop:18},newText:{fontSize:13,color:'#71665f'},link:{fontSize:13,color:'#b76022',fontWeight:'900'},foot:{textAlign:'center',fontSize:11,color:'#71665f',marginTop:14,fontWeight:'700'},footCompact:{marginTop:5,fontSize:10},
});
