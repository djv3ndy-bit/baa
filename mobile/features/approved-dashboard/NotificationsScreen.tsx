import { useCallback, useRef, useState } from 'react';
import { ActivityIndicator, Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router, useFocusEffect } from 'expo-router';
import { supabase } from '../../lib/supabase';
import { getCurrentContext, requireCurrentUser, type AppRole } from '../../lib/session';
import { unreadNotifications, withMessageDeadline, type UnreadNotification } from '../../lib/messaging';
import { notificationDestination } from '../../lib/notificationRouting';
import { Action, EmptyCard } from './DashboardPrimitives';
import { safeDashboardError } from './model';
import { dashboardTheme as t } from './theme';

export default function NotificationsScreen() {
  const [rows, setRows] = useState<UnreadNotification[]>([]), [role, setRole] = useState<AppRole | null>(null);
  const [loading, setLoading] = useState(true), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const user = useRef(''), revision = useRef(0), action = useRef(false);
  const load = useCallback(async () => {
    const version = ++revision.current; setLoading(true); setError('');
    try {
      const context = await withMessageDeadline(getCurrentContext());
      if (!context.user) { router.replace('/login'); return; }
      if (!context.role) { router.replace('/signup'); return; }
      const next = await unreadNotifications(supabase, context.user.id);
      await requireCurrentUser(context.user.id);
      if (version === revision.current) { user.current = context.user.id; setRole(context.role); setRows(next); }
    } catch (cause) { if (version === revision.current) { setRows([]); setError(safeDashboardError(cause)); } }
    finally { if (version === revision.current) setLoading(false); }
  }, []);
  useFocusEffect(useCallback(() => {
    void load();
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_OUT' || (user.current && session?.user.id !== user.current)) {
        revision.current++; user.current = ''; setRows([]); setRole(null); router.replace('/login');
      }
    });
    return () => { revision.current++; subscription.unsubscribe(); };
  }, [load]));
  async function dismiss(row: UnreadNotification) {
    if (action.current || !user.current) return;
    action.current = true; setBusy(true);
    const accountId = user.current, version = revision.current;
    try {
      await requireCurrentUser(accountId);
      const discovery = row.id.startsWith('discovery:');
      const result = await withMessageDeadline(supabase.from(discovery ? 'discovery_message_notifications' : 'notifications')
        .update({ read_at: new Date().toISOString() }).eq('id', discovery ? row.id.slice(10) : row.id).eq('recipient_id', accountId).select('id').maybeSingle());
      if (result.error || !result.data) throw new Error('Notification changed');
      await requireCurrentUser(accountId);
      if (version === revision.current) setRows(previous => previous.filter(item => item.id !== row.id));
    } catch { if (version === revision.current) setError('This notification could not be marked as read. Refresh and try again.'); }
    finally { action.current = false; if (version === revision.current) setBusy(false); }
  }
  async function open(row: UnreadNotification) {
    try {
      await requireCurrentUser(user.current);
      const id = row.discovery_match_id || row.application_id;
      const destination = row.type === 'message'
        ? (id && notificationDestination({ route: `/chat/${id}?kind=${row.discovery_match_id ? 'discovery' : 'application'}` })) || '/messages'
        : row.type === 'match' ? '/matches' : row.type === 'application' ? (role === 'cafe_owner_manager' ? '/candidates' : '/discover?tab=sent') : '/home';
      if (destination) router.navigate(destination as never);
    } catch { router.replace('/login'); }
  }
  return <SafeAreaView style={s.safe} edges={Platform.OS === 'android' ? [] : ['top', 'bottom', 'left', 'right']}>
    <View style={s.header}><Action label="Back" onPress={() => router.canGoBack() ? router.back() : router.replace('/home')} /><Text accessibilityRole="header" style={s.title}>Notifications</Text></View>
    <ScrollView contentContainerStyle={s.list}><Text style={s.copy}>Unread activity for your account</Text><Action label="Refresh notifications" disabled={loading || busy} onPress={() => { void load(); }} />
      {error ? <Text accessibilityRole="alert" style={s.error}>{error}</Text> : null}
      {loading ? <ActivityIndicator color={t.accent} size="large" /> : !error && !rows.length ? <EmptyCard title="You’re up to date" body="New message, match, and application notifications will appear here." /> : rows.map(row => <View key={row.id} style={s.card}>
        <Text style={s.copy}>{row.type === 'message' ? 'Unread message' : row.type === 'match' ? 'New match' : 'New account activity'}</Text>
        <Action label={row.type === 'message' ? 'Open messages' : row.type === 'match' ? 'View matches' : row.type === 'application' ? (role === 'cafe_owner_manager' ? 'Review applicants' : 'View your interests') : 'Open dashboard'} disabled={busy} onPress={() => { void open(row); }} />
        <Action label="Mark as read" disabled={busy} onPress={() => { void dismiss(row); }} />
      </View>)}
    </ScrollView>
  </SafeAreaView>;
}
const s = StyleSheet.create({ safe: { flex: 1, backgroundColor: t.background }, header: { padding: 16, flexDirection: 'row', flexWrap: 'wrap', gap: 12, alignItems: 'center' }, title: { fontSize: 27, fontFamily: t.headingFont, color: t.ink, fontWeight: '700' }, list: { padding: 16, gap: 12 }, card: { padding: 16, borderWidth: 1, borderColor: t.border, borderRadius: 14, gap: 10, backgroundColor: t.surface }, copy: { fontSize: 16, color: t.ink }, error: { color: t.error, fontSize: 15, lineHeight: 22 } });
