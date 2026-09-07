import { useCallback, useState } from 'react';
import { ActivityIndicator, AppState, Pressable, SafeAreaView, StyleSheet, Text, View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { QuietFocusHome } from '@/components/QuietFocusHome';
import { supabase } from '@/lib/supabase';
import { getCurrentContext } from '@/lib/session';
import { getProfileReadiness } from '@/lib/profilePrivacy';
import { workAreaLabel } from '@/lib/floridaLocation';
import { DashboardCounts, emptyDashboardCounts, loadHomeSummary } from '@/lib/homeSummary';
import { LatestMessageRequest, messageError, withMessageDeadline } from '@/lib/messaging';

const CAFE_PLAN_COPY = 'Your first job and first hire are included.';

export default function HomeScreen() {
  const [loading, setLoading] = useState(true), [refreshing, setRefreshing] = useState(false);
  const [profile, setProfile] = useState<Record<string, any> | null>(null);
  const [counts, setCounts] = useState<DashboardCounts>(emptyDashboardCounts);
  const [profileProgress, setProfileProgress] = useState(0), [error, setError] = useState(''), [attempt, setAttempt] = useState(0);

  useFocusEffect(useCallback(() => {
    let live = true, userId = '';
    const requests = new LatestMessageRequest();
    let channel: ReturnType<typeof supabase.channel> | null = null;
    async function load() {
      const current = requests.begin();
      setRefreshing(true);
      try {
        const context = await withMessageDeadline(getCurrentContext());
        if (!live || !current()) return;
        if (!context.user) { router.replace('/login'); return; }
        if (!context.role || !context.profile) { router.replace('/signup'); return; }
        userId = context.user.id;
        const [summary, demographics] = await Promise.all([
          loadHomeSummary(supabase, userId, context.role, context.profile),
          context.role === 'barista' ? withMessageDeadline(supabase.from('profile_demographics').select('date_of_birth').eq('user_id', userId).maybeSingle()) : Promise.resolve({ data: null, error: null }),
        ]);
        if (demographics.error) throw demographics.error;
        if (!live || !current()) return;
        const readiness = getProfileReadiness({ ...context.profile, date_of_birth: demographics.data?.date_of_birth }, context.role);
        const required = context.role === 'barista' ? 9 : 8;
        setProfile(context.profile); setProfileProgress(Math.round((required - readiness.missing.length) / required * 100)); setCounts(summary); setError('');
        if (!channel) {
          channel = supabase.channel(`mobile-home-${userId}`)
            .on('postgres_changes', { event: '*', schema: 'public', table: 'notifications', filter: `recipient_id=eq.${userId}` }, () => { void load(); })
            .on('postgres_changes', { event: '*', schema: 'public', table: 'discovery_message_notifications', filter: `recipient_id=eq.${userId}` }, () => { void load(); })
            .subscribe();
        }
      } catch (cause) { if (live && current()) setError(messageError(cause, 'Your dashboard could not refresh. Check your connection and try again.')); }
      finally { if (live && current()) { setLoading(false); setRefreshing(false); } }
    }
    void load();
    const appState = AppState.addEventListener('change', state => { if (state === 'active') void load(); });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      if (userId && (event === 'SIGNED_OUT' || (session && session.user.id !== userId))) {
        live = false; requests.invalidate(); setProfile(null); setCounts(emptyDashboardCounts); router.replace('/login');
      }
    });
    return () => { live = false; requests.invalidate(); appState.remove(); subscription.unsubscribe(); if (channel) void supabase.removeChannel(channel); };
  }, [attempt]));

  const refresh = () => setAttempt(value => value + 1);
  if (loading) return <SafeAreaView style={s.safe}><View style={s.center}><ActivityIndicator size="large" color="#b75a1d" /><Text style={s.copy}>Loading your dashboard…</Text></View></SafeAreaView>;
  if (!profile) return <SafeAreaView style={s.safe}><View style={s.center}><Text style={s.title}>Your dashboard is unavailable</Text><Text accessibilityRole="alert" style={s.copy}>{error || 'Please sign in to open your account.'}</Text><Pressable accessibilityRole="button" onPress={refresh} style={s.button}><Text style={s.buttonText}>Try again</Text></Pressable><Pressable accessibilityRole="button" onPress={() => router.replace('/login')}><Text style={s.copy}>Back to login</Text></Pressable></View></SafeAreaView>;
  const cafe = profile.role === 'cafe_owner_manager';
  const displayName = (cafe ? profile.cafe_name : profile.display_name) || (cafe ? 'Your café' : 'there');
  return <QuietFocusHome
    cafePlanCopy={CAFE_PLAN_COPY} counts={counts} firstName={cafe ? displayName : displayName.trim().split(/\s+/)[0]}
    location={cafe ? profile.location : workAreaLabel(profile)} error={error}
    onOpenSettings={() => router.push('/settings')} onRefresh={refresh}
    profileProgress={profileProgress} refreshing={refreshing} role={profile.role}
  />;
}
const s = StyleSheet.create({ safe: { flex: 1, backgroundColor: '#fffdf9' }, center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 26 }, title: { fontSize: 23, fontWeight: '800', color: '#321708', textAlign: 'center' }, copy: { color: '#746a61', fontSize: 14, lineHeight: 21, textAlign: 'center', marginTop: 14 }, button: { marginTop: 20, backgroundColor: '#321708', padding: 15, borderRadius: 12 }, buttonText: { color: '#fff', fontWeight: '800' } });
