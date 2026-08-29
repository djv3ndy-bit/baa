import { Pressable, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';

type Tab='discover'|'candidates'|'matches'|'messages'|'profile';
export function AppBottomNav({active,role='barista'}:{active:Tab;role?:'barista'|'cafe_owner_manager'}){
  const first=role==='barista'?{key:'discover' as Tab,icon:'☕',label:'Discover',path:'/discover'}:{key:'candidates' as Tab,icon:'👥',label:'Candidates',path:'/candidates'};
  const items=[first,{key:'matches' as Tab,icon:'♡',label:'Matches',path:'/matches'},{key:'messages' as Tab,icon:'✉',label:'Messages',path:'/messages'},{key:'profile' as Tab,icon:'◯',label:'Profile',path:'/profile'}];
  return <View style={styles.bar}>{items.map(item=><Pressable key={item.key} onPress={()=>router.replace(item.path as never)} style={styles.item}><Text style={[styles.icon,active===item.key&&styles.active]}>{item.icon}</Text><Text style={[styles.label,active===item.key&&styles.active]}>{item.label}</Text></Pressable>)}</View>
}
const styles=StyleSheet.create({bar:{height:70,borderTopWidth:1,borderTopColor:'#eadfd5',backgroundColor:'#fff',flexDirection:'row',justifyContent:'space-around',alignItems:'center',paddingBottom:4},item:{alignItems:'center',justifyContent:'center',minWidth:62},icon:{fontSize:20,color:'#99897f'},label:{fontSize:10,color:'#99897f',marginTop:3,fontWeight:'700'},active:{color:'#321708'}});
