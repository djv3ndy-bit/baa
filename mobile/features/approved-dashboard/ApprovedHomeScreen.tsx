import { useCallback, useRef, useState } from 'react';
import { ActivityIndicator, AppState, Platform, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router, useFocusEffect } from 'expo-router';
import { supabase } from '../../lib/supabase';
import { requireCurrentUser } from '../../lib/session';
import { DashboardSessionError, loadDashboard } from './loadDashboard';
import { safeDashboardError, type DashboardData, type Destination } from './model';
import { ApprovedDashboard } from './ApprovedDashboard';
import { Action } from './DashboardPrimitives';
import { dashboardTheme as t } from './theme';

export default function ApprovedHomeScreen() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true), [error, setError] = useState('');
  const reload = useRef<() => void>(() => {});
  const account = useRef<string | null>(null);
  useFocusEffect(useCallback(() => {
    let live = true, running = false, revision = 0;
    let channel: ReturnType<typeof supabase.channel> | undefined;
    async function load() {
      if (!live || running) return;
      running = true;
      const version = ++revision;
      setLoading(true);
      try {
        const next = await loadDashboard();
        if (!live || version !== revision) return;
        if (account.current && account.current !== next.accountId) setData(null);
        account.current = next.accountId;
        setData(next); setError('');
        if (!channel) {
          channel = supabase.channel(`approved-home-${next.accountId}`)
            .on('postgres_changes', { event: '*', schema: 'public', table: 'notifications', filter: `recipient_id=eq.${next.accountId}` }, () => { void load(); })
            .on('postgres_changes', { event: '*', schema: 'public', table: 'discovery_message_notifications', filter: `recipient_id=eq.${next.accountId}` }, () => { void load(); })
            .subscribe();
        }
      } catch (cause) {
        if (!live || version !== revision) return;
        if (cause instanceof DashboardSessionError) { setData(null); router.replace(cause.destination); }
        else setError(safeDashboardError(cause));
      } finally { running = false; if (live && version === revision) setLoading(false); }
    }
    reload.current = () => { void load(); };
    void load();
    const state = AppState.addEventListener('change', value => { if (value === 'active') void load(); });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_OUT' || (account.current && session && session.user.id !== account.current)) {
        revision++; live = false; account.current = null; setData(null); setError(''); router.replace('/login');
      }
    });
    return () => { live = false; revision++; state.remove(); subscription.unsubscribe(); if (channel) void supabase.removeChannel(channel); reload.current = () => {}; };
  }, []));
  const navigate = async (destination: Destination) => {
    if (!account.current) return;
    try { await requireCurrentUser(account.current); router.navigate(destination as never); }
    catch { setData(null); account.current = null; router.replace('/login'); }
  };
  if (data) return <ApprovedDashboard data={data} error={error} refreshing={loading} onRefresh={() => reload.current()} navigate={destination => { void navigate(destination); }} />;
  return <SafeAreaView edges={Platform.OS === 'android' ? [] : ['top', 'left', 'right', 'bottom']} style={s.safe}><View style={s.center}>
    {loading ? <><ActivityIndicator color={t.accent} size="large" /><Text style={s.copy}>Loading your dashboard…</Text></> : <>
      <Text accessibilityRole="header" style={s.title}>Your dashboard is unavailable</Text><Text accessibilityRole="alert" style={s.copy}>{error}</Text>
      <Action label="Try again" primary onPress={() => reload.current()} /><Action label="Back to login" onPress={() => router.replace('/login')} />
    </>}
  </View></SafeAreaView>;
}
const s = StyleSheet.create({ safe: { flex: 1, backgroundColor: t.background }, center: { flex: 1, padding: 24, justifyContent: 'center', gap: 16 }, title: { fontSize: 26, fontFamily: t.headingFont, fontWeight: '700', color: t.ink }, copy: { color: t.muted, fontSize: 16, lineHeight: 23 } });
