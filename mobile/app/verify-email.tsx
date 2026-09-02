import { Platform, Pressable, SafeAreaView, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';

export default function VerifyEmailScreen() {
  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.content}>
        <View style={styles.card}>
          <View style={styles.icon}><Text style={styles.iconText}>✓</Text></View>
          <Text style={styles.kicker}>ACCOUNT CREATED</Text>
          <Text style={styles.title}>You’re signed up!</Text>
          <Text style={styles.message}>Please verify your email. Once verified, log in to open your dashboard.</Text>
          <Pressable accessibilityRole="button" onPress={() => router.replace('/login')} style={styles.button}><Text style={styles.buttonText}>Go to log in</Text></Pressable>
          <Text style={styles.help}><Text style={styles.helpStrong}>Check your inbox</Text> — and your spam folder — for the verification email.</Text>
        </View>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe:{flex:1,backgroundColor:'#fff4e8'},content:{flex:1,justifyContent:'center',padding:24},card:{backgroundColor:'#fff',borderWidth:1,borderColor:'#e3d1c1',borderRadius:28,padding:32,alignItems:'center',shadowColor:'#321708',shadowOpacity:.1,shadowRadius:28,shadowOffset:{width:0,height:14},elevation:4},icon:{width:76,height:76,borderRadius:38,backgroundColor:'#e6f3e9',borderWidth:1,borderColor:'#c4dfca',alignItems:'center',justifyContent:'center',marginBottom:25},iconText:{fontSize:37,fontWeight:'900',color:'#287443'},kicker:{fontSize:12,fontWeight:'800',letterSpacing:1.8,color:'#a95820'},title:{fontFamily:Platform.OS==='ios'?'Georgia':'serif',fontSize:39,fontWeight:'700',color:'#4a2412',marginTop:12,textAlign:'center'},message:{fontSize:17,lineHeight:26,color:'#746a61',textAlign:'center',marginTop:14},button:{alignSelf:'stretch',backgroundColor:'#a9571f',paddingVertical:16,borderRadius:9,alignItems:'center',marginTop:29},buttonText:{color:'#fff',fontSize:16,fontWeight:'800'},help:{fontSize:13,lineHeight:20,color:'#746a61',textAlign:'center',marginTop:22},helpStrong:{fontWeight:'800',color:'#4a2412'}
});
