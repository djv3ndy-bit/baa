import { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Animated, Dimensions, Image, PanResponder, Pressable, SafeAreaView, ScrollView, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { supabase } from '@/lib/supabase';
import { AppBottomNav } from '@/components/AppBottomNav';
import { sendDiscoveryInterest } from '@/lib/discovery';

type Job = {
  id: string;
  owner_id: string;
  title: string;
  location: string | null;
  pay_min: number | null;
  pay_max: number | null;
  schedule: string | null;
  description: string | null;
  required_skills: string[] | null;
  owner?: { cafe_name?: string | null; avatar_url?: string | null };
};
type Candidate = { id:string; display_name:string|null; location:string|null; bio:string|null; skills:string[]|null; availability:string|null; experience:string|null; avatar_url:string|null; preferred_city?:string|null; preferred_state?:string|null; preferred_postal_code?:string|null };

const normalizePlace=(value?:string|null)=>String(value||'').trim().toLowerCase().replace(/[^a-z0-9]+/g,' ');
const locationTokens=(value?:string|null)=>new Set(normalizePlace(value).split(' ').filter(token=>token.length>1));
function sharesLocation(home?:string|null,...places:(string|null|undefined)[]){const base=locationTokens(home);if(!base.size)return true;return places.some(place=>{const other=locationTokens(place);return [...base].some(token=>other.has(token))})}

const WIDTH = Dimensions.get('window').width;
const SWIPE = Math.min(110, WIDTH * 0.28);

export default function DiscoverScreen() {
  const [loading, setLoading] = useState(true);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [role,setRole]=useState<'barista'|'cafe_owner_manager'>('barista');
  const [candidates,setCandidates]=useState<Candidate[]>([]);
  const [index, setIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const [expandedCandidateId,setExpandedCandidateId]=useState<string|null>(null);
  const translate = useRef(new Animated.ValueXY()).current;
  const current = jobs[index];

  useEffect(() => { loadJobs(); }, []);

  async function loadJobs() {
    setLoading(true);
    const { data: auth } = await supabase.auth.getUser();
    if (!auth.user) return router.replace('/login');

    const { data: profile } = await supabase.from('profiles').select('role,location,preferred_city,preferred_state,preferred_postal_code').eq('id', auth.user.id).maybeSingle();
    const accountRole=profile?.role==='cafe_owner_manager'?'cafe_owner_manager':'barista';
    setRole(accountRole);
    const [{data:sentInterests},{data:existingMatches}]=await Promise.all([
      supabase.from('discovery_interests').select('target_id').eq('sender_id',auth.user.id),
      supabase.from('discovery_matches').select('barista_id,cafe_id').or(`barista_id.eq.${auth.user.id},cafe_id.eq.${auth.user.id}`),
    ]);
    const hiddenPeople=new Set([...(sentInterests||[]).map(row=>row.target_id),...(existingMatches||[]).map(row=>accountRole==='barista'?row.cafe_id:row.barista_id)]);
    if(accountRole==='cafe_owner_manager'){
      const {data,error}=await supabase.from('profiles').select('id,display_name,location,bio,skills,availability,experience,avatar_url,preferred_city,preferred_state,preferred_postal_code').eq('role','barista').eq('is_discoverable',true).neq('id',auth.user.id).order('updated_at',{ascending:false}).limit(100);
      if(error)Alert.alert('Could not load nearby baristas',error.message);
      const nearby=(data||[]).filter(person=>!hiddenPeople.has(person.id)&&sharesLocation(profile?.location,person.location,person.preferred_city,person.preferred_state,person.preferred_postal_code));
      setCandidates(nearby as Candidate[]);
      setLoading(false);
      return;
    }

    const [{ data: swipes }, { data: applications }, { data: rawJobs, error }] = await Promise.all([
      supabase.from('job_swipes').select('job_id').eq('user_id', auth.user.id),
      supabase.from('applications').select('job_id').eq('barista_id', auth.user.id),
      supabase.from('jobs').select('id,owner_id,title,location,pay_min,pay_max,schedule,description,required_skills,created_at').eq('active', true).order('created_at', { ascending: false }),
    ]);

    if (error) {
      Alert.alert('Could not load jobs', error.message);
      setLoading(false);
      return;
    }

    const hidden = new Set([...(swipes || []).map(x => x.job_id), ...(applications || []).map(x => x.job_id)]);
    const preferred=[profile?.preferred_city,profile?.preferred_state,profile?.preferred_postal_code].filter(Boolean).join(' ')||profile?.location;
    const visible = (rawJobs || []).filter(job => !hidden.has(job.id)&&!hiddenPeople.has(job.owner_id)&&sharesLocation(preferred,job.location));
    const ownerIds = [...new Set(visible.map(job => job.owner_id))];
    let owners: Record<string, { cafe_name?: string | null; avatar_url?: string | null }> = {};
    if (ownerIds.length) {
      const { data } = await supabase.from('profiles').select('id,cafe_name,avatar_url').in('id', ownerIds);
      owners = Object.fromEntries((data || []).map(p => [p.id, p]));
    }

    setJobs(visible.map(job => ({ ...job, owner: owners[job.owner_id] })) as Job[]);
    setIndex(0);
    setLoading(false);
  }

  const rotate = translate.x.interpolate({ inputRange: [-WIDTH, 0, WIDTH], outputRange: ['-8deg', '0deg', '8deg'] });
  const interestedOpacity = translate.x.interpolate({ inputRange: [0, SWIPE], outputRange: [0, 1], extrapolate: 'clamp' });
  const passOpacity = translate.x.interpolate({ inputRange: [-SWIPE, 0], outputRange: [1, 0], extrapolate: 'clamp' });

  const responder = useMemo(() => PanResponder.create({
    onMoveShouldSetPanResponder: (_, g) => Math.abs(g.dx) > 8,
    onPanResponderMove: Animated.event([null, { dx: translate.x, dy: translate.y }], { useNativeDriver: false }),
    onPanResponderRelease: (_, g) => {
      if (g.dx > SWIPE) finishSwipe('interested');
      else if (g.dx < -SWIPE) finishSwipe('pass');
      else Animated.spring(translate, { toValue: { x: 0, y: 0 }, useNativeDriver: true, friction: 6 }).start();
    },
  }), [current?.id, busy]);

  function finishSwipe(decision: 'pass' | 'interested') {
    if (!current || busy) return;
    const direction = decision === 'interested' ? WIDTH * 1.25 : -WIDTH * 1.25;
    Animated.timing(translate, { toValue: { x: direction, y: 0 }, duration: 180, useNativeDriver: true }).start(() => {
      translate.setValue({ x: 0, y: 0 });
      saveDecision(decision);
    });
  }

  async function saveDecision(decision: 'pass' | 'interested') {
    if (!current || busy) return;
    setBusy(true);
    const { data: auth } = await supabase.auth.getUser();
    if (!auth.user) return router.replace('/login');

    if (decision === 'interested') {
      try {
        const result=await sendDiscoveryInterest(auth.user.id,current.owner_id,'barista');
        if(result.matched)Alert.alert('It’s a match!','You can now message this café from Matches.');
      } catch (error) {
        setBusy(false);
        Alert.alert('Interest not sent', error instanceof Error ? error.message : 'Please try again.');
        return;
      }
    }

    const { error: swipeError } = await supabase.from('job_swipes').upsert({ user_id: auth.user.id, job_id: current.id, decision }, { onConflict: 'user_id,job_id' });
    if (swipeError) {
      setBusy(false);
      Alert.alert('Try again', swipeError.message);
      return;
    }

    setIndex(i => i + 1);
    setBusy(false);
  }

  async function interestInBarista(person:Candidate){
    if(busy)return;setBusy(true);
    try{const {data:auth}=await supabase.auth.getUser();if(!auth.user)return router.replace('/login');const result=await sendDiscoveryInterest(auth.user.id,person.id,'cafe_owner_manager');setCandidates(list=>list.filter(item=>item.id!==person.id));Alert.alert(result.matched?'It’s a match!':'Interest sent',result.matched?'You can now message this barista from Matches.':'We’ll let you know when this barista is interested too.');}
    catch(error){Alert.alert('Interest not sent',error instanceof Error?error.message:'Please try again.')}finally{setBusy(false)}
  }

  if (loading) return <SafeAreaView style={styles.safe}><View style={styles.center}><ActivityIndicator size="large" color="#321708" /></View></SafeAreaView>;

  if(role==='cafe_owner_manager')return <SafeAreaView style={styles.safe}>
    <View style={styles.header}><View><Text style={styles.logo}>Barista<Text style={styles.logoAccent}>Match</Text></Text><Text style={styles.tagline}>DISCOVER · CONNECT · HIRE</Text></View><Pressable onPress={()=>router.push('/settings')} style={styles.filter}><Text style={styles.filterText}>⚙</Text></Pressable></View>
    <ScrollView contentContainerStyle={styles.candidateList}>
      {candidates.length?<>
        <Text style={styles.nearbyTitle}>Baristas near your café</Text>
        <Text style={styles.nearbyCopy}>Discoverable profiles matching your saved location.</Text>
        {candidates.map(person=>{
          const expanded=expandedCandidateId===person.id;
          return <View key={person.id} style={styles.candidateCard}>
            <View style={styles.candidateTop}>
              <View style={styles.candidatePhoto}>{person.avatar_url?<Image source={{uri:person.avatar_url}} style={styles.candidateImage}/>:<Text style={styles.candidateEmoji}>👤</Text>}</View>
              <View style={styles.candidateBody}>
                <Text numberOfLines={2} style={styles.candidateName}>{person.display_name||'Local barista'}</Text>
                <Text numberOfLines={1} style={styles.candidateLocation}>📍 {person.location||'Nearby'}</Text>
                <Text numberOfLines={3} style={styles.candidateBio}>{person.bio||person.experience||'Ready for a new café opportunity.'}</Text>
              </View>
            </View>
            {!!person.skills?.length&&<View style={styles.candidateTags}>{person.skills.slice(0,3).map((skill,index)=><Tag key={`${skill}-${index}`} text={cleanSkill(skill)} soft/>)}</View>}
            {expanded&&<View style={styles.profileDetails}>
              <Text style={styles.profileDetailLabel}>About</Text><Text style={styles.profileDetailText}>{person.bio||'This barista is still adding their introduction.'}</Text>
              <Text style={styles.profileDetailLabel}>Experience</Text><Text style={styles.profileDetailText}>{person.experience||'Experience details not added yet.'}</Text>
              <Text style={styles.profileDetailLabel}>Availability</Text><Text style={styles.profileDetailText}>{person.availability||'Availability not added yet.'}</Text>
            </View>}
            <View style={styles.candidateActions}>
              <Pressable style={styles.profileButton} onPress={()=>setExpandedCandidateId(expanded?null:person.id)}><Text style={styles.profileButtonText}>{expanded?'Hide profile':'View profile'}</Text></Pressable>
              <Pressable disabled={busy} style={[styles.interestButton,busy&&styles.disabledButton]} onPress={()=>interestInBarista(person)}><Text style={styles.interestButtonText}>Interested</Text></Pressable>
            </View>
          </View>
        })}
      </>:<View style={styles.emptyWrap}><View style={styles.emptyIcon}><Text style={{fontSize:34}}>👥</Text></View><Text style={styles.emptyTitle}>No nearby baristas yet</Text><Text style={styles.emptyCopy}>Add your café location and check again as local baristas complete their profiles.</Text><Pressable style={styles.primary} onPress={()=>router.push('/profile')}><Text style={styles.primaryText}>Update café location</Text></Pressable></View>}
    </ScrollView>
    <AppBottomNav active="discover" role="cafe_owner_manager"/>
  </SafeAreaView>;

  if (!current) return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.emptyWrap}>
        <Text style={styles.logo}>Barista<Text style={styles.logoAccent}>Match</Text></Text>
        <View style={styles.emptyIcon}><Text style={{fontSize:34}}>☕</Text></View>
        <Text style={styles.emptyTitle}>You’re all caught up</Text>
        <Text style={styles.emptyCopy}>New café opportunities will appear here as soon as they’re posted.</Text>
        <Pressable style={styles.primary} onPress={loadJobs}><Text style={styles.primaryText}>Refresh jobs</Text></Pressable>
        <Pressable style={styles.linkButton} onPress={() => router.replace('/home')}><Text style={styles.linkText}>Back to home</Text></Pressable>
      </View>
    </SafeAreaView>
  );

  const cafe = current.owner?.cafe_name || 'Local Coffee Shop';
  const pay = current.pay_min && current.pay_max ? `$${current.pay_min}–$${current.pay_max}/hr` : current.pay_min ? `$${current.pay_min}/hr` : 'Pay listed by café';

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.header}>
        <View><Text style={styles.logo}>Barista<Text style={styles.logoAccent}>Match</Text></Text><Text style={styles.tagline}>SWIPE · MATCH · BREW</Text></View>
      </View>

      <View style={styles.deck}>
        <Animated.View {...responder.panHandlers} style={[styles.card,{ transform:[...translate.getTranslateTransform(),{ rotate }] }]}>
          <View style={styles.photo}>
            <Text style={styles.photoEmoji}>☕</Text>
            <View style={styles.photoBadge}><Text style={styles.photoBadgeText}>CAFÉ</Text></View>
            <Animated.View style={[styles.choiceBadge,styles.interestedBadge,{opacity:interestedOpacity}]}><Text style={styles.choiceText}>INTERESTED</Text></Animated.View>
            <Animated.View style={[styles.choiceBadge,styles.passBadge,{opacity:passOpacity}]}><Text style={styles.choiceText}>PASS</Text></Animated.View>
          </View>

          <ScrollView style={styles.details} contentContainerStyle={{paddingBottom:18}} showsVerticalScrollIndicator={false}>
            <View style={styles.titleRow}><View style={{flex:1}}><Text style={styles.cafe}>{cafe}</Text><Text style={styles.jobTitle}>{current.title}</Text></View><Text style={styles.verify}>✓</Text></View>
            <Text style={styles.meta}>📍 {current.location || 'Location available soon'}</Text>
            <View style={styles.tags}><Tag text={pay}/><Tag text={current.schedule || 'Flexible schedule'}/></View>
            {!!current.required_skills?.length && <View style={styles.skills}>{current.required_skills.slice(0,4).map(skill => <Tag key={skill} text={skill} soft />)}</View>}
            <Text style={styles.description}>{current.description || 'This café is looking for a great barista to join the team.'}</Text>
          </ScrollView>
        </Animated.View>
      </View>

      <View style={styles.actions}>
        <Pressable disabled={busy} style={[styles.action,styles.pass]} onPress={() => finishSwipe('pass')}><Text style={styles.actionPass}>×</Text></Pressable>
        <Pressable style={[styles.action,styles.info]} onPress={() => Alert.alert(current.title,current.description || 'No additional description yet.')}><Text style={styles.actionInfo}>i</Text></Pressable>
        <Pressable disabled={busy} style={[styles.action,styles.heart]} onPress={() => finishSwipe('interested')}><Text style={styles.actionHeart}>♥</Text></Pressable>
      </View>

      <AppBottomNav active="discover" role="barista"/>
    </SafeAreaView>
  );
}

function cleanSkill(value:string){const text=String(value||'').trim().replace(/[.,;:]+$/,'');return text.replace(/\b\w/g,letter=>letter.toUpperCase())}
function Tag({text,soft=false}:{text:string;soft?:boolean}){return <View style={[styles.tag,soft&&styles.tagSoft]}><Text numberOfLines={1} style={[styles.tagText,soft&&styles.tagSoftText]}>{text}</Text></View>}
function Nav({icon,label,active,onPress}:{icon:string;label:string;active?:boolean;onPress:()=>void}){return <Pressable style={styles.navItem} onPress={onPress}><Text style={[styles.navIcon,active&&styles.navActive]}>{icon}</Text><Text style={[styles.navLabel,active&&styles.navActive]}>{label}</Text></Pressable>}

const styles=StyleSheet.create({
  safe:{flex:1,backgroundColor:'#fbf7f1'},center:{flex:1,alignItems:'center',justifyContent:'center'},header:{paddingHorizontal:20,paddingTop:6,paddingBottom:12,flexDirection:'row',alignItems:'center',justifyContent:'space-between'},logo:{fontSize:24,fontWeight:'900',color:'#321708'},logoAccent:{color:'#a95820'},tagline:{fontSize:9,fontWeight:'900',letterSpacing:1.5,color:'#9a7c68',marginTop:2},filter:{width:42,height:42,borderRadius:14,borderWidth:1,borderColor:'#e4d6cb',backgroundColor:'#fff',alignItems:'center',justifyContent:'center'},filterText:{fontSize:18,color:'#321708'},
  deck:{flex:1,paddingHorizontal:18,paddingBottom:4},card:{flex:1,backgroundColor:'#fff',borderRadius:27,overflow:'hidden',borderWidth:1,borderColor:'#eadfd5',shadowColor:'#321708',shadowOpacity:.14,shadowRadius:18,shadowOffset:{width:0,height:8},elevation:7},photo:{height:'44%',minHeight:250,backgroundColor:'#24150d',alignItems:'center',justifyContent:'center',position:'relative'},photoEmoji:{fontSize:86},photoBadge:{position:'absolute',left:18,bottom:16,borderRadius:999,backgroundColor:'#fff',paddingHorizontal:11,paddingVertical:7},photoBadgeText:{fontSize:10,fontWeight:'900',color:'#321708',letterSpacing:1.3},choiceBadge:{position:'absolute',top:24,borderWidth:3,borderRadius:9,paddingHorizontal:12,paddingVertical:7,transform:[{rotate:'-7deg'}]},interestedBadge:{right:18,borderColor:'#2f7c42'},passBadge:{left:18,borderColor:'#b33e32',transform:[{rotate:'7deg'}]},choiceText:{fontWeight:'900',fontSize:18,color:'#fff'},
  details:{flex:1},titleRow:{flexDirection:'row',gap:10,paddingHorizontal:20,paddingTop:18,alignItems:'flex-start'},cafe:{fontSize:22,fontWeight:'900',color:'#21150f'},jobTitle:{fontSize:16,fontWeight:'700',color:'#7d6d62',marginTop:3},verify:{width:25,height:25,textAlign:'center',textAlignVertical:'center',borderRadius:13,backgroundColor:'#f4e7dc',color:'#a95820',fontWeight:'900'},meta:{paddingHorizontal:20,marginTop:12,color:'#746a61',fontSize:14},tags:{flexDirection:'row',flexWrap:'wrap',gap:8,paddingHorizontal:20,marginTop:14},skills:{flexDirection:'row',flexWrap:'wrap',gap:7,paddingHorizontal:20,marginTop:9},tag:{maxWidth:'100%',backgroundColor:'#321708',borderRadius:999,paddingHorizontal:11,paddingVertical:7},tagText:{flexShrink:1,color:'#fff',fontSize:11,fontWeight:'800'},tagSoft:{backgroundColor:'#f3e8de'},tagSoftText:{color:'#6d381c'},description:{paddingHorizontal:20,marginTop:15,fontSize:14,lineHeight:21,color:'#5f554e'},
  actions:{height:84,flexDirection:'row',alignItems:'center',justifyContent:'center',gap:20},action:{alignItems:'center',justifyContent:'center',borderRadius:999,backgroundColor:'#fff',borderWidth:1,borderColor:'#eadfd5',shadowColor:'#321708',shadowOpacity:.08,shadowRadius:8,shadowOffset:{width:0,height:3}},pass:{width:58,height:58},info:{width:50,height:50},heart:{width:62,height:62,backgroundColor:'#2f7c42',borderColor:'#2f7c42'},actionPass:{fontSize:38,color:'#c84b3e',fontWeight:'300',marginTop:-5},actionInfo:{fontSize:22,fontWeight:'800',color:'#321708'},actionHeart:{fontSize:28,color:'#fff'},
  bottomNav:{height:67,borderTopWidth:1,borderTopColor:'#eadfd5',backgroundColor:'#fff',flexDirection:'row',justifyContent:'space-around',alignItems:'center',paddingBottom:3},navItem:{alignItems:'center',justifyContent:'center',minWidth:62},navIcon:{fontSize:20,color:'#99897f'},navLabel:{fontSize:10,color:'#99897f',marginTop:2,fontWeight:'700'},navActive:{color:'#321708'},
  emptyWrap:{flex:1,alignItems:'center',justifyContent:'center',padding:28},emptyIcon:{width:86,height:86,borderRadius:28,backgroundColor:'#f3e8de',alignItems:'center',justifyContent:'center',marginTop:28},emptyTitle:{fontSize:28,fontWeight:'900',color:'#321708',marginTop:20},emptyCopy:{textAlign:'center',fontSize:15,lineHeight:22,color:'#746a61',marginTop:9,maxWidth:310},primary:{marginTop:24,backgroundColor:'#321708',paddingHorizontal:24,paddingVertical:14,borderRadius:14},primaryText:{color:'#fff',fontWeight:'900'},linkButton:{marginTop:14,padding:10},linkText:{color:'#a95820',fontWeight:'800'}
  ,candidateList:{padding:18,paddingBottom:30},nearbyTitle:{fontSize:25,fontWeight:'900',color:'#321708'},nearbyCopy:{fontSize:13,lineHeight:19,color:'#746a61',marginTop:4,marginBottom:16},candidateCard:{backgroundColor:'#fff',borderWidth:1,borderColor:'#eadfd5',borderRadius:22,padding:14,marginBottom:13,shadowColor:'#321708',shadowOpacity:.05,shadowRadius:9,shadowOffset:{width:0,height:4},elevation:2},candidateTop:{flexDirection:'row',alignItems:'flex-start'},candidatePhoto:{width:78,height:88,borderRadius:18,backgroundColor:'#f3e8de',overflow:'hidden',alignItems:'center',justifyContent:'center',flexShrink:0},candidateImage:{width:'100%',height:'100%',resizeMode:'cover'},candidateEmoji:{fontSize:32},candidateBody:{flex:1,minWidth:0,paddingLeft:13},candidateName:{fontSize:19,lineHeight:23,fontWeight:'900',color:'#321708'},candidateLocation:{fontSize:12,color:'#746a61',marginTop:4},candidateBio:{fontSize:12,lineHeight:18,color:'#746a61',marginTop:7},candidateTags:{flexDirection:'row',flexWrap:'wrap',gap:6,marginTop:12},profileDetails:{borderTopWidth:1,borderTopColor:'#f0e7df',marginTop:14,paddingTop:12},profileDetailLabel:{fontSize:9,fontWeight:'900',letterSpacing:1.1,textTransform:'uppercase',color:'#9b8778',marginTop:8},profileDetailText:{fontSize:12,lineHeight:18,color:'#4c4039',marginTop:3},candidateActions:{flexDirection:'row',gap:9,marginTop:14},profileButton:{flex:1,borderWidth:1,borderColor:'#d9c7b9',borderRadius:12,paddingHorizontal:12,paddingVertical:11,alignItems:'center',justifyContent:'center'},profileButtonText:{fontSize:12,fontWeight:'900',color:'#321708'},interestButton:{flex:1,backgroundColor:'#321708',borderRadius:12,paddingHorizontal:12,paddingVertical:12,alignItems:'center',justifyContent:'center'},interestButtonText:{fontSize:12,fontWeight:'900',color:'#fff'},disabledButton:{opacity:.55}
});
