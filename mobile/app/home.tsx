import { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, RefreshControl, SafeAreaView, ScrollView, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { AppBottomNav } from '@/components/AppBottomNav';
import { supabase } from '@/lib/supabase';

type Role = 'barista' | 'cafe_owner_manager';
type Profile = { role?: Role; display_name?: string | null; cafe_name?: string | null; location?: string | null; bio?: string | null; skills?: string[] | null; availability?: string | null; experience?: string | null; pay_expectation?: string | null; avatar_url?: string | null };
const PROFILE_FIELDS = 'role,display_name,cafe_name,location,bio,skills,availability,experience,pay_expectation,avatar_url';

export default function HomeScreen() {
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [profile, setProfile] = useState<Profile>({});
  const [counts, setCounts] = useState({ jobs: 0, matches: 0, alerts: 0 });
  const role: Role = profile.role === 'cafe_owner_manager' ? 'cafe_owner_manager' : 'barista';
  const isCafe = role === 'cafe_owner_manager';
  const name = profile.cafe_name || profile.display_name || (isCafe ? 'Your café' : 'Barista');
  const completionFields = isCafe ? [profile.cafe_name, profile.location, profile.bio, profile.skills?.length, profile.experience, profile.avatar_url] : [profile.display_name, profile.location, profile.bio, profile.skills?.length, profile.availability, profile.experience, profile.pay_expectation, profile.avatar_url];
  const profileProgress = Math.round((completionFields.filter(Boolean).length / completionFields.length) * 100);

  useEffect(() => { load(true); }, []);

  async function load(fullScreen = false) {
    if (fullScreen) setLoading(true); else setRefreshing(true);
    const { data: auth } = await supabase.auth.getSession();
    const user = auth.session?.user;
    if (!user) return router.replace('/login');
    const { data: p, error: profileError } = await supabase.from('profiles').select(PROFILE_FIELDS).eq('id', user.id).maybeSingle();
    if (profileError) { setLoading(false); setRefreshing(false); return Alert.alert('Could not load your dashboard', 'Check your connection and try again.', [{ text: 'Retry', onPress: () => load(true) }]); }
    if (p) setProfile(p as Profile);
    const inferredRole: Role = p?.role === 'cafe_owner_manager' ? 'cafe_owner_manager' : 'barista';
    const queries = inferredRole === 'barista' ? [
      supabase.from('jobs').select('*', { count: 'exact', head: true }).eq('active', true),
      supabase.from('applications').select('*', { count: 'exact', head: true }).eq('barista_id', user.id).eq('status', 'matched'),
      supabase.from('notifications').select('*', { count: 'exact', head: true }).eq('recipient_id', user.id).is('read_at', null),
    ] : [
      supabase.from('jobs').select('*', { count: 'exact', head: true }).eq('owner_id', user.id).eq('active', true),
      supabase.from('applications').select('*,jobs!inner(owner_id)', { count: 'exact', head: true }).eq('jobs.owner_id', user.id).eq('status', 'matched'),
      supabase.from('notifications').select('*', { count: 'exact', head: true }).eq('recipient_id', user.id).is('read_at', null),
    ];
    const [{ count: jobs }, { count: matches }, { count: alerts }] = await Promise.all(queries);
    setCounts({ jobs: jobs || 0, matches: matches || 0, alerts: alerts || 0 });
    setLoading(false); setRefreshing(false);
  }

  if (loading) return <SafeAreaView style={styles.safe}><View style={styles.center}><ActivityIndicator size="large" color="#a95820" /></View></SafeAreaView>;
  const firstName = name.split(' ')[0];
  const nextTitle = profileProgress < 100 ? 'Finish your profile' : isCafe && counts.jobs === 0 ? 'Post your first opportunity' : !isCafe && counts.jobs > 0 ? 'Discover your next café' : 'You’re ready to connect';
  const nextCopy = profileProgress < 100 ? 'Complete profiles make stronger, more trusted matches.' : isCafe && counts.jobs === 0 ? 'Create a clear role with pay, schedule, and skills.' : !isCafe && counts.jobs > 0 ? `${counts.jobs} open ${counts.jobs === 1 ? 'role is' : 'roles are'} ready to explore.` : 'Keep checking matches and messages for new activity.';
  const nextPath = profileProgress < 100 ? '/profile' : isCafe && counts.jobs === 0 ? '/post-job' : !isCafe ? '/discover' : '/candidates';

  return <SafeAreaView style={styles.safe}>
    <ScrollView contentContainerStyle={styles.wrap} showsVerticalScrollIndicator={false} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => load(false)} tintColor="#a95820" />}>
      <View style={styles.topRow}><View><Text style={styles.brand}>Barista<Text style={styles.brandAccent}>Job</Text>Match</Text><Text style={styles.eyebrow}>{isCafe ? 'CAFÉ DASHBOARD' : 'BARISTA DASHBOARD'}</Text></View><Pressable accessibilityRole="button" accessibilityLabel="Open account settings" onPress={() => router.push('/settings')} style={styles.settings}><Text style={styles.settingsIcon}>⚙</Text></Pressable></View>
      <View style={styles.hero}><View style={styles.heroOrbOne} /><View style={styles.heroOrbTwo} /><View style={styles.heroBadge}><Text style={styles.heroBadgeText}>{isCafe ? '🏪  HIRING MODE' : '☕  READY TO MATCH'}</Text></View><Text style={styles.heroTitle}>Welcome back,{`\n`}{firstName}.</Text><Text style={styles.heroCopy}>{isCafe ? 'Build your team, review candidates, and keep every conversation moving.' : 'Find the right café, grow your profile, and turn matches into opportunities.'}</Text></View>
      <View style={styles.sectionHeading}><View><Text style={styles.sectionKicker}>AT A GLANCE</Text><Text style={styles.sectionTitle}>Your activity</Text></View><Text style={styles.live}>● LIVE</Text></View>
      <View style={styles.stats}><Stat icon={isCafe ? '▣' : '⌕'} label={isCafe ? 'Active jobs' : 'Open jobs'} value={counts.jobs} tone="orange" /><Stat icon="♡" label="Matches" value={counts.matches} tone="green" /><Stat icon="◉" label="New alerts" value={counts.alerts} tone="cream" /></View>
      <Pressable onPress={() => router.push('/profile')} style={({ pressed }) => [styles.progressCard, pressed && styles.pressed]}><View style={styles.progressTop}><View><Text style={styles.progressKicker}>PROFILE STRENGTH</Text><Text style={styles.progressTitle}>{profileProgress === 100 ? 'Looking great' : 'Make your profile stand out'}</Text></View><Text style={styles.progressValue}>{profileProgress}%</Text></View><View style={styles.progressTrack}><View style={[styles.progressFill, { width: `${profileProgress}%` }]} /></View><Text style={styles.progressCopy}>{profileProgress === 100 ? 'Your profile is ready for discovery and matching.' : 'Add your details so the right people can find you.'}</Text></Pressable>
      <View style={styles.sectionHeading}><View><Text style={styles.sectionKicker}>WORKSPACE</Text><Text style={styles.sectionTitle}>Quick actions</Text></View></View>
      <View style={styles.actionGrid}>{isCafe ? <><DashboardAction color="#f7e5d6" icon="＋" title="Post a job" copy="Create an opportunity" onPress={() => router.push('/post-job')} /><DashboardAction color="#e5f1e8" icon="👥" title="Candidates" copy="Review interest" onPress={() => router.push('/candidates')} /><DashboardAction color="#eee6f4" icon="♡" title="Matches" copy="Manage connections" onPress={() => router.push('/matches')} /><DashboardAction color="#e4eef4" icon="✉" title="Messages" copy="Keep hiring moving" onPress={() => router.push('/messages')} /></> : <><DashboardAction color="#f7e5d6" icon="☕" title="Discover" copy="Explore local cafés" onPress={() => router.push('/discover')} /><DashboardAction color="#e5f1e8" icon="♡" title="Matches" copy="See your connections" onPress={() => router.push('/matches')} /><DashboardAction color="#e4eef4" icon="✉" title="Messages" copy="Start a conversation" onPress={() => router.push('/messages')} /><DashboardAction color="#eee6f4" icon="◯" title="My profile" copy="Show your best work" onPress={() => router.push('/profile')} /></>}</View>
      <Text style={styles.sectionKicker}>YOUR NEXT STEP</Text><Pressable onPress={() => router.push(nextPath as never)} style={({ pressed }) => [styles.nextCard, pressed && styles.pressed]}><View style={styles.nextIcon}><Text style={styles.nextEmoji}>{profileProgress < 100 ? '✦' : '☕'}</Text></View><View style={styles.nextBody}><Text style={styles.nextTitle}>{nextTitle}</Text><Text style={styles.nextCopy}>{nextCopy}</Text></View><Text style={styles.nextArrow}>→</Text></Pressable>
    </ScrollView><AppBottomNav active="home" role={role} />
  </SafeAreaView>;
}

function Stat({ icon, label, value, tone }: { icon: string; label: string; value: number; tone: 'orange' | 'green' | 'cream' }) { return <View style={[styles.stat, styles[`stat_${tone}`]]}><Text style={styles.statIcon}>{icon}</Text><Text style={styles.statValue}>{value}</Text><Text numberOfLines={1} style={styles.statLabel}>{label}</Text></View>; }
function DashboardAction({ color, icon, title, copy, onPress }: { color: string; icon: string; title: string; copy: string; onPress: () => void }) { return <Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => [styles.action, pressed && styles.pressed]}><View style={[styles.actionIcon, { backgroundColor: color }]}><Text style={styles.actionEmoji}>{icon}</Text></View><Text style={styles.actionTitle}>{title}</Text><Text style={styles.actionCopy}>{copy}</Text><Text style={styles.actionArrow}>↗</Text></Pressable>; }

const styles = StyleSheet.create({
  safe:{flex:1,backgroundColor:'#fbf7f1'},center:{flex:1,alignItems:'center',justifyContent:'center'},wrap:{padding:18,paddingBottom:28},pressed:{opacity:.82},
  topRow:{flexDirection:'row',alignItems:'center',justifyContent:'space-between',marginBottom:17},brand:{fontFamily:'Georgia',fontSize:25,fontWeight:'800',letterSpacing:-.8,color:'#321708'},brandAccent:{color:'#b76022'},eyebrow:{fontSize:9,fontWeight:'900',letterSpacing:1.7,color:'#9b6a49',marginTop:4},settings:{width:44,height:44,borderRadius:15,backgroundColor:'#fff',alignItems:'center',justifyContent:'center',borderWidth:1,borderColor:'#eadfd5',shadowColor:'#321708',shadowOpacity:.06,shadowRadius:8,shadowOffset:{width:0,height:3}},settingsIcon:{fontSize:19},
  hero:{minHeight:222,backgroundColor:'#321708',borderRadius:28,padding:22,justifyContent:'flex-end',overflow:'hidden',marginBottom:27,shadowColor:'#321708',shadowOpacity:.18,shadowRadius:16,shadowOffset:{width:0,height:8}},heroOrbOne:{position:'absolute',width:210,height:210,borderRadius:110,backgroundColor:'#a95820',right:-78,top:-92,opacity:.42},heroOrbTwo:{position:'absolute',width:120,height:120,borderRadius:70,backgroundColor:'#dba77e',right:40,top:-50,opacity:.18},heroBadge:{alignSelf:'flex-start',borderWidth:1,borderColor:'#ffffff38',backgroundColor:'#ffffff12',paddingHorizontal:10,paddingVertical:7,borderRadius:99,marginBottom:14},heroBadgeText:{fontSize:9,fontWeight:'900',letterSpacing:1.2,color:'#f5c8a6'},heroTitle:{fontSize:31,lineHeight:34,fontWeight:'900',color:'#fff',letterSpacing:-1},heroCopy:{fontSize:13,lineHeight:19,color:'#e8d9cf',marginTop:9,maxWidth:310},
  sectionHeading:{flexDirection:'row',alignItems:'flex-end',justifyContent:'space-between',marginBottom:11},sectionKicker:{fontSize:9,fontWeight:'900',letterSpacing:1.6,color:'#a95820',marginBottom:4},sectionTitle:{fontSize:22,fontWeight:'900',letterSpacing:-.5,color:'#24150d'},live:{fontSize:9,fontWeight:'900',letterSpacing:1,color:'#2f7c42',paddingBottom:4},
  stats:{flexDirection:'row',gap:9,marginBottom:14},stat:{flex:1,minHeight:116,borderRadius:20,padding:13,borderWidth:1},stat_orange:{backgroundColor:'#fff3ea',borderColor:'#efd9c7'},stat_green:{backgroundColor:'#edf6ef',borderColor:'#d4e7d8'},stat_cream:{backgroundColor:'#fff',borderColor:'#eadfd5'},statIcon:{fontSize:17,color:'#7d3d18'},statValue:{fontSize:28,fontWeight:'900',color:'#321708',marginTop:8},statLabel:{fontSize:10,fontWeight:'800',color:'#76685f',marginTop:3},
  progressCard:{backgroundColor:'#fff',borderWidth:1,borderColor:'#eadfd5',borderRadius:21,padding:17,marginBottom:27},progressTop:{flexDirection:'row',alignItems:'center',justifyContent:'space-between'},progressKicker:{fontSize:8,fontWeight:'900',letterSpacing:1.3,color:'#9b8778'},progressTitle:{fontSize:15,fontWeight:'900',color:'#321708',marginTop:4},progressValue:{fontSize:22,fontWeight:'900',color:'#a95820'},progressTrack:{height:7,borderRadius:7,backgroundColor:'#f0e5dc',overflow:'hidden',marginTop:14},progressFill:{height:'100%',borderRadius:7,backgroundColor:'#b76022'},progressCopy:{fontSize:11,lineHeight:16,color:'#746a61',marginTop:10},
  actionGrid:{flexDirection:'row',flexWrap:'wrap',gap:10,marginBottom:27},action:{width:'48.5%',minHeight:145,backgroundColor:'#fff',borderWidth:1,borderColor:'#eadfd5',borderRadius:21,padding:15,position:'relative'},actionIcon:{width:42,height:42,borderRadius:14,alignItems:'center',justifyContent:'center'},actionEmoji:{fontSize:20,color:'#321708'},actionTitle:{fontSize:15,fontWeight:'900',color:'#24150d',marginTop:13},actionCopy:{fontSize:10,lineHeight:15,color:'#7d7067',marginTop:3,paddingRight:14},actionArrow:{position:'absolute',right:14,bottom:13,fontSize:17,fontWeight:'800',color:'#a95820'},
  nextCard:{flexDirection:'row',alignItems:'center',backgroundColor:'#321708',borderRadius:22,padding:17,marginTop:4},nextIcon:{width:48,height:48,borderRadius:16,backgroundColor:'#ffffff16',alignItems:'center',justifyContent:'center'},nextEmoji:{fontSize:22,color:'#f3b37f'},nextBody:{flex:1,paddingHorizontal:13},nextTitle:{fontSize:15,fontWeight:'900',color:'#fff'},nextCopy:{fontSize:10,lineHeight:15,color:'#d9c8bc',marginTop:4},nextArrow:{fontSize:24,color:'#f3b37f'}
});
