import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, KeyboardAvoidingView, Platform, Pressable, SafeAreaView, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { supabase } from '@/lib/supabase';
import { getCurrentContext } from '@/lib/session';
import { authenticatedApi } from '@/lib/api';
import { blockUser, isMessageAllowed, reportUser } from '@/lib/safety';

type ChatMessage = { id: string; sender_id: string; body: string; created_at: string };
type ReportReason = 'harassment' | 'spam_or_scam';

export default function Chat() {
  const { id, kind } = useLocalSearchParams<{ id: string; kind?: 'discovery' | 'application' }>();
  const discovery = kind === 'discovery';
  const [loading, setLoading] = useState(true);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [body, setBody] = useState('');
  const [me, setMe] = useState('');
  const [otherUserId, setOtherUserId] = useState('');
  const [name, setName] = useState('Conversation');
  const [sending, setSending] = useState(false);
  const [safetyBusy, setSafetyBusy] = useState(false);
  const scroll = useRef<ScrollView>(null);

  useEffect(() => {
    load();
    const table = discovery ? 'discovery_messages' : 'messages';
    const column = discovery ? 'match_id' : 'application_id';
    const channel = supabase
      .channel(`mobile-chat-${kind || 'application'}-${id}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table, filter: `${column}=eq.${id}` }, () => loadMessages())
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [id, kind]);

  async function load() {
    const { user, role } = await getCurrentContext();
    if (!user) { router.replace('/login'); return; }
    setMe(user.id);
    if (discovery) {
      const { data, error } = await supabase
        .from('discovery_matches')
        .select('id,barista_id,cafe_id,barista:profiles!discovery_matches_barista_id_fkey(display_name),cafe:profiles!discovery_matches_cafe_id_fkey(cafe_name)')
        .eq('id', id)
        .maybeSingle();
      if (error || !data) return unavailable();
      const match: any = data;
      setOtherUserId(user.id === match.barista_id ? match.cafe_id : match.barista_id);
      setName(role === 'barista' ? (match.cafe?.cafe_name || 'Café') : (match.barista?.display_name || 'Barista'));
    } else {
      const { data, error } = await supabase
        .from('applications')
        .select('id,barista_id,barista:profiles!applications_barista_id_fkey(display_name),job:jobs(title,owner_id,owner:profiles!jobs_owner_id_fkey(cafe_name))')
        .eq('id', id)
        .eq('status', 'matched')
        .maybeSingle();
      if (error || !data) return unavailable();
      const application: any = data;
      setOtherUserId(user.id === application.barista_id ? application.job?.owner_id : application.barista_id);
      setName(role === 'barista' ? (application.job?.owner?.cafe_name || 'Café') : (application.barista?.display_name || 'Barista'));
    }
    await loadMessages();
    setLoading(false);
  }

  function unavailable() {
    setLoading(false);
    Alert.alert('Conversation unavailable', 'This match could not be opened.', [{ text: 'Back', onPress: () => router.back() }]);
  }

  async function loadMessages() {
    const table = discovery ? 'discovery_messages' : 'messages';
    const column = discovery ? 'match_id' : 'application_id';
    const { data, error } = await supabase.from(table).select('id,sender_id,body,created_at').eq(column, id).order('created_at', { ascending: true });
    if (error) return Alert.alert('Could not load messages', error.message);
    setMessages((data || []) as ChatMessage[]);
    setTimeout(() => scroll.current?.scrollToEnd({ animated: true }), 80);
    if (!discovery) {
      const { error: readError } = await supabase.rpc('mark_conversation_read', { p_application_id: id });
      if (readError) console.warn('Could not mark conversation read', readError.message);
    }
  }

  async function send() {
    const text = body.trim();
    if (!text || sending) return;
    if (!isMessageAllowed(text)) return Alert.alert('Message not sent', 'Please remove threatening, hateful, or abusive language and try again.');
    setSending(true);
    setBody('');
    try {
      if (discovery) {
        const { data: message, error } = await supabase.from('discovery_messages').insert({ match_id: id, sender_id: me, body: text }).select('id').single();
        if (error) throw error;
        authenticatedApi('/push-event', { type: 'discovery_message', match_id: id, message_id: message.id }).catch(error => console.warn('Message notification failed', error?.message || error));
      } else {
        await authenticatedApi('/send-message', { application_id: id, body: text });
      }
    } catch (error) {
      setBody(text);
      Alert.alert('Message not sent', error instanceof Error ? error.message : 'Please try again.');
    } finally { setSending(false); }
  }

  function openSafetyMenu() {
    if (!otherUserId || safetyBusy) return;
    Alert.alert(`Safety options for ${name}`, 'Reports are reviewed by BaristaMatch. Blocking immediately ends contact between both accounts.', [
      { text: 'Report conversation', onPress: chooseReportReason },
      { text: 'Block account', style: 'destructive', onPress: confirmBlock },
      { text: 'Cancel', style: 'cancel' },
    ]);
  }

  function chooseReportReason() {
    Alert.alert('Why are you reporting this?', 'Choose the closest reason.', [
      { text: 'Harassment or threats', onPress: () => submitReport('harassment') },
      { text: 'Spam or scam', onPress: () => submitReport('spam_or_scam') },
      { text: 'Cancel', style: 'cancel' },
    ]);
  }

  async function submitReport(reason: ReportReason) {
    setSafetyBusy(true);
    try {
      const context = messages.filter(message => message.sender_id !== me).slice(-5).map(message => message.body).join('\n');
      await reportUser({ reportedId: otherUserId, conversationId: id, conversationKind: discovery ? 'discovery' : 'application', reason, details: context });
      Alert.alert('Report received', 'Thank you. BaristaMatch will review this conversation. You can also block the account to stop contact now.');
    } catch (error) {
      Alert.alert('Report not sent', error instanceof Error ? error.message : 'Please try again.');
    } finally { setSafetyBusy(false); }
  }

  function confirmBlock() {
    Alert.alert('Block this account?', 'You will no longer see each other or be able to exchange messages.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Block', style: 'destructive', onPress: performBlock },
    ]);
  }

  async function performBlock() {
    setSafetyBusy(true);
    try {
      await blockUser(otherUserId);
      Alert.alert('Account blocked', 'This account can no longer contact you.', [{ text: 'OK', onPress: () => router.replace('/messages') }]);
    } catch (error) {
      Alert.alert('Could not block account', error instanceof Error ? error.message : 'Please try again.');
    } finally { setSafetyBusy(false); }
  }

  if (loading) return <SafeAreaView style={s.safe}><View style={s.center}><ActivityIndicator size="large" color="#321708" /></View></SafeAreaView>;
  return (
    <SafeAreaView style={s.safe}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={s.header}>
          <Pressable onPress={() => router.back()} style={s.back}><Text style={s.backText}>‹</Text></Pressable>
          <View style={s.avatar}><Text>☕</Text></View>
          <View style={s.heading}><Text style={s.name}>{name}</Text><Text style={s.sub}>Mutual match · Private conversation</Text></View>
          <Pressable accessibilityLabel="Conversation safety options" disabled={safetyBusy} onPress={openSafetyMenu} style={s.safety}><Text style={s.safetyText}>•••</Text></Pressable>
        </View>
        <ScrollView ref={scroll} style={s.stream} contentContainerStyle={s.streamContent}>
          {messages.length ? messages.map(message => (
            <View key={message.id} style={[s.bubbleWrap, message.sender_id === me && s.mineWrap]}>
              <View style={[s.bubble, message.sender_id === me && s.mine]}><Text style={[s.text, message.sender_id === me && s.mineText]}>{message.body}</Text></View>
              <Text style={s.time}>{new Date(message.created_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</Text>
            </View>
          )) : <View style={s.empty}><Text style={{ fontSize: 38 }}>👋</Text><Text style={s.emptyText}>Say hello and start the conversation.</Text></View>}
        </ScrollView>
        <View style={s.compose}>
          <TextInput value={body} onChangeText={setBody} placeholder="Message…" multiline maxLength={2000} style={s.input} placeholderTextColor="#9b8d84" />
          <Pressable disabled={sending || !body.trim()} onPress={send} style={[s.send, (sending || !body.trim()) && { opacity: .5 }]}><Text style={s.sendText}>↑</Text></Pressable>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#f7f0e9' }, center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  header: { height: 72, backgroundColor: '#fff', borderBottomWidth: 1, borderBottomColor: '#eadfd5', flexDirection: 'row', alignItems: 'center', paddingHorizontal: 10, gap: 8 },
  back: { width: 38, height: 38, alignItems: 'center', justifyContent: 'center' }, backText: { fontSize: 36, color: '#321708', marginTop: -5 },
  avatar: { width: 42, height: 42, borderRadius: 21, backgroundColor: '#f3e8de', alignItems: 'center', justifyContent: 'center' },
  heading: { flex: 1, minWidth: 0 }, name: { fontSize: 16, fontWeight: '900', color: '#24150d' }, sub: { fontSize: 11, color: '#746a61', marginTop: 2 },
  safety: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' }, safetyText: { fontSize: 18, fontWeight: '900', color: '#6d381c', letterSpacing: 1 },
  stream: { flex: 1 }, streamContent: { padding: 16, paddingBottom: 24 }, bubbleWrap: { alignItems: 'flex-start', marginBottom: 9 }, mineWrap: { alignItems: 'flex-end' },
  bubble: { maxWidth: '80%', backgroundColor: '#fff', borderWidth: 1, borderColor: '#eadfd5', paddingHorizontal: 14, paddingVertical: 10, borderRadius: 19, borderBottomLeftRadius: 5 },
  mine: { backgroundColor: '#321708', borderColor: '#321708', borderBottomLeftRadius: 19, borderBottomRightRadius: 5 }, text: { fontSize: 15, lineHeight: 21, color: '#2d211b' }, mineText: { color: '#fff' },
  time: { fontSize: 9, color: '#9a8c82', marginTop: 3, marginHorizontal: 5 }, compose: { backgroundColor: '#fff', borderTopWidth: 1, borderTopColor: '#eadfd5', padding: 10, flexDirection: 'row', alignItems: 'flex-end', gap: 8 },
  input: { flex: 1, minHeight: 45, maxHeight: 110, borderWidth: 1, borderColor: '#ddd0c6', borderRadius: 23, paddingHorizontal: 15, paddingTop: 12, paddingBottom: 10, fontSize: 15, color: '#24150d' },
  send: { width: 46, height: 46, borderRadius: 23, backgroundColor: '#321708', alignItems: 'center', justifyContent: 'center' }, sendText: { color: '#fff', fontSize: 22, fontWeight: '900' },
  empty: { alignItems: 'center', paddingTop: 120 }, emptyText: { color: '#746a61', marginTop: 10 },
});
