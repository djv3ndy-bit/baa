import { useEffect, useState } from 'react';
import { Alert, Image, KeyboardAvoidingView, Linking, Platform, Pressable, SafeAreaView, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { router } from 'expo-router';
import { supabase } from '@/lib/supabase';

const oauthRedirect = 'baristamatch://auth/callback';

function readOAuthParams(url: string) {
  const encoded = url.includes('#') ? url.split('#')[1] : url.split('?')[1];
  return new URLSearchParams(encoded || '');
}

export default function LoginScreen() {
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
      const { data: existingProfile } = await supabase.from('profiles').select('id').eq('id', data.user.id).maybeSingle();
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
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
    setLoading(false);
    if (error) return Alert.alert('Unable to log in', error.message);
    router.replace('/home');
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
    await Linking.openURL(data.url);
  }

  return (
    <SafeAreaView style={styles.safe}>
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={styles.page} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
          <View style={styles.glowOne} />
          <View style={styles.glowTwo} />
          <View style={styles.hero}>
            <View style={styles.brandRow}>
              <View style={styles.logoCard}><Image source={require('../assets/brand-mark.png')} resizeMode="contain" style={styles.logo} /></View>
              <View><Text style={styles.brand}>Barista<Text style={styles.match}>Match</Text></Text><Text style={styles.kicker}>SWIPE · MATCH · BREW</Text></View>
            </View>
            <Text style={styles.eyebrow}>THE LOCAL COFFEE CAREER NETWORK</Text>
            <Text style={styles.title}>Your next great{`\n`}coffee connection.</Text>
            <Text style={styles.subtitle}>Discover nearby opportunities, meet the right people, and build a career—or a team—that fits.</Text>
            <View style={styles.benefits}>
              <Benefit icon="⌖" label="Local matches" />
              <Benefit icon="♡" label="Real connections" />
              <Benefit icon="✦" label="Better opportunities" />
            </View>
          </View>
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Welcome back</Text>
            <Text style={styles.cardCopy}>Sign in and pick up where you left off.</Text>
            <Pressable onPress={signInWithGoogle} disabled={googleLoading || loading} style={({ pressed }) => [styles.google, pressed && styles.pressed]}>
              <View style={styles.googleMark}><Text style={styles.googleLetter}>G</Text></View>
              <Text style={styles.googleText}>{googleLoading ? 'Opening Google…' : 'Continue with Google'}</Text>
            </Pressable>
            <View style={styles.divider}><View style={styles.line} /><Text style={styles.or}>OR CONTINUE WITH EMAIL</Text><View style={styles.line} /></View>
            <Text style={styles.label}>Email address</Text>
            <TextInput autoCapitalize="none" autoComplete="email" keyboardType="email-address" value={email} onChangeText={setEmail} style={styles.input} placeholder="you@example.com" placeholderTextColor="#b0a59d" />
            <Text style={styles.label}>Password</Text>
            <TextInput secureTextEntry autoComplete="current-password" value={password} onChangeText={setPassword} style={styles.input} placeholder="Your password" placeholderTextColor="#b0a59d" />
            <Pressable onPress={signIn} disabled={loading || googleLoading} style={({ pressed }) => [styles.primary, pressed && styles.pressed, (loading || googleLoading) && styles.disabled]}>
              <Text style={styles.primaryText}>{loading ? 'Logging in…' : 'Log in'}</Text>{!loading && <Text style={styles.arrow}>→</Text>}
            </Pressable>
            <View style={styles.createRow}><Text style={styles.newText}>New to BaristaMatch?</Text><Pressable onPress={() => router.push('/signup')}><Text style={styles.link}> Create an account</Text></Pressable></View>
          </View>
          <Text style={styles.foot}>Made for the people who make coffee matter.</Text>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function Benefit({ icon, label }: { icon: string; label: string }) {
  return <View style={styles.benefit}><Text style={styles.benefitIcon}>{icon}</Text><Text style={styles.benefitText}>{label}</Text></View>;
}

const styles = StyleSheet.create({
  safe:{flex:1,backgroundColor:'#f8f2e9'},flex:{flex:1},page:{padding:20,paddingTop:18,paddingBottom:34,overflow:'hidden'},
  glowOne:{position:'absolute',width:240,height:240,borderRadius:120,backgroundColor:'#efc08c',opacity:.22,top:-110,right:-90},glowTwo:{position:'absolute',width:180,height:180,borderRadius:90,backgroundColor:'#c96a2e',opacity:.09,top:260,left:-110},
  hero:{paddingHorizontal:4},brandRow:{flexDirection:'row',alignItems:'center',gap:12},logoCard:{width:58,height:58,borderRadius:18,backgroundColor:'#fffaf4',borderWidth:1,borderColor:'#ead8c5',alignItems:'center',justifyContent:'center',shadowColor:'#4b210b',shadowOpacity:.12,shadowRadius:18,shadowOffset:{width:0,height:8}},logo:{width:47,height:47},
  brand:{fontSize:27,fontWeight:'900',color:'#321708',letterSpacing:-1},match:{color:'#b55a20'},kicker:{marginTop:3,fontSize:9,fontWeight:'900',letterSpacing:1.7,color:'#9a4b1c'},eyebrow:{marginTop:29,fontSize:10,fontWeight:'900',letterSpacing:1.8,color:'#a95820'},title:{fontSize:39,lineHeight:43,fontWeight:'900',letterSpacing:-1.7,color:'#21130c',marginTop:10},subtitle:{fontSize:15,lineHeight:22,color:'#695a50',marginTop:12,maxWidth:350},
  benefits:{flexDirection:'row',gap:8,marginTop:20,marginBottom:22},benefit:{flex:1,minHeight:70,borderRadius:16,backgroundColor:'rgba(255,255,255,.68)',borderWidth:1,borderColor:'#ead8c5',paddingHorizontal:8,paddingVertical:10,alignItems:'center',justifyContent:'center'},benefitIcon:{fontSize:20,color:'#a95820',fontWeight:'900'},benefitText:{fontSize:10,color:'#543a2b',fontWeight:'800',marginTop:5,textAlign:'center'},
  card:{backgroundColor:'#fffdf9',borderRadius:26,padding:20,borderWidth:1,borderColor:'#ead8c5',shadowColor:'#54250c',shadowOpacity:.12,shadowRadius:24,shadowOffset:{width:0,height:12}},cardTitle:{fontSize:25,fontWeight:'900',color:'#321708'},cardCopy:{fontSize:13,color:'#7c6c61',marginTop:4,marginBottom:17},google:{height:54,borderRadius:15,borderWidth:1,borderColor:'#d9ccc1',backgroundColor:'#fff',flexDirection:'row',alignItems:'center',justifyContent:'center',gap:11},googleMark:{width:26,height:26,borderRadius:13,backgroundColor:'#f4f7ff',alignItems:'center',justifyContent:'center'},googleLetter:{fontSize:17,fontWeight:'900',color:'#4285f4'},googleText:{fontSize:15,fontWeight:'800',color:'#2d211b'},
  divider:{flexDirection:'row',alignItems:'center',gap:9,marginVertical:18},line:{height:1,backgroundColor:'#e9ddd3',flex:1},or:{fontSize:8.5,fontWeight:'900',letterSpacing:1.1,color:'#998b82'},label:{fontSize:12,fontWeight:'900',color:'#4b2b1a',marginBottom:7,marginTop:10},input:{height:52,backgroundColor:'#fff',borderWidth:1,borderColor:'#e1d4c9',borderRadius:14,paddingHorizontal:15,fontSize:16,color:'#20140d'},
  primary:{marginTop:20,height:55,backgroundColor:'#381604',borderRadius:15,flexDirection:'row',alignItems:'center',justifyContent:'center',gap:14},primaryText:{color:'#fff',fontWeight:'900',fontSize:16},arrow:{color:'#fff',fontSize:21,lineHeight:23},pressed:{opacity:.84},disabled:{opacity:.55},createRow:{flexDirection:'row',alignItems:'center',justifyContent:'center',marginTop:18},newText:{fontSize:13,color:'#78685e'},link:{fontSize:13,color:'#ad541e',fontWeight:'900'},foot:{textAlign:'center',fontSize:11,color:'#8a7c72',marginTop:20,fontWeight:'700'},
});
