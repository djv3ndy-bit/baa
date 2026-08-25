import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, SafeAreaView, ScrollView, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { supabase } from '@/lib/supabase';

type Role = 'barista' | 'cafe';
type Profile = { role?: Role; display_name?: string | null; cafe_name?: string | null };

export default function HomeScreen() {
  const [loading, setLoading] = useState(true);
  const [profile, setProfile] = useState<Profile>({});
  const [counts, setCounts] = useState({ jobs: 0, matches: 0, messages: 0 });

  const role: Role = profile.role === 'cafe' ? 'cafe' : 'barista';
  const name = useMemo(() => profile.cafe_name || profile.display_name || (role === 'cafe' ? 'Your café' : 'Barista'), [profile, role]);

  useEffect(() => {
    load();
  }, []);

  async function load() {
    const { data: auth } = await supabase.auth.getUser();
    if (!auth.user) return router.replace('/login');

    const { data: p } = await supabase.from('profiles').select('role,display_name,cafe_name').eq('id', auth.user.id).maybeSingle();
    if (p) setProfile(p as Profile);

    const inferredRole: Role = p?.role === 'cafe' ? 'cafe' : 'barista';
    if (inferredRole === 'barista') {
      const [{ count: jobs }, { count: matches }, { count: unread }] = await Promise.all([
        supabase.from('jobs').select('*', { count: 'exact', head: true }).eq('status', 'active'),
        supabase.from('applications').select('*', { count: 'exact', head: true }).eq('barista_id', auth.user.id).eq('status', 'matched'),
        supabase.from('notifications').select('*', { count: 'exact', head: true }).eq('user_id', auth.user.id).is('read_at', null),
      ]);
      setCounts({ jobs: jobs || 0, matches: matches || 0, messages: unread || 0 });
    } else {
      const [{ count: jobs }, { count: matches }, { count: unread }] = await Promise.all([
        supabase.from('jobs').select('*', { count: 'exact', head: true }).eq('owner_id', auth.user.id).eq('status', 'active'),
        supabase.from('applications').select('*,jobs!inner(owner_id)', { count: 'exact', head: true }).eq('jobs.owner_id', auth.user.id).eq('status', 'matched'),
        supabase.from('notifications').select('*', { count: 'exact', head: true }).eq('user_id', auth.user.id).is('read_at', null),
      ]);
      setCounts({ jobs: jobs || 0, matches: matches || 0, messages: unread || 0 });
    }
    setLoading(false);
  }

  async function logout() {
    await supabase.auth.signOut();
    router.replace('/login');
  }

  if (loading) return <SafeAreaView style={styles.safe}><View style={styles.center}><ActivityIndicator size="large" color="#321708" /></View></SafeAreaView>;

  return (
    <SafeAreaView style={styles.safe}>
      <ScrollView contentContainerStyle={styles.wrap}>
        <View style={styles.topRow}>
          <View>
            <Text style={styles.brand}>Barista<Text style={styles.match}>Match</Text></Text>
            <Text style={styles.role}>{role === 'cafe' ? 'CAFÉ ACCOUNT' : 'BARISTA ACCOUNT'}</Text>
          </View>
          <Pressable onPress={logout} style={styles.account}><Text style={styles.accountText}>⚙</Text></Pressable>
        </View>

        <View style={styles.hero}>
          <Text style={styles.heroSmall}>WELCOME BACK</Text>
          <Text style={styles.heroTitle}>{name}</Text>
          <Text style={styles.heroCopy}>{role === 'cafe' ? 'Find great baristas and keep hiring moving.' : 'Your next great café opportunity starts here.'}</Text>
        </View>

        <View style={styles.stats}>
          <Stat label={role === 'cafe' ? 'Active jobs' : 'Open jobs'} value={counts.jobs} />
          <Stat label="Matches" value={counts.matches} />
          <Stat label="Alerts" value={counts.messages} />
        </View>

        <Text style={styles.sectionTitle}>Quick actions</Text>
        {role === 'barista' ? (
          <>
            <Action icon="☕" title="Find jobs" copy="Browse café opportunities near you." />
            <Action icon="🤝" title="Matches" copy="See cafés that matched with you." />
            <Action icon="💬" title="Messages" copy="Continue conversations with matched cafés." />
            <Action icon="👤" title="My profile" copy="Keep your profile and coffee showcase updated." />
          </>
        ) : (
          <>
            <Action icon="＋" title="Post a job" copy="Create a new café opportunity." />
            <Action icon="☕" title="Candidates" copy="Review interested baristas." />
            <Action icon="🤝" title="Matches" copy="See your active hiring connections." />
            <Action icon="💬" title="Messages" copy="Chat with matched baristas." />
          </>
        )}

        <Text style={styles.note}>Next build: native Jobs, Candidates, Matches, Messages, Profile, Notifications, and Support screens using the existing BaristaMatch Supabase data.</Text>
      </ScrollView>
    </SafeAreaView>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return <View style={styles.stat}><Text style={styles.statValue}>{value}</Text><Text style={styles.statLabel}>{label}</Text></View>;
}

function Action({ icon, title, copy }: { icon: string; title: string; copy: string }) {
  return <Pressable style={({ pressed }) => [styles.action, pressed && { opacity: .85 }]}><View style={styles.actionIcon}><Text style={styles.actionEmoji}>{icon}</Text></View><View style={styles.actionCopy}><Text style={styles.actionTitle}>{title}</Text><Text style={styles.actionText}>{copy}</Text></View><Text style={styles.chevron}>›</Text></Pressable>;
}

const styles = StyleSheet.create({
  safe:{flex:1,backgroundColor:'#fbf7f1'},wrap:{padding:20,paddingBottom:48},center:{flex:1,alignItems:'center',justifyContent:'center'},
  topRow:{flexDirection:'row',alignItems:'center',justifyContent:'space-between',marginBottom:20},brand:{fontSize:27,fontWeight:'900',color:'#321708'},match:{color:'#a95820'},role:{fontSize:10,fontWeight:'900',letterSpacing:1.5,color:'#9b6a49',marginTop:3},account:{width:44,height:44,borderRadius:14,backgroundColor:'#fff',alignItems:'center',justifyContent:'center',borderWidth:1,borderColor:'#eadfd5'},accountText:{fontSize:20},
  hero:{backgroundColor:'#321708',borderRadius:24,padding:22,marginBottom:16},heroSmall:{fontSize:11,fontWeight:'900',letterSpacing:1.6,color:'#d7a985'},heroTitle:{fontSize:31,fontWeight:'900',color:'#fff',marginTop:9},heroCopy:{fontSize:15,lineHeight:22,color:'#eaded5',marginTop:7},
  stats:{flexDirection:'row',gap:10,marginBottom:28},stat:{flex:1,backgroundColor:'#fff',borderRadius:18,padding:16,borderWidth:1,borderColor:'#eadfd5'},statValue:{fontSize:27,fontWeight:'900',color:'#321708'},statLabel:{fontSize:12,color:'#746a61',marginTop:4,fontWeight:'700'},
  sectionTitle:{fontSize:22,fontWeight:'900',color:'#17110d',marginBottom:12},action:{flexDirection:'row',alignItems:'center',backgroundColor:'#fff',borderWidth:1,borderColor:'#eadfd5',borderRadius:19,padding:15,marginBottom:10},actionIcon:{width:45,height:45,borderRadius:14,backgroundColor:'#f6eae0',alignItems:'center',justifyContent:'center'},actionEmoji:{fontSize:21},actionCopy:{flex:1,paddingHorizontal:13},actionTitle:{fontSize:16,fontWeight:'900',color:'#21150f'},actionText:{fontSize:13,lineHeight:18,color:'#746a61',marginTop:3},chevron:{fontSize:28,color:'#a95820'},
  note:{fontSize:12,lineHeight:18,color:'#8b7f76',marginTop:18,textAlign:'center'}
});
