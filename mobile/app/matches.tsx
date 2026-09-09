import { dashboardPrism as prism, prismPanel } from '@/lib/dashboardPrism';
import { useCallback, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, SafeAreaView, ScrollView, StyleSheet, Text, View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { supabase } from '@/lib/supabase';
import { getCurrentContext, AppRole } from '@/lib/session';
import { AppBottomNav } from '@/components/AppBottomNav';
import { loadApplications, MarketMatch, readAllRows, readProfiles } from '@/lib/marketplace';

type MatchRow = { id: string; kind: 'discovery' | 'application'; name: string; detail: string };
export default function Matches() {
  const [loading, setLoading] = useState(true), [rows, setRows] = useState<MatchRow[]>([]), [role, setRole] = useState<AppRole>('barista'), [error, setError] = useState('');
  const request = useRef(0);
  const load = useCallback(async () => {
    const version = ++request.current; setLoading(true); setError('');
    try {
      const context = await getCurrentContext();
      if (version !== request.current) return;
      if (!context.user) { router.replace('/login'); return; }
      if (!context.role || !context.profile) throw new Error('Your account profile could not load. Please refresh.');
      const id = context.user.id, accountRole = context.role;
      const [applications, matches] = await Promise.all([loadApplications(id, accountRole), readAllRows<MarketMatch>(() => supabase.from('discovery_matches').select('id,barista_id,cafe_id').or(`barista_id.eq.${id},cafe_id.eq.${id}`).order('created_at', { ascending: false }).order('id'))]);
      const profiles = await readProfiles([...matches.flatMap(row => [row.barista_id, row.cafe_id]), ...applications.filter(row => row.status === 'matched').map(row => accountRole === 'barista' ? row.job?.owner_id || '' : row.barista_id)].filter(value => value && value !== id));
      if (version !== request.current) return;
      const mutual: MatchRow[] = matches.map(match => { const person = profiles[accountRole === 'barista' ? match.cafe_id : match.barista_id]; return { id: match.id, kind: 'discovery', name: person?.cafe_name || person?.display_name || 'Profile currently unavailable', detail: person?.location || 'Mutual profile match' }; });
      const legacy: MatchRow[] = applications.filter(row => row.status === 'matched').map(row => { const person = profiles[accountRole === 'barista' ? row.job?.owner_id || '' : row.barista_id]; return { id: row.id, kind: 'application', name: person?.cafe_name || person?.display_name || 'Profile currently unavailable', detail: row.job?.title || 'Matched job application' }; });
      setRole(accountRole); setRows([...mutual, ...legacy]);
    } catch (caught) { if (version === request.current) { setRows([]); setError(caught instanceof Error ? caught.message : 'Matches could not load. Please refresh.'); } }
    finally { if (version === request.current) setLoading(false); }
  }, []);
  useFocusEffect(useCallback(() => { void load(); return () => { request.current++; }; }, [load]));
  return <SafeAreaView style={s.safe}><View style={s.header}><Text style={s.title}>Matches</Text><Text style={s.sub}>Both sides agreed — start a conversation</Text></View><ScrollView contentContainerStyle={s.list}>
    <Pressable disabled={loading} accessibilityRole="button" style={s.refresh} onPress={() => void load()}><Text style={s.name}>Refresh matches</Text></Pressable>
    {loading ? <ActivityIndicator size="large" color={prism.ink}/> : error ? <Text accessibilityRole="alert" style={s.emptyCopy}>{error}</Text> : rows.length ? rows.map(row => <Pressable accessibilityRole="button" accessibilityLabel={`Message ${row.name} about ${row.detail}`} key={`${row.kind}-${row.id}`} style={s.row} onPress={() => router.push({ pathname: '/chat/[id]', params: { id: row.id, kind: row.kind } })}><View style={{ flex: 1 }}><Text style={s.name}>{row.name}</Text><Text style={s.meta}>{row.detail} · Matched</Text></View><Text style={s.chev}>›</Text></Pressable>) : <View style={s.empty}><Text style={s.emptyTitle}>No matches yet</Text><Text style={s.emptyCopy}>Review incoming profile interests in Discover, or connect through a job application.</Text><Pressable style={s.refresh} onPress={() => router.push({ pathname: '/discover', params: { tab: 'received' } })}><Text style={s.name}>Review profile interests</Text></Pressable></View>}
  </ScrollView><AppBottomNav active="matches" role={role}/></SafeAreaView>;
}
const s = StyleSheet.create({ safe: { flex: 1, backgroundColor: prism.background }, header: { padding: 20, paddingBottom: 10 }, title: { fontSize: 31, fontWeight: '700', color: prism.ink }, sub: { fontSize: 14, color: prism.muted, marginTop: 4 }, list: { padding: 18, paddingBottom: 30 }, refresh: { minHeight: 44, padding: 12, borderWidth: 1, borderColor: prism.line, borderRadius: 12, marginBottom: 14, marginTop: 10 }, row: { ...prismPanel, flexDirection: 'row', alignItems: 'center', gap: 13, backgroundColor: prism.surface, borderWidth: 1, borderColor: prism.line, borderRadius: 22, padding: 15, marginBottom: 10 }, name: { fontSize: 16, fontWeight: '700', color: prism.ink }, meta: { fontSize: 12, color: prism.muted, marginTop: 4 }, chev: { fontSize: 29, color: prism.accent }, empty: { alignItems: 'center', paddingTop: 65 }, emptyTitle: { fontSize: 25, fontWeight: '700', color: prism.ink, marginTop: 15 }, emptyCopy: { fontSize: 14, lineHeight: 20, textAlign: 'center', color: prism.muted, marginTop: 6 } });
