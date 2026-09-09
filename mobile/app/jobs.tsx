import { dashboardPrism as prism, prismPanel } from '@/lib/dashboardPrism';
import { useCallback, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, SafeAreaView, ScrollView, StyleSheet, Text, View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { supabase } from '@/lib/supabase';
import { getCurrentContext } from '@/lib/session';
import { AppBottomNav } from '@/components/AppBottomNav';
import { formatJobPay, JOB_FIELDS, loadApplications, MarketJob, readAllRows } from '@/lib/marketplace';

export default function JobsScreen() {
  const [loading, setLoading] = useState(true), [jobs, setJobs] = useState<MarketJob[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({}), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const request = useRef(0), action = useRef(false), ownerId = useRef(''), focused = useRef(false);
  const load = useCallback(async () => {
    const version = ++request.current; setLoading(true); setError('');
    try {
      const { user, role } = await getCurrentContext();
      if (version !== request.current) return;
      if (!user) { router.replace('/login'); return; }
      if (role !== 'cafe_owner_manager') { router.replace('/home'); return; }
      const [next, applications] = await Promise.all([readAllRows<MarketJob>(() => supabase.from('jobs').select(JOB_FIELDS).eq('owner_id', user.id).order('created_at', { ascending: false }).order('id')), loadApplications(user.id, role)]);
      if (version !== request.current) return;
      ownerId.current = user.id; setJobs(next); setCounts(applications.reduce<Record<string, number>>((result, item) => { result[item.job_id] = (result[item.job_id] || 0) + 1; return result; }, {}));
    } catch (caught) { if (version === request.current) { setJobs([]); setError(caught instanceof Error ? caught.message : 'Jobs could not load. Please refresh.'); } }
    finally { if (version === request.current) setLoading(false); }
  }, []);
  useFocusEffect(useCallback(() => { focused.current = true; void load(); return () => { focused.current = false; request.current++; }; }, [load]));
  async function toggle(job: MarketJob) {
    if (action.current) return;
    action.current = true; setBusy(true);
    try {
      const { user, role } = await getCurrentContext();
      if (!user || user.id !== ownerId.current || role !== 'cafe_owner_manager') throw new Error('Your account changed. Refresh before updating this job.');
      const { data, error: updateError } = await supabase.from('jobs').update({ active: !job.active, updated_at: new Date().toISOString() }).eq('id', job.id).eq('owner_id', user.id).select('id,active').single();
      if (updateError) throw updateError;
      if (!data) throw new Error('This job is no longer available.');
      if (focused.current) setJobs(rows => rows.map(row => row.id === job.id ? { ...row, active: data.active } : row));
    } catch (caught) { if (focused.current) Alert.alert('Job not updated', caught instanceof Error ? caught.message : 'Please retry.'); }
    finally { action.current = false; setBusy(false); }
  }
  return <SafeAreaView style={s.safe}>
    <View style={s.header}><Pressable accessibilityRole="button" accessibilityLabel="Go back" style={s.backButton} onPress={() => router.back()}><Text allowFontScaling={false} style={s.back}>‹</Text></Pressable><View style={s.headerCopy}><Text style={s.title}>Job posts</Text><Text style={s.sub}>Edit, pause, or reopen café roles</Text></View><Pressable accessibilityRole="button" accessibilityLabel="Post a job" style={s.add} onPress={() => router.push('/post-job')}><Text allowFontScaling={false} style={s.addText}>＋</Text></Pressable></View>
    <ScrollView contentContainerStyle={s.wrap}><Pressable disabled={loading || busy} style={s.secondary} onPress={() => void load()}><Text style={s.secondaryText}>Refresh jobs</Text></Pressable>
      {loading ? <ActivityIndicator size="large" color={prism.ink} /> : error ? <Text accessibilityRole="alert" style={s.meta}>{error}</Text> : jobs.length ? jobs.map(job => <View key={job.id} style={s.card}><View style={s.cardTop}><View style={{ flex: 1 }}><Text style={s.jobTitle}>{job.title}</Text><Text style={s.meta}>{job.location || 'Location not added'} · {formatJobPay(job)}</Text><Text style={s.meta}>{job.schedule || 'Schedule not added'}</Text><Text style={s.meta}>{counts[job.id] || 0} applications retained</Text></View><View style={s.status}><Text style={s.statusText}>{job.active ? 'Active' : 'Paused'}</Text></View></View><View style={s.actions}>
        <Pressable disabled={busy} style={s.secondary} onPress={() => router.push({ pathname: '/post-job', params: { jobId: job.id } })}><Text style={s.secondaryText}>Edit</Text></Pressable><Pressable disabled={busy} style={s.secondary} onPress={() => job.active ? Alert.alert('Pause this job?', 'Baristas will no longer see the post. Its applications and matches will stay saved.', [{ text: 'Cancel', style: 'cancel' }, { text: 'Pause job', onPress: () => void toggle(job) }]) : void toggle(job)}><Text style={s.secondaryText}>{job.active ? 'Pause job' : 'Reopen job'}</Text></Pressable><Pressable style={s.secondary} onPress={() => router.push('/candidates')}><Text style={s.secondaryText}>Review applicants</Text></Pressable>
      </View></View>) : <View style={s.empty}><Text style={s.emptyTitle}>No jobs yet</Text><Text style={s.meta}>Post your first role to start meeting local baristas.</Text><Pressable style={s.primary} onPress={() => router.push('/post-job')}><Text style={s.primaryText}>Post a job</Text></Pressable></View>}
    </ScrollView><AppBottomNav active="home" role="cafe_owner_manager" />
  </SafeAreaView>;
}
const s = StyleSheet.create({ safe: { flex: 1, backgroundColor: prism.background }, headerCopy: { flex: 1, minWidth: 0 }, backButton: { width: 44, height: 44, flexShrink: 0, alignItems: 'center', justifyContent: 'center' }, header: { minHeight: 72, paddingVertical: 10, paddingHorizontal: 18, flexDirection: 'row', alignItems: 'center', gap: 12, borderBottomWidth: 1, borderBottomColor: prism.line, backgroundColor: prism.surface }, back: { fontSize: 36, color: prism.ink }, title: { fontSize: 21, fontWeight: '700', color: prism.ink }, sub: { fontSize: 11, color: prism.muted, marginTop: 2 }, add: { flexShrink: 0, width: 44, height: 44, borderRadius: 14, backgroundColor: prism.accent, alignItems: 'center', justifyContent: 'center' }, addText: { fontSize: 25, color: prism.surface }, wrap: { padding: 18, paddingBottom: 32 }, card: { ...prismPanel, backgroundColor: prism.surface, borderWidth: 1, borderColor: prism.line, borderRadius: 24, padding: 16, marginTop: 14 }, cardTop: { flexDirection: 'row', gap: 10 }, jobTitle: { fontSize: 18, fontWeight: '700', color: prism.ink }, meta: { fontSize: 13, lineHeight: 20, color: prism.muted, marginTop: 6 }, status: { backgroundColor: prism.soft, borderRadius: 99, paddingHorizontal: 10, paddingVertical: 6, alignSelf: 'flex-start' }, statusText: { fontSize: 11, fontWeight: '700', color: '#41713c' }, actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 9, marginTop: 14 }, secondary: { minHeight: 44, justifyContent: 'center', borderWidth: 1, borderColor: prism.line, borderRadius: 11, paddingHorizontal: 15, paddingVertical: 10, alignSelf: 'flex-start' }, secondaryText: { fontWeight: '700', color: prism.ink }, empty: { alignItems: 'center', paddingVertical: 70, paddingHorizontal: 24 }, emptyTitle: { fontSize: 25, fontWeight: '700', color: prism.ink, marginTop: 15 }, primary: { backgroundColor: prism.accent, borderRadius: 13, paddingHorizontal: 20, paddingVertical: 13, marginTop: 20, minHeight: 44 }, primaryText: { color: prism.surface, fontWeight: '700' } });
