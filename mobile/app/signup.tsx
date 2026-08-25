import { useState } from 'react';
import { Alert, KeyboardAvoidingView, Platform, Pressable, SafeAreaView, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { router } from 'expo-router';
import { supabase } from '@/lib/supabase';

type Role = 'barista' | 'cafe';

export default function SignupScreen() {
  const [role, setRole] = useState<Role>('barista');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);

  async function signUp() {
    if (!name.trim() || !email.trim() || password.length < 10) {
      return Alert.alert('Check your information', 'Enter your name, email, and a password with at least 10 characters.');
    }
    setLoading(true);
    const { data, error } = await supabase.auth.signUp({
      email: email.trim(),
      password,
      options: { data: { role, display_name: name.trim() } },
    });
    if (!error && data.user) {
      await supabase.from('profiles').upsert({ id: data.user.id, role, display_name: name.trim() }, { onConflict: 'id' });
    }
    setLoading(false);
    if (error) return Alert.alert('Unable to create account', error.message);
    Alert.alert('Check your email', 'Confirm your email to finish creating your BaristaMatch account.', [{ text: 'OK', onPress: () => router.replace('/login') }]);
  }

  return (
    <SafeAreaView style={styles.safe}>
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={styles.wrap} keyboardShouldPersistTaps="handled">
          <Pressable onPress={() => router.back()}><Text style={styles.back}>‹ Back</Text></Pressable>
          <Text style={styles.kicker}>JOIN BARISTAMATCH</Text>
          <Text style={styles.title}>Create your account</Text>
          <Text style={styles.subtitle}>Choose how you’ll use BaristaMatch.</Text>

          <View style={styles.roleRow}>
            {(['barista','cafe'] as Role[]).map(item => (
              <Pressable key={item} onPress={() => setRole(item)} style={[styles.role, role === item && styles.roleActive]}>
                <Text style={[styles.roleText, role === item && styles.roleTextActive]}>{item === 'barista' ? '☕ Barista' : '🏪 Café'}</Text>
              </Pressable>
            ))}
          </View>

          <Text style={styles.label}>{role === 'barista' ? 'Your name' : 'Café name'}</Text>
          <TextInput value={name} onChangeText={setName} style={styles.input} placeholder={role === 'barista' ? 'Your full name' : 'Your café name'} />
          <Text style={styles.label}>Email</Text>
          <TextInput autoCapitalize="none" keyboardType="email-address" value={email} onChangeText={setEmail} style={styles.input} placeholder="you@example.com" />
          <Text style={styles.label}>Password</Text>
          <TextInput secureTextEntry value={password} onChangeText={setPassword} style={styles.input} placeholder="At least 10 characters" />

          <Pressable onPress={signUp} disabled={loading} style={[styles.primary, loading && styles.disabled]}><Text style={styles.primaryText}>{loading ? 'Creating account…' : 'Create account'}</Text></Pressable>
          <Text style={styles.legal}>By creating an account, you agree to BaristaMatch Terms and Privacy Policy.</Text>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe:{flex:1,backgroundColor:'#fbf7f1'},flex:{flex:1},wrap:{padding:24,paddingBottom:48},back:{fontSize:17,fontWeight:'700',color:'#a95820',marginBottom:30},
  kicker:{fontSize:12,fontWeight:'800',letterSpacing:2,color:'#a95820'},title:{fontSize:38,fontWeight:'800',color:'#17110d',marginTop:10},subtitle:{fontSize:17,color:'#746a61',marginTop:8,marginBottom:24},
  roleRow:{flexDirection:'row',gap:10,marginBottom:12},role:{flex:1,borderWidth:1,borderColor:'#dbc8b8',borderRadius:15,padding:15,alignItems:'center',backgroundColor:'#fff'},roleActive:{backgroundColor:'#321708',borderColor:'#321708'},roleText:{fontWeight:'800',color:'#321708'},roleTextActive:{color:'#fff'},
  label:{fontSize:14,fontWeight:'800',color:'#321708',marginBottom:8,marginTop:15},input:{backgroundColor:'#fff',borderWidth:1,borderColor:'#e7ddd2',borderRadius:15,paddingHorizontal:16,paddingVertical:15,fontSize:17,color:'#17110d'},
  primary:{marginTop:26,backgroundColor:'#321708',paddingVertical:16,borderRadius:15,alignItems:'center'},primaryText:{color:'#fff',fontWeight:'800',fontSize:17},disabled:{opacity:.55},legal:{textAlign:'center',fontSize:12,lineHeight:18,color:'#8a7e75',marginTop:18}
});
