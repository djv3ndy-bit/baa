import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, RefreshControl, SafeAreaView, ScrollView, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { supabase } from '@/lib/supabase';

type Role = 'barista' | 'cafe_owner_manager';
type Profile = { role?: Role; display_name?: string | null; cafe_name?: string | null };

export default function HomeScreen() {
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [profile, setProfile] = useState<Profile>({});
  const [counts, setCounts] = useState({ jobs: 0, matches: 0, alerts: 0 });

  const role: Role = profile.role === 'cafe_owner_manager' ? 'cafe_owner_manager' : 'barista';
  const isCafe = role === 'cafe_owner_manager';
  const name = useMemo(() => profile.cafe_name || profile.display_name || (isCafe ? 'Your café' : 'Barista'), [profile, isCafe]);

  useEffect(() => { load(true); }, []);

  async function load(fullScreen = false) {
    if (fullScreen) setLoading(true); else setRefreshing(true);
    const { data: auth } = await supabase.auth.getSession();
    const user = auth.session?.user;
    if (!user) return router.replace('/login');

    const { data: p, error: profileError } = await supabase.from('profiles').select('role,display_name,cafe_name').eq('id', user.id).maybeSingle();
    if (profileError) {
      setLoading(false);
      setRefreshing(false);
      return Alert.alert('Could not load your dashboard', 'Check your connection and try again.', [{ text: 'Retry', onPress: () => load(true) }]);
    }
    if (p) setProfile(p as Profile);

    const inferredRole: Role = p?.role === 'cafe_owner_manager' ? 'cafe_owner_manager' : 'barista';
    if (inferredRole === 'barista') {
      const [{ count: jobs }, { count: matches }, { count: unread }] = await Promise.all([
        supabase.from('jobs').select('*', { count: 'exact', head: true }).eq('active', true),
        supabase.from('applications').select('*', { count: 'exact', head: true }).eq('barista_id', user.id).eq('status', 'matched'),
        supabase.from('notifications').select('*', { count: 'exact', head: true }).eq('recipient_id', user.id).is('read_at', null),
      ]);
      setCounts({ jobs: jobs || 0, matches: matches || 0, alerts: unread || 0 });
    } else {
      const [{ count: jobs }, { count: matches }, { count: unread }] = await Promise.all([
        supabase.from('jobs').select('*', { count: 'exact', head: true }).eq('owner_id', user.id).eq('active', true),
        supabase.from('applications').select('*,jobs!inner(owner_id)', { count: 'exact', head: true }).eq('jobs.owner_id', user.id).eq('status', 'matched'),
        supabase.from('notifications').select('*', { count: 'exact', head: true }).eq('recipient_id', user.id).is('read_at', null),
      ]);
      setCounts({ jobs: jobs || 0, matches: matches || 0, alerts: unread || 0 });
    }
    setLoading(false);
    setRefreshing(false);
  }

  if (loading) return <SafeAreaView style={styles.safe}><View style={styles.center}><ActivityIndicator size="large" color="#321708" /></View></SafeAreaView>;

  return (
    <SafeAreaView style={styles.safe}>
      <ScrollView contentContainerStyle={styles.wrap} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => load(false)} tintColor="#321708" />}>
        <View style={styles.topRow}>
          <View>
            <Text style={styles.brand}>Barista<Text style={styles.match}>Match</Text></Text>
            <Text style={styles.role}>{isCafe ? 'CAFÉ ACCOUNT' : 'BARISTA ACCOUNT'}</Text>
          </View>
          <Pressable accessibilityRole="button" accessibilityLabel="Open account settings" onPress={() => router.push('/settings')} style={styles.account}><Text style={styles.accountText}>⚙</Text></Pressable>
        </View>

        <View style={styles.hero}>
          <Text style={styles.heroSmall}>SWIPE · MATCH · BREW</Text>
          <Text style={styles.heroTitle}>{name}</Text>
          <Text style={styles.heroCopy}>{isCafe ? 'Find great baristas and keep hiring moving.' : 'Your next great café opportunity starts here.'}</Text>
        </View>

        <View style={styles.stats}>
          <Stat label={isCafe ? 'Active jobs' : 'Open jobs'} value={counts.jobs} />
          <Stat label="Matches" value={counts.matches} />
          <Stat label="Alerts" value={counts.alerts} />
        </View>

        <Text style={styles.sectionTitle}>Quick actions</Text>
        {!isCafe ? (
          <>
            <Action icon="☕" title="Discover" copy="Swipe through café opportunities." onPress={() => router.push('/discover')} />
            <Action icon="🤝" title="Matches" copy="See cafés that matched with you." onPress={()=>router.push('/matches')} />
            <Action icon="💬" title="Messages" copy="Continue conversations with matched cafés." onPress={()=>router.push('/messages')} />
            <Action icon="👤" title="My profile" copy="Keep your profile and coffee showcase updated." onPress={()=>router.push('/profile')} />
          </>
        ) : (
          <>
            <Action icon="＋" title="Post a job" copy="Create a new café opportunity." onPress={()=>router.push('/post-job')} />
            <Action icon="☕" title="Candidates" copy="Review interested baristas." onPress={()=>router.push('/candidates')} />
            <Action icon="🤝" title="Matches" copy="See your active hiring connections." onPress={()=>router.push('/matches')} />
            <Action icon="💬" title="Messages" copy="Chat with matched baristas." onPress={()=>router.push('/messages')} />
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return <View style={styles.stat}><Text style={styles.statValue}>{value}</Text><Text style={styles.statLabel}>{label}</Text></View>;
}

function Action({ icon, title, copy, onPress }: { icon: string; title: string; copy: string; onPress?: () => void }) {
  return <Pressable onPress={onPress} style={({ pressed }) => [styles.action, pressed && { opacity: .85 }]}><View style={styles.actionIcon}><Text style={styles.actionEmoji}>{icon}</Text></View><View style={styles.actionCopy}><Text style={styles.actionTitle}>{title}</Text><Text style={styles.actionText}>{copy}</Text></View><Text style={styles.chevron}>›</Text></Pressable>;
}

const styles = StyleSheet.create({
  safe:{flex:1,backgroundColor:'#fbf7f1'},wrap:{padding:20,paddingBottom:48},center:{flex:1,alignItems:'center',justifyContent:'center'},
  topRow:{flexDirection:'row',alignItems:'center',justifyContent:'space-between',marginBottom:20},brand:{fontSize:27,fontWeight:'900',color:'#321708'},match:{color:'#a95820'},role:{fontSize:10,fontWeight:'900',letterSpacing:1.5,color:'#9b6a49',marginTop:3},account:{width:44,height:44,borderRadius:14,backgroundColor:'#fff',alignItems:'center',justifyContent:'center',borderWidth:1,borderColor:'#eadfd5'},accountText:{fontSize:20},
  hero:{backgroundColor:'#321708',borderRadius:24,padding:22,marginBottom:16},heroSmall:{fontSize:11,fontWeight:'900',letterSpacing:1.6,color:'#d7a985'},heroTitle:{fontSize:31,fontWeight:'900',color:'#fff',marginTop:9},heroCopy:{fontSize:15,lineHeight:22,color:'#eaded5',marginTop:7},
  stats:{flexDirection:'row',gap:10,marginBottom:28},stat:{flex:1,backgroundColor:'#fff',borderRadius:18,padding:16,borderWidth:1,borderColor:'#eadfd5'},statValue:{fontSize:27,fontWeight:'900',color:'#321708'},statLabel:{fontSize:12,color:'#746a61',marginTop:4,fontWeight:'700'},
  sectionTitle:{fontSize:22,fontWeight:'900',color:'#17110d',marginBottom:12},action:{flexDirection:'row',alignItems:'center',backgroundColor:'#fff',borderWidth:1,borderColor:'#eadfd5',borderRadius:19,padding:15,marginBottom:10},actionIcon:{width:45,height:45,borderRadius:14,backgroundColor:'#f6eae0',alignItems:'center',justifyContent:'center'},actionEmoji:{fontSize:21},actionCopy:{flex:1,paddingHorizontal:13},actionTitle:{fontSize:16,fontWeight:'900',color:'#21150f'},actionText:{fontSize:13,lineHeight:18,color:'#746a61',marginTop:3},chevron:{fontSize:28,color:'#a95820'}
});
