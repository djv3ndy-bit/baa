import { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, SafeAreaView, StyleSheet, View } from 'react-native';
import { router } from 'expo-router';
import { QuietFocusHome } from '@/components/QuietFocusHome';
import { supabase } from '@/lib/supabase';

type Role = 'barista' | 'cafe_owner_manager';
type Profile = { role?: Role; display_name?: string | null; cafe_name?: string | null; avatar_url?:string|null; location?:string|null; bio?:string|null; skills?:string[]|null; availability?:string|null; experience?:string|null; pay_expectation?:string|null; cafe_address?:string|null; open_hours?:string|null; shop_type?:string|null; barista_preferences?:string|null };
type DashboardCounts = { jobs: number; matches: number; alerts: number; candidates: number };
const CAFE_PLAN_COPY = 'Your first job and first hire are included.';

function completion(profile:Profile){
  const fields=profile.role==='cafe_owner_manager'
    ? [profile.cafe_name,profile.avatar_url,profile.location,profile.bio,profile.cafe_address,profile.open_hours,profile.shop_type,profile.barista_preferences]
    : [profile.display_name,profile.avatar_url,profile.location,profile.bio,profile.skills,profile.availability,profile.experience,profile.pay_expectation];
  const completed=fields.filter(value=>Array.isArray(value)?value.length>0:Boolean(String(value||'').trim())).length;
  return Math.round((completed/fields.length)*100);
}

export default function HomeScreen() {
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [profile, setProfile] = useState<Profile>({});
  const [counts, setCounts] = useState<DashboardCounts>({ jobs: 0, matches: 0, alerts: 0, candidates:0 });
  const role: Role = profile.role === 'cafe_owner_manager' ? 'cafe_owner_manager' : 'barista';
  const isCafe = role === 'cafe_owner_manager';
  const name = profile.cafe_name || profile.display_name || (isCafe ? 'Your café' : 'Barista');
  const firstName = name.trim().split(/\s+/)[0] || 'there';
  const profileProgress = completion(profile);

  useEffect(() => { load(true); }, []);

  async function load(fullScreen = false) {
    if (fullScreen) setLoading(true); else setRefreshing(true);
    try {
      const { data: auth, error: authError } = await supabase.auth.getSession();
      if (authError) throw authError;
      const user = auth.session?.user;
      if (!user) { router.replace('/login'); return; }
      const { data: p, error: profileError } = await supabase.from('profiles').select('role,display_name,cafe_name,avatar_url,location,bio,skills,availability,experience,pay_expectation,cafe_address,open_hours,shop_type,barista_preferences').eq('id', user.id).maybeSingle();
      if (profileError) throw profileError;
      if (p) setProfile(p as Profile);
      const cafe = p?.role === 'cafe_owner_manager';
      if(cafe){
        const [jobs,legacyMatches,alerts,mutualMatches,candidates]=await Promise.all([
          supabase.from('jobs').select('*',{count:'exact',head:true}).eq('owner_id',user.id).eq('active',true),
          supabase.from('applications').select('*,jobs!inner(owner_id)',{count:'exact',head:true}).eq('jobs.owner_id',user.id).eq('status','matched'),
          supabase.from('notifications').select('*',{count:'exact',head:true}).eq('recipient_id',user.id).is('read_at',null),
          supabase.from('discovery_matches').select('*',{count:'exact',head:true}).eq('cafe_id',user.id),
          supabase.from('applications').select('*,jobs!inner(owner_id)',{count:'exact',head:true}).eq('jobs.owner_id',user.id).eq('status','interested'),
        ]);
        setCounts({jobs:jobs.count||0,matches:(legacyMatches.count||0)+(mutualMatches.count||0),alerts:alerts.count||0,candidates:candidates.count||0});
      }else{
        const [jobs,legacyMatches,alerts,mutualMatches]=await Promise.all([
          supabase.from('jobs').select('*',{count:'exact',head:true}).eq('active',true),
          supabase.from('applications').select('*',{count:'exact',head:true}).eq('barista_id',user.id).eq('status','matched'),
          supabase.from('notifications').select('*',{count:'exact',head:true}).eq('recipient_id',user.id).is('read_at',null),
          supabase.from('discovery_matches').select('*',{count:'exact',head:true}).eq('barista_id',user.id),
        ]);
        setCounts({jobs:jobs.count||0,matches:(legacyMatches.count||0)+(mutualMatches.count||0),alerts:alerts.count||0,candidates:0});
      }
    } catch (error) {
      console.error('Dashboard load failed', error);
      Alert.alert('Could not refresh your dashboard', 'Your app is still safe. Check your connection and try again.');
    } finally {
      setLoading(false); setRefreshing(false);
    }
  }

  if (loading) return <SafeAreaView style={s.safe}><View style={s.center}><ActivityIndicator size="large" color="#b75a1d" /></View></SafeAreaView>;

  return (
    <QuietFocusHome
      cafePlanCopy={CAFE_PLAN_COPY}
      counts={counts}
      firstName={firstName}
      location={profile.location}
      onOpenSettings={() => router.push('/settings')}
      onRefresh={() => load(false)}
      profileProgress={profileProgress}
      refreshing={refreshing}
      role={role}
    />
  );
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#fffdf9' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});
