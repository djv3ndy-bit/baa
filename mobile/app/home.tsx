import { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Image, Linking, Pressable, RefreshControl, SafeAreaView, ScrollView, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { AppBottomNav } from '@/components/AppBottomNav';
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
  const name = profile.cafe_name || profile.display_name || (isCafe ? 'Your café' : 'Barista');
  const firstName = name.trim().split(/\s+/)[0] || 'there';
  const profileProgress = profile.display_name || profile.cafe_name ? 72 : 40;

  useEffect(() => { load(true); }, []);

  async function load(fullScreen = false) {
    if (fullScreen) setLoading(true); else setRefreshing(true);
    try {
      const { data: auth, error: authError } = await supabase.auth.getSession();
      if (authError) throw authError;
      const user = auth.session?.user;
      if (!user) { router.replace('/login'); return; }
      const { data: p, error: profileError } = await supabase.from('profiles').select('role,display_name,cafe_name').eq('id', user.id).maybeSingle();
      if (profileError) throw profileError;
      if (p) setProfile(p as Profile);
      const cafe = p?.role === 'cafe_owner_manager';
      const queries = cafe ? [
        supabase.from('jobs').select('*', { count: 'exact', head: true }).eq('owner_id', user.id).eq('active', true),
        supabase.from('applications').select('*,jobs!inner(owner_id)', { count: 'exact', head: true }).eq('jobs.owner_id', user.id).eq('status', 'matched'),
        supabase.from('notifications').select('*', { count: 'exact', head: true }).eq('recipient_id', user.id).is('read_at', null),
        supabase.from('discovery_matches').select('*', { count: 'exact', head: true }).eq('cafe_id', user.id),
      ] : [
        supabase.from('jobs').select('*', { count: 'exact', head: true }).eq('active', true),
        supabase.from('applications').select('*', { count: 'exact', head: true }).eq('barista_id', user.id).eq('status', 'matched'),
        supabase.from('notifications').select('*', { count: 'exact', head: true }).eq('recipient_id', user.id).is('read_at', null),
        supabase.from('discovery_matches').select('*', { count: 'exact', head: true }).eq('barista_id', user.id),
      ];
      const [jobs, legacyMatches, alerts, mutualMatches] = await Promise.all(queries);
      setCounts({ jobs: jobs.count || 0, matches: (legacyMatches.count || 0)+(mutualMatches.count||0), alerts: alerts.count || 0 });
    } catch (error) {
      console.error('Dashboard load failed', error);
      Alert.alert('Could not refresh your dashboard', 'Your app is still safe. Check your connection and try again.');
    } finally {
      setLoading(false); setRefreshing(false);
    }
  }

  if (loading) return <SafeAreaView style={s.safe}><View style={s.center}><ActivityIndicator size="large" color="#b75a1d" /></View></SafeAreaView>;

  return <SafeAreaView style={s.safe}>
    <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={s.wrap} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => load(false)} tintColor="#b75a1d" />}>
      <View style={s.header}><View><Text style={s.brand}>☕  Barista<Text style={s.orange}>Match</Text></Text><Text style={s.hello}>Hello, {firstName}!</Text><Text style={s.role}>{isCafe ? 'Café Owner' : 'Barista'}</Text></View><Pressable accessibilityRole="button" accessibilityLabel="Open settings" onPress={() => router.push('/settings')} style={s.settingsButton}><Text style={s.settingsIcon}>⚙</Text></Pressable></View>
      <View style={s.storyTitle}><View><Text style={s.kicker}>{isCafe ? 'YOUR CAFÉ TODAY' : 'YOUR COFFEE JOURNEY'}</Text><Text style={s.title}>{isCafe ? 'Hiring pulse' : 'Ready for what’s next?'}</Text></View><Text style={s.sparkle}>✦</Text></View>
      {isCafe ? <CafeDashboard counts={counts} /> : <BaristaDashboard counts={counts} progress={profileProgress} />}
    </ScrollView>
    <AppBottomNav active="home" role={role} />
  </SafeAreaView>;
}

function CafeDashboard({ counts }: { counts: { jobs: number; matches: number; alerts: number } }) {
  return <>
    <View style={s.stats}><MiniStat icon="▣" value={counts.jobs} label="Active jobs" bars={[10,18,13,25,20]} tint="#78954e" /><MiniStat icon="♟" value={counts.alerts} label="Discover" bars={[12,25,18,30,22]} tint="#e66a28" /><MiniStat icon="♥" value={counts.matches} label="Matches" bars={[9,16,22,18,27]} tint="#d96856" /></View>
    <Pressable onPress={() => Linking.openURL('https://www.baristajobmatch.com/pricing.html')} style={({ pressed }) => [s.blueprintPlan, pressed && s.pressed]}><View style={s.blueprintCrown}><Text style={s.crownText}>♕</Text></View><View style={s.blueprintPlanBody}><Text style={s.planLabel}>SUBSCRIPTION</Text><View style={s.planNameRow}><Text style={s.blueprintPlanTitle}>Pro</Text><View style={s.activePill}><Text style={s.activeText}>Active</Text></View></View><Text style={s.renewText}>Manage your plan and benefits</Text></View><Text style={s.planCup}>☕</Text></Pressable>
    <Pressable onPress={() => router.push('/post-job')} style={({ pressed }) => [s.actionHero, pressed && s.pressed]}><View style={s.actionContent}><Text style={s.actionTitle}>Post a job</Text><Text style={s.actionCopy}>Find your next great barista.</Text><View style={s.primaryButton}><Text style={s.primaryText}>Post a job  →</Text></View></View><Image source={require('../assets/cafe-storefront-icon.png')} resizeMode="contain" style={s.cafeStorefront} /></Pressable>
    <SectionHeader title="Hiring pulse" action="This week" onPress={() => router.push('/discover')} />
    <View style={s.chartCard}><View style={s.chart}>{[18,32,24,45,36,52,41].map((height, i) => <View key={i} style={s.chartColumn}><View style={[s.chartBar, { height, backgroundColor: i === 5 ? '#e66a28' : '#78954e' }]} /><Text style={s.day}>{['Mon','Tue','Wed','Thu','Fri','Sat','Sun'][i]}</Text></View>)}</View></View>
    <SectionHeader title="Nearby baristas" action="View all" onPress={() => router.push('/discover')} />
    <Pressable onPress={() => router.push('/discover')} style={({ pressed }) => [s.candidateStrip, pressed && s.pressed]}>{['AM','JT','SK','LP','RB'].map((initials, i) => <View key={initials} style={[s.candidateAvatar,{backgroundColor:['#d8a47f','#8ca36a','#d87c59','#b89a83','#7a9a7b'][i]}]}><Text style={s.candidateInitials}>{initials}</Text><View style={s.candidateOnline}/></View>)}<View style={s.addCandidate}><Text style={s.addCandidateText}>＋</Text></View></Pressable>
  </>;
}

function BaristaDashboard({ counts, progress }: { counts: { jobs: number; matches: number; alerts: number }; progress: number }) {
  return <>
    <Pressable onPress={() => router.push('/profile')} style={({ pressed }) => [s.progressCard, pressed && s.pressed]}><View style={s.progressTop}><View><Text style={s.progressLabel}>PROFILE</Text><Text style={s.progressValue}>{progress}% complete</Text></View><View style={s.mountain}><Text style={s.mountainText}>⛰</Text></View></View><View style={s.progressTrack}><View style={[s.progressFill, { width: `${progress}%` }]} /></View><View style={s.checkRow}><Text style={s.check}>✓</Text><Text style={s.checkText}>Add your skills and best experience</Text><Text style={s.chevron}>›</Text></View></Pressable>
    <View style={s.stats}><MiniStat icon="⌖" value={counts.jobs} label="Nearby jobs" bars={[12,22,17,28,34]} tint="#78954e" /><MiniStat icon="♥" value={counts.matches} label="Matches" bars={[8,14,23,18,27]} tint="#e66a28" /><MiniStat icon="●" value={counts.alerts} label="Messages" bars={[10,18,12,25,20]} tint="#659064" /></View>
    <Pressable onPress={() => router.push('/discover')} style={({ pressed }) => [s.actionHero, pressed && s.pressed]}><View style={s.actionContent}><Text style={s.actionTitle}>Find my next café</Text><Text style={s.actionCopy}>Explore opportunities hiring near you.</Text><View style={s.primaryButton}><Text style={s.primaryText}>Explore jobs  →</Text></View></View><Image source={require('../assets/barista-latte-pour.png')} resizeMode="contain" style={s.baristaPour} /></Pressable>
    <SectionHeader title="Top picks near you" action="View all" onPress={() => router.push('/discover')} />
    <View style={s.jobCard}><View style={s.jobImage}><Text style={s.jobEmoji}>☕</Text></View><View style={s.jobBody}><Text style={s.jobTitle}>Discover local cafés</Text><Text style={s.jobCopy}>Fresh opportunities selected for your profile</Text><View style={s.tags}><Text style={s.tag}>Nearby</Text><Text style={s.tag}>Hiring now</Text></View></View><Text style={s.bookmark}>♡</Text></View>
    <View style={s.quickRow}><Quick icon="♥" title="Matches" copy="See connections" onPress={() => router.push('/matches')} /><Quick icon="✉" title="Messages" copy="Start a chat" onPress={() => router.push('/messages')} /></View>
  </>;
}

function MiniStat({ icon, value, label, bars, tint }: { icon: string; value: number; label: string; bars: number[]; tint: string }) { return <View style={s.stat}><View style={[s.statIcon, { backgroundColor: `${tint}20` }]}><Text style={[s.statIconText, { color: tint }]}>{icon}</Text></View><Text style={s.statValue}>{value}</Text><Text numberOfLines={1} style={s.statLabel}>{label}</Text><View style={s.miniBars}>{bars.map((height, i) => <View key={i} style={[s.miniBar, { height, backgroundColor: tint }]} />)}</View></View>; }
function SectionHeader({ title, action, onPress }: { title: string; action: string; onPress: () => void }) { return <View style={s.sectionHeader}><Text style={s.sectionTitle}>{title}</Text><Pressable onPress={onPress}><Text style={s.sectionAction}>{action}  →</Text></Pressable></View>; }
function Quick({ icon, title, copy, onPress }: { icon: string; title: string; copy: string; onPress: () => void }) { return <Pressable onPress={onPress} style={({ pressed }) => [s.quick, pressed && s.pressed]}><Text style={s.quickIcon}>{icon}</Text><View><Text style={s.quickTitle}>{title}</Text><Text style={s.quickCopy}>{copy}</Text></View><Text style={s.quickArrow}>›</Text></Pressable>; }

const s = StyleSheet.create({
  safe:{flex:1,backgroundColor:'#fffaf3'},center:{flex:1,alignItems:'center',justifyContent:'center'},wrap:{paddingHorizontal:18,paddingTop:10,paddingBottom:28},pressed:{opacity:.82},
  header:{flexDirection:'row',justifyContent:'space-between',alignItems:'center',marginBottom:22},brand:{fontSize:16,fontWeight:'900',color:'#321708',marginBottom:18},orange:{color:'#c45b1d'},hello:{fontSize:25,fontWeight:'900',letterSpacing:-.7,color:'#20130d'},role:{fontSize:13,color:'#72645b',marginTop:2},settingsButton:{width:44,height:44,borderRadius:14,backgroundColor:'#fff',borderWidth:1,borderColor:'#eadccf',alignItems:'center',justifyContent:'center'},settingsIcon:{fontSize:23,color:'#321708'},
  storyTitle:{flexDirection:'row',justifyContent:'space-between',alignItems:'flex-end',marginBottom:12},kicker:{fontSize:9,fontWeight:'900',letterSpacing:1.5,color:'#b75a1d'},title:{fontSize:20,fontWeight:'900',color:'#26160e',marginTop:3},sparkle:{fontSize:27,color:'#e66a28'},
  stats:{flexDirection:'row',gap:8,marginBottom:13},stat:{flex:1,minHeight:133,borderRadius:19,borderWidth:1,borderColor:'#eadccf',backgroundColor:'#fff',padding:11},statIcon:{width:31,height:31,borderRadius:11,alignItems:'center',justifyContent:'center'},statIconText:{fontSize:16,fontWeight:'900'},statValue:{fontSize:25,fontWeight:'900',color:'#27150d',marginTop:7},statLabel:{fontSize:9,fontWeight:'700',color:'#6f6259',marginTop:1},miniBars:{height:35,flexDirection:'row',alignItems:'flex-end',gap:3,marginTop:8},miniBar:{flex:1,borderRadius:3,opacity:.82},
  blueprintPlan:{minHeight:112,backgroundColor:'#3b1b0b',borderRadius:22,padding:15,marginBottom:13,overflow:'hidden',flexDirection:'row',alignItems:'center'},blueprintCrown:{width:48,height:48,borderRadius:24,borderWidth:2,borderColor:'#e66a28',alignItems:'center',justifyContent:'center'},crownText:{fontSize:25,color:'#f1843b'},blueprintPlanBody:{flex:1,paddingHorizontal:12},planLabel:{fontSize:8,fontWeight:'900',letterSpacing:1.3,color:'#dcb89e'},planNameRow:{flexDirection:'row',alignItems:'center',gap:8,marginTop:3},blueprintPlanTitle:{fontSize:20,fontWeight:'900',color:'#fff'},activePill:{paddingHorizontal:8,paddingVertical:4,borderRadius:99,backgroundColor:'#547c45'},activeText:{fontSize:8,fontWeight:'900',color:'#fff'},renewText:{fontSize:10,color:'#e7d4c6',marginTop:5},planCup:{position:'absolute',right:12,bottom:20,fontSize:40,opacity:.16},
  actionHero:{minHeight:136,borderRadius:21,borderWidth:1,borderColor:'#ead7c8',backgroundColor:'#fff6ec',padding:17,marginBottom:20,overflow:'hidden'},actionContent:{maxWidth:'67%'},actionTitle:{fontSize:20,fontWeight:'900',color:'#28170e'},actionCopy:{fontSize:12,color:'#73665d',marginTop:4},primaryButton:{alignSelf:'flex-start',backgroundColor:'#cf5b16',borderRadius:12,paddingHorizontal:17,paddingVertical:10,marginTop:16},primaryText:{fontSize:12,fontWeight:'900',color:'#fff'},cafeStorefront:{position:'absolute',right:5,bottom:-3,width:122,height:122},baristaPour:{position:'absolute',right:-7,bottom:-9,width:132,height:132},
  sectionHeader:{flexDirection:'row',justifyContent:'space-between',alignItems:'center',marginBottom:10},sectionTitle:{fontSize:18,fontWeight:'900',color:'#28170e'},sectionAction:{fontSize:11,fontWeight:'800',color:'#4c814c'},chartCard:{backgroundColor:'#fff',borderWidth:1,borderColor:'#eadccf',borderRadius:20,padding:15,marginBottom:13},chart:{height:72,flexDirection:'row',alignItems:'flex-end',justifyContent:'space-around'},chartColumn:{flex:1,alignItems:'center',justifyContent:'flex-end'},chartBar:{width:15,borderRadius:6},day:{fontSize:7,color:'#786a61',marginTop:6},candidateStrip:{minHeight:74,backgroundColor:'#fff',borderWidth:1,borderColor:'#eadccf',borderRadius:20,paddingHorizontal:14,marginBottom:13,flexDirection:'row',alignItems:'center',justifyContent:'space-between'},candidateAvatar:{width:43,height:43,borderRadius:22,alignItems:'center',justifyContent:'center'},candidateInitials:{fontSize:11,fontWeight:'900',color:'#fff'},candidateOnline:{position:'absolute',right:0,bottom:0,width:11,height:11,borderRadius:6,backgroundColor:'#5f965d',borderWidth:2,borderColor:'#fff'},addCandidate:{width:43,height:43,borderRadius:22,borderWidth:1,borderColor:'#eadccf',alignItems:'center',justifyContent:'center'},addCandidateText:{fontSize:20,color:'#6f6259'},
  progressCard:{backgroundColor:'#fff',borderWidth:1,borderColor:'#eadccf',borderRadius:21,padding:16,marginBottom:13},progressTop:{flexDirection:'row',justifyContent:'space-between',alignItems:'center'},progressLabel:{fontSize:9,fontWeight:'900',letterSpacing:1.3,color:'#73904e'},progressValue:{fontSize:22,fontWeight:'900',color:'#28170e',marginTop:4},mountain:{width:54,height:54,borderRadius:27,backgroundColor:'#eef3e7',alignItems:'center',justifyContent:'center'},mountainText:{fontSize:28},progressTrack:{height:8,borderRadius:8,backgroundColor:'#e8e1d8',overflow:'hidden',marginTop:13},progressFill:{height:'100%',borderRadius:8,backgroundColor:'#5e8c50'},checkRow:{flexDirection:'row',alignItems:'center',marginTop:14},check:{width:21,height:21,borderRadius:11,backgroundColor:'#5e8c50',color:'#fff',textAlign:'center',fontWeight:'900',lineHeight:21},checkText:{flex:1,fontSize:11,color:'#62564f',paddingHorizontal:9},chevron:{fontSize:22,color:'#9b6a49'},
  jobCard:{flexDirection:'row',alignItems:'center',backgroundColor:'#fff',borderWidth:1,borderColor:'#eadccf',borderRadius:20,padding:12,marginBottom:13},jobImage:{width:62,height:72,borderRadius:15,backgroundColor:'#3b1b0b',alignItems:'center',justifyContent:'center'},jobEmoji:{fontSize:29},jobBody:{flex:1,paddingHorizontal:12},jobTitle:{fontSize:14,fontWeight:'900',color:'#28170e'},jobCopy:{fontSize:10,lineHeight:14,color:'#73665d',marginTop:3},tags:{flexDirection:'row',gap:5,marginTop:8},tag:{fontSize:8,color:'#4f7045',backgroundColor:'#edf3e9',borderRadius:8,paddingHorizontal:7,paddingVertical:4},bookmark:{fontSize:24,color:'#b75a1d'},
  quickRow:{flexDirection:'row',gap:9},quick:{flex:1,minHeight:78,flexDirection:'row',alignItems:'center',backgroundColor:'#fff',borderWidth:1,borderColor:'#eadccf',borderRadius:18,padding:12},quickIcon:{fontSize:22,color:'#c45b1d',marginRight:9},quickTitle:{fontSize:12,fontWeight:'900',color:'#28170e'},quickCopy:{fontSize:9,color:'#81736a',marginTop:2},quickArrow:{marginLeft:'auto',fontSize:20,color:'#b75a1d'},
});
