import { useState } from 'react';
import { ActivityIndicator, Alert, KeyboardAvoidingView, Platform, Pressable, SafeAreaView, StyleSheet, Text, TextInput, View } from 'react-native';
import { router } from 'expo-router';
import { supabase } from '@/lib/supabase';

export default function ForgotPassword() {
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);

  async function sendReset() {
    const cleanEmail = email.trim().toLowerCase();
    if (!cleanEmail || !cleanEmail.includes('@')) return Alert.alert('Enter your email', 'Use the email address connected to your account.');
    setLoading(true);
    try {
      const { error } = await supabase.auth.resetPasswordForEmail(cleanEmail, { redirectTo: 'https://www.baristajobmatch.com/reset-password' });
      if (error) return Alert.alert('Could not send reset email', error.message);
      Alert.alert('Check your email', 'We sent a secure password-reset link if an account exists for that address.', [{ text: 'Back to login', onPress: () => router.replace('/login') }]);
    } catch {
      Alert.alert('Connection problem', 'Check your internet connection and try again.');
    } finally {
      setLoading(false);
    }
  }

  return <SafeAreaView style={styles.safe}><KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}><View style={styles.page}>
    <Pressable accessibilityRole="button" onPress={() => router.back()}><Text style={styles.back}>‹ Back</Text></Pressable>
    <Text style={styles.kicker}>ACCOUNT RECOVERY</Text>
    <Text style={styles.title}>Reset your password</Text>
    <Text style={styles.copy}>Enter your account email and we’ll send you a secure reset link.</Text>
    <Text style={styles.label}>Email address</Text>
    <TextInput autoFocus autoCapitalize="none" autoCorrect={false} autoComplete="email" keyboardType="email-address" returnKeyType="send" textContentType="emailAddress" onSubmitEditing={sendReset} value={email} onChangeText={setEmail} style={styles.input} placeholder="you@example.com" placeholderTextColor="#b0a59d" />
    <Pressable accessibilityRole="button" disabled={loading} onPress={sendReset} style={[styles.primary, loading && styles.disabled]}>{loading ? <><ActivityIndicator color="#fff"/><Text style={styles.primaryText}>Sending…</Text></> : <Text style={styles.primaryText}>Send reset link</Text>}</Pressable>
    <Text style={styles.help}>For your security, the message is the same whether or not the email is registered.</Text>
  </View></KeyboardAvoidingView></SafeAreaView>;
}

const styles=StyleSheet.create({safe:{flex:1,backgroundColor:'#fbf7f1'},flex:{flex:1},page:{flex:1,padding:24,paddingTop:22},back:{fontSize:16,fontWeight:'800',color:'#b76022',marginBottom:52},kicker:{fontSize:11,fontWeight:'900',letterSpacing:1.8,color:'#b76022'},title:{fontSize:36,lineHeight:40,fontWeight:'900',letterSpacing:-1.2,color:'#17110d',marginTop:10},copy:{fontSize:15,lineHeight:23,color:'#71665f',marginTop:12,marginBottom:30},label:{fontSize:12,fontWeight:'900',color:'#4b2b1a',marginBottom:8},input:{height:54,backgroundColor:'#fff',borderWidth:1,borderColor:'#e1d4c9',borderRadius:14,paddingHorizontal:15,fontSize:16,color:'#20140d'},primary:{height:55,marginTop:18,backgroundColor:'#321708',borderRadius:999,flexDirection:'row',gap:10,alignItems:'center',justifyContent:'center'},primaryText:{fontSize:16,fontWeight:'900',color:'#fff'},disabled:{opacity:.55},help:{fontSize:12,lineHeight:18,textAlign:'center',color:'#8a7e75',marginTop:18}});
