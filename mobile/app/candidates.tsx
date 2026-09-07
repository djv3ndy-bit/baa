import { useCallback, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Image, Linking, Pressable, SafeAreaView, ScrollView, StyleSheet, Text, View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { supabase } from '@/lib/supabase';
import { getCurrentContext } from '@/lib/session';
import { AppBottomNav } from '@/components/AppBottomNav';
import { authenticatedApi } from '@/lib/api';
import { applicationStatus, loadApplications, MarketApplication, profileVideoUrl } from '@/lib/marketplace';

export default function CandidatesScreen() {
  const [loading, setLoading] = useState(true), [items, setItems] = useState<MarketApplication[]>([]);
  const [history, setHistory] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const request = useRef(0), action = useRef(false), focused = useRef(false), userId = useRef('');
  const load = useCallback(async () => {
    const version = ++request.current; setLoading(true); setError('');
    try {
      const context = await getCurrentContext();
      if (version !== request.current) return;
      if (!context.user) { router.replace('/login'); return; }
      if (context.role !== 'cafe_owner_manager') { router.replace('/home'); return; }
      const next = await loadApplications(context.user.id, context.role);
      if (version === request.current) { userId.current = context.user.id; setItems(next); }
    } catch (caught) { if (version === request.current) { setItems([]); setError(caught instanceof Error ? caught.message : 'Candidates could not load. Please refresh.'); } }
    finally { if (version === request.current) setLoading(false); }
  }, []);
  useFocusEffect(useCallback(() => { focused.current = true; void load(); return () => { focused.current = false; request.current++; }; }, [load]));
  async function decide(candidate: MarketApplication, decision: 'matched' | 'declined') {
    if (action.current) return;
    action.current = true; setBusy(true);
    try {
      const context = await getCurrentContext();
      if (!context.user || context.user.id !== userId.current || context.role !== 'cafe_owner_manager') throw new Error('Your account changed. Refresh before reviewing this application.');
      if (decision === 'matched') await authenticatedApi('/match-application', { application_id: candidate.id }, 'POST', context.user.id);
      else {
        const { data, error: updateError } = await supabase.from('applications').update({ status: decision }).eq('id', candidate.id).eq('status', 'interested').select('id,status').single();
        if (updateError) throw updateError;
        if (!data) throw new Error('This application changed. Refresh Candidates to check its current status.');
      }
      if (!focused.current) return;
      setItems(rows => rows.map(row => row.id === candidate.id ? { ...row, status: decision } : row));
      if (decision === 'matched') router.push({ pathname: '/match-success', params: { applicationId: candidate.id, name: candidate.barista?.display_name || 'Barista' } });
    } catch (caught) { if (focused.current) Alert.alert('Application not updated', caught instanceof Error ? caught.message : 'Please refresh and try again.'); }
    finally { action.current = false; setBusy(false); }
  }
  async function viewVideo(path: string) { try { await Linking.openURL(await profileVideoUrl(path)); } catch { Alert.alert('Video unavailable', 'This video could not open. Please refresh and try again.'); } }
  const visible = items.filter(item => history ? item.status !== 'interested' : item.status === 'interested');
  return <SafeAreaView style={s.safe}>
    <View style={s.header}><View style={s.headerCopy}><Text style={s.title}>Candidates</Text><Text style={s.copy}>Review applications and keep their history</Text></View></View>
    <ScrollView contentContainerStyle={s.wrap}>
      <Pressable accessibilityRole="button" style={s.secondary} onPress={() => router.push({ pathname: '/discover', params: { tab: 'received' } })}><Text style={s.secondaryText}>Review profile interests</Text></Pressable>
      <View style={s.actions}><Pressable accessibilityRole="tab" accessibilityState={{ selected: !history }} style={s.secondary} onPress={() => setHistory(false)}><Text style={s.secondaryText}>Awaiting review</Text></Pressable><Pressable accessibilityRole="tab" accessibilityState={{ selected: history }} style={s.secondary} onPress={() => setHistory(true)}><Text style={s.secondaryText}>History</Text></Pressable><Pressable disabled={loading || busy} style={s.secondary} onPress={() => void load()}><Text style={s.secondaryText}>Refresh</Text></Pressable></View>
      {loading ? <ActivityIndicator size="large" color="#321708" /> : error ? <Text accessibilityRole="alert" style={s.copy}>{error}</Text> : <><Text style={s.count}>{visible.length} {history ? 'reviewed applications' : 'applications awaiting review'}</Text>{visible.map(candidate => { const person = candidate.barista; return <View key={candidate.id} style={s.card}>
        {person?.avatar_url ? <Image source={{ uri: person.avatar_url }} style={s.photo} accessibilityLabel="Barista profile photo" /> : null}<Text style={s.name}>{person?.display_name || 'Profile currently unavailable'}</Text><Text style={s.job}>{candidate.job?.title || 'Job no longer available'}{candidate.job?.active === false ? ' · Paused' : ''}</Text><Text style={s.copy}>{person?.location || 'Location not added'}</Text>
        <Info label="Skills" value={person?.skills?.join(' · ')} /><Info label="Experience" value={person?.experience} /><Info label="Availability" value={person?.availability} /><Info label="Desired pay" value={person?.pay_expectation} /><Info label="About" value={person?.bio} />{person?.video_path ? <Pressable accessibilityRole="button" style={s.secondary} onPress={() => void viewVideo(person.video_path!)}><Text style={s.secondaryText}>Watch coffee showcase</Text></Pressable> : null}
        {candidate.status === 'interested' ? <View style={s.actions}><Pressable accessibilityRole="button" disabled={busy} style={[s.secondary, busy && s.disabled]} onPress={() => Alert.alert('Decline this application?', 'The application will stay in your history as not selected.', [{ text: 'Cancel', style: 'cancel' }, { text: 'Decline', onPress: () => void decide(candidate, 'declined') }])}><Text style={s.secondaryText}>Decline</Text></Pressable><Pressable accessibilityRole="button" disabled={busy || !person} style={[s.primary, (busy || !person) && s.disabled]} onPress={() => void decide(candidate, 'matched')}><Text style={s.primaryText}>Match with barista</Text></Pressable></View> : <><Text style={s.count}>{applicationStatus(candidate.status)}</Text>{candidate.status === 'matched' ? <Pressable style={s.primary} onPress={() => router.push({ pathname: '/chat/[id]', params: { id: candidate.id, kind: 'application' } })}><Text style={s.primaryText}>Open conversation</Text></Pressable> : null}</>}
      </View>; })}{!visible.length ? <View style={s.empty}><Text style={s.name}>{history ? 'No reviewed applications yet' : 'You’re caught up'}</Text><Text style={s.copy}>{history ? 'Matched and declined applications will remain here.' : 'Applications to your jobs will appear here. Profile interests are available above.'}</Text></View> : null}</>}
    </ScrollView><AppBottomNav active="candidates" role="cafe_owner_manager" />
  </SafeAreaView>;
}
function Info({ label, value }: { label: string; value?: string | null }) { return value ? <View style={s.info}><Text style={s.infoLabel}>{label}</Text><Text style={s.copy}>{value}</Text></View> : null; }
const s = StyleSheet.create({ safe: { flex: 1, backgroundColor: '#fbf7f1' }, header: { padding: 18, flexDirection: 'row', gap: 12 }, headerCopy: { flex: 1, minWidth: 0 }, title: { fontSize: 27, fontWeight: '900', color: '#321708' }, wrap: { padding: 18, paddingBottom: 32 }, card: { backgroundColor: '#fff', padding: 18, marginTop: 14, borderRadius: 18, borderWidth: 1, borderColor: '#eadfd5' }, photo: { width: 80, height: 80, borderRadius: 15, marginBottom: 12 }, name: { fontSize: 23, fontWeight: '900', color: '#321708' }, job: { fontSize: 15, color: '#a95820', fontWeight: '800', marginTop: 4 }, copy: { fontSize: 14, lineHeight: 21, color: '#746a61', marginTop: 7 }, info: { marginTop: 12 }, infoLabel: { fontSize: 12, fontWeight: '900', color: '#321708' }, actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 9, marginVertical: 14 }, secondary: { minHeight: 44, padding: 12, justifyContent: 'center', borderRadius: 12, borderWidth: 1, borderColor: '#d6c2b3', alignSelf: 'flex-start' }, secondaryText: { fontWeight: '800', color: '#321708' }, primary: { minHeight: 44, padding: 12, justifyContent: 'center', borderRadius: 12, backgroundColor: '#321708', alignSelf: 'flex-start' }, primaryText: { fontWeight: '800', color: '#fff' }, count: { fontSize: 14, fontWeight: '800', color: '#321708', marginVertical: 12 }, empty: { paddingVertical: 40 }, disabled: { opacity: .5 } });
