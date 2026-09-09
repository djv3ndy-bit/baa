import { dashboardPrism as prism, prismPanel } from '@/lib/dashboardPrism';
import { useCallback, useState } from 'react';
import { ActivityIndicator, AppState, Pressable, RefreshControl, SafeAreaView, ScrollView, StyleSheet, Text, View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { supabase } from '@/lib/supabase';
import { getCurrentContext, AppRole } from '@/lib/session';
import { AppBottomNav } from '@/components/AppBottomNav';
import { Conversation, LatestMessageRequest, loadConversations, messageError, withMessageDeadline } from '@/lib/messaging';

export default function Messages() {
  const [loading, setLoading] = useState(true), [refreshing, setRefreshing] = useState(false);
  const [rows, setRows] = useState<Conversation[]>([]), [role, setRole] = useState<AppRole | null>(null);
  const [error, setError] = useState(''), [attempt, setAttempt] = useState(0);
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
        if (!context.role) { router.replace('/signup'); return; }
        userId = context.user.id;
        const conversations = await loadConversations(supabase, userId, context.role);
        if (!live || !current()) return;
        setRole(context.role); setRows(conversations); setError('');
        if (!channel) {
          channel = supabase.channel(`mobile-inbox-${userId}`)
            .on('postgres_changes', { event: '*', schema: 'public', table: 'notifications', filter: `recipient_id=eq.${userId}` }, () => { void load(); })
            .on('postgres_changes', { event: '*', schema: 'public', table: 'discovery_message_notifications', filter: `recipient_id=eq.${userId}` }, () => { void load(); })
            .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, () => { void load(); })
            .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'discovery_messages' }, () => { void load(); })
            .subscribe();
        }
      } catch (cause) { if (live && current()) setError(messageError(cause, 'Messages could not load. Please try again.')); }
      finally { if (live && current()) { setLoading(false); setRefreshing(false); } }
    }
    void load();
    const appState = AppState.addEventListener('change', state => { if (state === 'active') void load(); });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      if (userId && (event === 'SIGNED_OUT' || (session && session.user.id !== userId))) {
        live = false; requests.invalidate(); setRows([]); setRole(null); router.replace('/login');
      }
    });
    return () => { live = false; requests.invalidate(); subscription.unsubscribe(); appState.remove(); if (channel) void supabase.removeChannel(channel); };
  }, [attempt]));
  const refresh = () => setAttempt(value => value + 1);
  const unread = rows.reduce((total, row) => total + row.unread, 0);
  return <SafeAreaView style={s.safe}>
    <View style={s.header}><Text style={s.title}>Messages</Text><Text style={s.sub}>{unread ? `${unread} unread ${unread === 1 ? 'message' : 'messages'}` : 'Private conversations with mutual matches'}</Text></View>
    {loading ? <View style={s.center}><ActivityIndicator size="large" color={prism.ink} /><Text style={s.sub}>Loading conversations…</Text></View> :
      <ScrollView contentContainerStyle={s.list} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} />}>
        {error ? <View style={s.notice}><Text accessibilityRole="alert" style={s.error}>{error}</Text><Pressable accessibilityRole="button" onPress={refresh}><Text style={s.retry}>Try again</Text></Pressable></View> : null}
        {rows.map(row => <Pressable accessibilityRole="button" accessibilityLabel={`${row.name}${row.unread ? `, ${row.unread} unread messages` : ''}`} key={`${row.kind}-${row.id}`} style={s.row} onPress={() => router.push({ pathname: '/chat/[id]', params: { id: row.id, kind: row.kind } })}>
          <View style={s.avatar}><Text allowFontScaling={false} style={{ fontSize: 22 }}>{role === 'barista' ? '☕' : '👤'}</Text></View>
          <View style={{ flex: 1, minWidth: 0 }}><Text numberOfLines={1} style={s.name}>{row.name}</Text><Text numberOfLines={1} style={s.preview}>{row.preview}</Text></View>
          {row.unread ? <View style={s.unread}><Text style={s.unreadText}>{row.unread > 99 ? '99+' : row.unread}</Text></View> : <Text style={s.chev}>›</Text>}
        </Pressable>)}
        {!rows.length && !error ? <View style={s.empty}><Text style={{ fontSize: 48 }}>💬</Text><Text style={s.emptyTitle}>No conversations yet</Text><Text style={s.emptyCopy}>A private conversation opens after both sides match.</Text><Pressable accessibilityRole="button" onPress={() => router.push('/discover')}><Text style={s.retry}>Discover {role === 'cafe_owner_manager' ? 'baristas' : 'cafés'}</Text></Pressable></View> : null}
      </ScrollView>}
    {role ? <AppBottomNav active="messages" role={role} /> : <Pressable accessibilityRole="button" onPress={() => router.replace('/home')}><Text style={s.retry}>Back to home</Text></Pressable>}
  </SafeAreaView>;
}
const s=StyleSheet.create({notice:{padding:14,backgroundColor:'#fff4e8',borderRadius:12,marginBottom:12},error:{fontSize:13,color:'#84341f',lineHeight:19},retry:{fontSize:14,fontWeight: '700',color:prism.accent,padding:14,textAlign:'center'},unread:{backgroundColor:prism.accent,borderRadius:20,minWidth:25,padding:5,alignItems:'center'},unreadText:{fontSize:11,color:prism.surface,fontWeight: '700'},safe:{flex:1,backgroundColor:prism.background},center:{flex:1,alignItems:'center',justifyContent:'center'},header:{padding:20,paddingBottom:10},title:{fontSize:31,fontWeight: '700',color:prism.ink},sub:{fontSize:14,color:prism.muted,marginTop:4},list:{padding:18,paddingBottom:30},row:{...prismPanel,borderRadius:20,paddingHorizontal:15,marginBottom:10,flexDirection:'row',alignItems:'center',gap:13,backgroundColor:prism.surface,paddingVertical:15},avatar:{width:50,height:50,borderRadius:25,backgroundColor:prism.accentSoft,alignItems:'center',justifyContent:'center'},name:{fontSize:16,fontWeight: '700',color:prism.ink},preview:{fontSize:13,color:prism.muted,marginTop:5},chev:{fontSize:28,color:prism.accent},empty:{alignItems:'center',paddingTop:100},emptyTitle:{fontSize:25,fontWeight: '700',color:prism.ink,marginTop:15},emptyCopy:{fontSize:14,color:prism.muted,marginTop:6,textAlign:'center'}});
