import { useState } from 'react';
import { Alert, KeyboardAvoidingView, Platform, Pressable, SafeAreaView, StyleSheet, Text, TextInput, View } from 'react-native';
import { router } from 'expo-router';
import { supabase } from '@/lib/supabase';

export default function LoginScreen() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);

  async function signIn() {
    if (!email.trim() || !password) return Alert.alert('Missing information', 'Enter your email and password.');
    setLoading(true);
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
    setLoading(false);
    if (error) return Alert.alert('Unable to log in', error.message);
    router.replace('/home');
  }

  return (
    <SafeAreaView style={styles.safe}>
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={styles.wrap}>
          <View style={styles.logo}><Text style={styles.logoEmoji}>☕</Text></View>
          <Text style={styles.brand}>Barista<Text style={styles.match}>Match</Text></Text>
          <Text style={styles.kicker}>SWIPE. MATCH. BREW.</Text>
          <Text style={styles.title}>Welcome back</Text>
          <Text style={styles.subtitle}>Log in to your BaristaMatch account.</Text>

          <Text style={styles.label}>Email</Text>
          <TextInput autoCapitalize="none" keyboardType="email-address" value={email} onChangeText={setEmail} style={styles.input} placeholder="you@example.com" />
          <Text style={styles.label}>Password</Text>
          <TextInput secureTextEntry value={password} onChangeText={setPassword} style={styles.input} placeholder="Your password" />

          <Pressable onPress={signIn} disabled={loading} style={({ pressed }) => [styles.primary, pressed && styles.pressed, loading && styles.disabled]}>
            <Text style={styles.primaryText}>{loading ? 'Logging in…' : 'Log in'}</Text>
          </Pressable>
          <Pressable onPress={() => router.push('/signup')} style={styles.linkButton}><Text style={styles.link}>Create an account</Text></Pressable>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe:{flex:1,backgroundColor:'#fbf7f1'},flex:{flex:1},wrap:{flex:1,padding:24,justifyContent:'center'},
  logo:{width:68,height:68,borderRadius:20,backgroundColor:'#fff',alignItems:'center',justifyContent:'center',marginBottom:14,shadowColor:'#321708',shadowOpacity:.08,shadowRadius:20},logoEmoji:{fontSize:36},
  brand:{fontSize:30,fontWeight:'800',color:'#321708'},match:{color:'#a95820'},kicker:{marginTop:7,fontSize:12,fontWeight:'800',letterSpacing:2,color:'#a95820'},
  title:{fontSize:38,fontWeight:'800',color:'#17110d',marginTop:34},subtitle:{fontSize:17,color:'#746a61',marginTop:8,marginBottom:28},
  label:{fontSize:14,fontWeight:'800',color:'#321708',marginBottom:8,marginTop:14},input:{backgroundColor:'#fff',borderWidth:1,borderColor:'#e7ddd2',borderRadius:15,paddingHorizontal:16,paddingVertical:15,fontSize:17,color:'#17110d'},
  primary:{marginTop:24,backgroundColor:'#321708',paddingVertical:16,borderRadius:15,alignItems:'center'},primaryText:{color:'#fff',fontWeight:'800',fontSize:17},pressed:{opacity:.86},disabled:{opacity:.55},linkButton:{alignItems:'center',padding:18},link:{color:'#a95820',fontWeight:'800'}
});
