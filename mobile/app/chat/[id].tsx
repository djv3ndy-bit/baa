import { useRef, useState } from 'react';
import { ActivityIndicator, Alert, KeyboardAvoidingView, Platform, Pressable, RefreshControl, SafeAreaView, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { blockUser, reportUser } from '@/lib/safety';
import { useConversation } from '@/lib/useConversation';

type ReportReason = 'harassment' | 'spam_or_scam';

export default function Chat() {
  const params = useLocalSearchParams<{ id: string; kind?: 'discovery' | 'application' }>();
  const id = typeof params.id === 'string' ? params.id : '';
  const discovery = params.kind === 'discovery';
  const { loading, refreshing, ready, messages, body, setBody, me, otherUserId, name, sending, error, send, retry } = useConversation(id, discovery ? 'discovery' : 'application');
  const [safetyBusy, setSafetyBusy] = useState(false);
  const scroll = useRef<ScrollView>(null);

  function openSafetyMenu() {
    if (!ready || !otherUserId || safetyBusy) return;
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
          <Pressable accessibilityRole="button" accessibilityLabel="Go back" onPress={() => router.back()} style={s.back}><Text allowFontScaling={false} style={s.backText}>‹</Text></Pressable>
          <View style={s.avatar}><Text>☕</Text></View>
          <View style={s.heading}><Text accessibilityLabel={name} numberOfLines={2} ellipsizeMode="tail" style={s.name}>{name}</Text><Text numberOfLines={2} style={s.sub}>Mutual match · Private conversation</Text></View>
          <Pressable accessibilityRole="button" accessibilityLabel="Conversation safety options" disabled={!ready || safetyBusy} onPress={openSafetyMenu} style={s.safety}><Text allowFontScaling={false} style={s.safetyText}>•••</Text></Pressable>
        </View>
        {error ? <View style={s.error}><Text accessibilityRole="alert" style={s.errorText}>{error}</Text><Pressable accessibilityRole="button" onPress={retry}><Text style={s.retry}>Refresh conversation</Text></Pressable></View> : null}
        <ScrollView ref={scroll} style={s.stream} contentContainerStyle={s.streamContent} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={retry} />} onContentSizeChange={() => scroll.current?.scrollToEnd({ animated: true })}>
          {messages.length ? messages.map(message => (
            <View key={message.id} style={[s.bubbleWrap, message.sender_id === me && s.mineWrap]}>
              <View style={[s.bubble, message.sender_id === me && s.mine]}><Text style={[s.text, message.sender_id === me && s.mineText]}>{message.body}</Text></View>
              <Text style={s.time}>{new Date(message.created_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</Text>
            </View>
          )) : !error && ready ? <View style={s.empty}><Text style={{ fontSize: 38 }}>👋</Text><Text style={s.emptyText}>Say hello and start the conversation.</Text></View> : null}
        </ScrollView>
        {ready ? <View style={s.compose}>
          <TextInput accessibilityLabel="Message" value={body} onChangeText={setBody} placeholder="Message…" multiline maxLength={2000} style={s.input} placeholderTextColor="#9b8d84" />
          <Pressable accessibilityRole="button" accessibilityLabel={sending ? "Sending message" : "Send message"} disabled={sending || !body.trim()} onPress={send} style={[s.send, (sending || !body.trim()) && { opacity: .5 }]}><Text style={s.sendText}>↑</Text></Pressable>
        </View> : null}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  error: { padding: 14, backgroundColor: '#fff4e8' }, errorText: { color: '#84341f', fontSize: 13, lineHeight: 19 }, retry: { color: '#321708', fontWeight: '800', paddingVertical: 10 },
  safe: { flex: 1, backgroundColor: '#f7f0e9' }, center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  header: { minHeight: 72, paddingVertical: 8, backgroundColor: '#fff', borderBottomWidth: 1, borderBottomColor: '#eadfd5', flexDirection: 'row', alignItems: 'center', paddingHorizontal: 10, gap: 8 },
  back: { flexShrink: 0, width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }, backText: { fontSize: 36, color: '#321708', marginTop: -5 },
  avatar: { flexShrink: 0, width: 42, height: 42, borderRadius: 21, backgroundColor: '#f3e8de', alignItems: 'center', justifyContent: 'center' },
  heading: { flex: 1, minWidth: 0 }, name: { fontSize: 16, fontWeight: '900', color: '#24150d' }, sub: { fontSize: 11, color: '#746a61', marginTop: 2 },
  safety: { flexShrink: 0, width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }, safetyText: { fontSize: 18, fontWeight: '900', color: '#6d381c', letterSpacing: 1 },
  stream: { flex: 1 }, streamContent: { padding: 16, paddingBottom: 24 }, bubbleWrap: { alignItems: 'flex-start', marginBottom: 9 }, mineWrap: { alignItems: 'flex-end' },
  bubble: { maxWidth: '80%', backgroundColor: '#fff', borderWidth: 1, borderColor: '#eadfd5', paddingHorizontal: 14, paddingVertical: 10, borderRadius: 19, borderBottomLeftRadius: 5 },
  mine: { backgroundColor: '#321708', borderColor: '#321708', borderBottomLeftRadius: 19, borderBottomRightRadius: 5 }, text: { fontSize: 15, lineHeight: 21, color: '#2d211b' }, mineText: { color: '#fff' },
  time: { fontSize: 9, color: '#9a8c82', marginTop: 3, marginHorizontal: 5 }, compose: { backgroundColor: '#fff', borderTopWidth: 1, borderTopColor: '#eadfd5', padding: 10, flexDirection: 'row', alignItems: 'flex-end', gap: 8 },
  input: { flex: 1, minHeight: 45, maxHeight: 110, borderWidth: 1, borderColor: '#ddd0c6', borderRadius: 23, paddingHorizontal: 15, paddingTop: 12, paddingBottom: 10, fontSize: 15, color: '#24150d' },
  send: { width: 46, height: 46, borderRadius: 23, backgroundColor: '#321708', alignItems: 'center', justifyContent: 'center' }, sendText: { color: '#fff', fontSize: 22, fontWeight: '900' },
  empty: { alignItems: 'center', paddingTop: 120 }, emptyText: { color: '#746a61', marginTop: 10 },
});
