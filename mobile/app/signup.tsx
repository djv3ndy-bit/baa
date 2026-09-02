import { useState } from 'react';
import { Alert, KeyboardAvoidingView, Linking, Platform, Pressable, SafeAreaView, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { supabase } from '@/lib/supabase';
import { normalizeFloridaLocation } from '@/lib/floridaLocation';

type Role = 'barista' | 'cafe_owner_manager';

export default function SignupScreen() {
  const params = useLocalSearchParams<{ role?: string }>();
  const initialRole: Role = params.role === 'cafe_owner_manager' ? 'cafe_owner_manager' : 'barista';
  const [role, setRole] = useState<Role>(initialRole);
  const [name, setName] = useState('');
  const [location, setLocation] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [ageConfirmed, setAgeConfirmed] = useState(false);
  const [loading, setLoading] = useState(false);

  async function signUp() {
    if (!name.trim() || !location.trim() || !email.trim() || password.length < 10) {
      return Alert.alert('Check your information', 'Enter your name, location, email, and a password with at least 10 characters.');
    }
    const normalizedLocation = normalizeFloridaLocation(location);
    if (!normalizedLocation) return Alert.alert('Florida city required', 'Enter a city such as Miami. Florida is selected automatically.');
    if (!ageConfirmed) return Alert.alert('Age confirmation required', 'Confirm that you are at least 16 years old and, if you are under 18, have permission from a parent or legal guardian.');
    const isCafe = role === 'cafe_owner_manager';
    const profile = {
      id: '',
      role,
      display_name: isCafe ? null : name.trim(),
      cafe_name: isCafe ? name.trim() : null,
      location: normalizedLocation,
    };
    setLoading(true);
    const { data, error } = await supabase.auth.signUp({
      email: email.trim(),
      password,
      options: { emailRedirectTo:'baristamatch://login',data: { role, display_name: profile.display_name, cafe_name: profile.cafe_name, location: profile.location } },
    });
    if (!error && data.user) {
      await supabase.from('profiles').upsert({ ...profile, id: data.user.id }, { onConflict: 'id' });
    }
    setLoading(false);
    if (error) return Alert.alert('Unable to create account', error.message);
    if(data.session){if(isCafe)await supabase.rpc('ensure_cafe_subscription');return router.replace('/home')}
    router.replace('/verify-email');
  }

  return (
    <SafeAreaView style={styles.safe}>
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={styles.wrap} keyboardShouldPersistTaps="handled">
          <Pressable onPress={() => router.back()}><Text style={styles.back}>‹ Back to log in</Text></Pressable>
          <Text style={styles.kicker}>JOIN BARISTAMATCH</Text>
          <Text style={styles.title}>{role === 'barista' ? 'Build your barista profile.' : 'Build your café team.'}</Text>
          <Text style={styles.subtitle}>{role === 'barista' ? 'Discover nearby cafés and connect when the fit feels right.' : 'Discover nearby baristas and connect when there’s mutual interest.'}</Text>

          <View style={styles.roleRow}>
            {(['barista','cafe_owner_manager'] as Role[]).map(item => (
              <Pressable key={item} onPress={() => setRole(item)} style={[styles.role, role === item && styles.roleActive]}>
                <Text style={[styles.roleText, role === item && styles.roleTextActive]}>{item === 'barista' ? '☕ Barista' : '🏪 Café'}</Text>
              </Pressable>
            ))}
          </View>

          <Text style={styles.label}>{role === 'barista' ? 'Your name' : 'Café name'}</Text>
          <TextInput value={name} onChangeText={setName} style={styles.input} placeholder={role === 'barista' ? 'Your full name' : 'Your café name'} />
          <Text style={styles.label}>City</Text>
          <TextInput accessibilityLabel="City" autoCapitalize="words" autoComplete="postal-address-locality" textContentType="addressCity" value={location} onChangeText={setLocation} style={styles.input} placeholder="Miami" />
          <Text style={styles.label}>State</Text>
          <TextInput accessibilityLabel="State" value="Florida (FL)" editable={false} style={[styles.input, styles.inputDisabled]} />
          <Text style={styles.helper}>Florida is selected automatically while BaristaMatch launches statewide.</Text>
          <Text style={styles.label}>Email</Text>
          <TextInput autoCapitalize="none" keyboardType="email-address" value={email} onChangeText={setEmail} style={styles.input} placeholder="you@example.com" />
          <Text style={styles.label}>Password</Text>
          <TextInput secureTextEntry value={password} onChangeText={setPassword} style={styles.input} placeholder="At least 10 characters" />

          <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: ageConfirmed }} onPress={() => setAgeConfirmed(value => !value)} style={styles.confirmRow}>
            <View style={[styles.checkbox, ageConfirmed && styles.checkboxChecked]}><Text style={styles.checkmark}>{ageConfirmed ? '✓' : ''}</Text></View>
            <Text style={styles.confirmText}>I confirm that I am at least 16. If I am under 18, I have permission from a parent or legal guardian.</Text>
          </Pressable>
          <Pressable onPress={signUp} disabled={loading} style={[styles.primary, loading && styles.disabled]}><Text style={styles.primaryText}>{loading ? 'Creating account…' : 'Create account'}</Text></Pressable>
          <Text style={styles.legal}>By creating an account, you agree to the following:</Text>
          <View style={styles.legalLinks}><Pressable accessibilityRole="link" onPress={()=>Linking.openURL('https://www.baristajobmatch.com/terms.html')}><Text style={styles.legalLink}>Terms of Service</Text></Pressable><Text style={styles.legalSeparator}> · </Text><Pressable accessibilityRole="link" onPress={()=>Linking.openURL('https://www.baristajobmatch.com/privacy.html')}><Text style={styles.legalLink}>Privacy Policy</Text></Pressable></View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe:{flex:1,backgroundColor:'#fff4e8'},flex:{flex:1},wrap:{padding:24,paddingBottom:48,backgroundColor:'#fff4e8'},back:{fontSize:16,fontWeight:'700',color:'#a95820',marginBottom:30},
  kicker:{fontSize:12,fontWeight:'800',letterSpacing:2,color:'#a95820'},title:{fontFamily:Platform.OS==='ios'?'Georgia':'serif',fontSize:38,fontWeight:'700',color:'#4a2412',marginTop:10},subtitle:{fontSize:17,color:'#746a61',marginTop:8,marginBottom:24},
  roleRow:{flexDirection:'row',gap:10,marginBottom:12},role:{flex:1,borderWidth:1,borderColor:'#ded7d1',borderRadius:13,padding:15,alignItems:'center',backgroundColor:'#fff'},roleActive:{backgroundColor:'#fff8f2',borderColor:'#a95820'},roleText:{fontWeight:'800',color:'#321708'},roleTextActive:{color:'#a95820'},
  label:{fontSize:14,fontWeight:'800',color:'#321708',marginBottom:8,marginTop:15},input:{backgroundColor:'#fff',borderWidth:1,borderColor:'#ded7d1',borderRadius:10,paddingHorizontal:16,paddingVertical:15,fontSize:17,color:'#17110d'},inputDisabled:{backgroundColor:'#f3eee9',color:'#746a61'},
  helper:{fontSize:12,lineHeight:17,color:'#746a61',marginTop:7},confirmRow:{flexDirection:'row',alignItems:'flex-start',gap:10,marginTop:22},checkbox:{width:23,height:23,borderWidth:1.5,borderColor:'#a95820',borderRadius:5,backgroundColor:'#fff',alignItems:'center',justifyContent:'center'},checkboxChecked:{backgroundColor:'#a95820'},checkmark:{color:'#fff',fontSize:15,fontWeight:'900'},confirmText:{flex:1,fontSize:12,lineHeight:17,color:'#5f554e'},primary:{marginTop:18,backgroundColor:'#a9571f',paddingVertical:16,borderRadius:9,alignItems:'center'},primaryText:{color:'#fff',fontWeight:'800',fontSize:17},disabled:{opacity:.55},legal:{textAlign:'center',fontSize:12,lineHeight:18,color:'#8a7e75',marginTop:18},legalLinks:{flexDirection:'row',justifyContent:'center',alignItems:'baseline'},legalLink:{fontSize:12,lineHeight:18,color:'#a95820',fontWeight:'800',textDecorationLine:'underline'},legalSeparator:{fontSize:12,lineHeight:18,color:'#8a7e75'}
});
