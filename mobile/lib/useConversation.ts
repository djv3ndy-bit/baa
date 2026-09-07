import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { supabase } from './supabase';
import { getCurrentContext } from './session';
import { authenticatedApi } from './api';
import { isMessageAllowed } from './safety';
import { allMessageRows, ChatMessage, ConversationKind, deliverMessage, LatestMessageRequest, markChatRead, mergeMessages, messageDrafts, messageError, withMessageDeadline } from './messaging';

type Scope = { key: string; id: string; kind: ConversationKind; userId: string; live: boolean; ready: boolean; guard: LatestMessageRequest; reload: () => Promise<void> };

export function useConversation(id: string, kind: ConversationKind) {
  const routeKey = `${kind}:${id}`;
  const active = useRef<Scope | null>(null);
  const [attempt, setAttempt] = useState(0), [, redrawDraft] = useState(0);
  const [stateKey, setStateKey] = useState('');
  const [loading, setLoading] = useState(true), [refreshing, setRefreshing] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [me, setMe] = useState(''), [otherUserId, setOtherUserId] = useState(''), [name, setName] = useState('Conversation');
  const [loadError, setLoadError] = useState(''), [readError, setReadError] = useState(''), [ready, setReady] = useState(false);

  useEffect(() => messageDrafts.subscribe(() => redrawDraft(value => value + 1)), []);

  useFocusEffect(useCallback(() => {
    const scope: Scope = { key: routeKey, id, kind, userId: '', live: true, ready: false, guard: new LatestMessageRequest(), reload: async () => {} };
    active.current = scope;
    let channel: ReturnType<typeof supabase.channel> | null = null;
    const current = () => scope.live && active.current === scope;
    setStateKey(routeKey); setLoading(true); setReady(false); setMessages([]); setMe(''); setOtherUserId(''); setName('Conversation'); setLoadError(''); setReadError('');

    scope.reload = async () => {
      if (!current() || !scope.ready) return;
      const latest = scope.guard.begin();
      setRefreshing(true);
      try {
        const rows = await allMessageRows<ChatMessage>(() => supabase.from(kind === 'discovery' ? 'discovery_messages' : 'messages').select('id,sender_id,body,created_at').eq(kind === 'discovery' ? 'match_id' : 'application_id', id).order('created_at').order('id'));
        if (!current() || !latest()) return;
        setMessages(rows); setLoadError(''); setLoading(false);
        if (AppState.currentState === 'active') {
          try { await markChatRead(supabase, kind, id); if (current() && latest()) setReadError(''); }
          catch { if (current() && latest()) setReadError('Messages loaded. Pull to refresh to update unread status.'); }
        }
      } catch (error) { if (current() && latest()) setLoadError(messageError(error, 'Messages could not load. Please try again.')); }
      finally { if (current() && latest()) { setLoading(false); setRefreshing(false); } }
    };

    async function boot() {
      try {
        if (!id) throw new Error('This conversation link is incomplete. Open Messages and choose a match.');
        const { user, role } = await withMessageDeadline(getCurrentContext());
        if (!current()) return;
        if (!user) { router.replace('/login'); return; }
        if (!role) { router.replace('/signup'); return; }
        scope.userId = user.id;
        const query = kind === 'discovery'
          ? supabase.from('discovery_matches').select('id,barista_id,cafe_id,barista:profiles!discovery_matches_barista_id_fkey(display_name),cafe:profiles!discovery_matches_cafe_id_fkey(cafe_name)').eq('id', id)
          : supabase.from('applications').select('id,barista_id,barista:profiles!applications_barista_id_fkey(display_name),job:jobs(title,owner_id,owner:profiles!jobs_owner_id_fkey(cafe_name))').eq('id', id).eq('status', 'matched');
        const { data, error } = await withMessageDeadline(query.maybeSingle());
        if (!current()) return;
        if (error) throw error;
        const match: any = data;
        if (kind === 'application' && match?.barista_id === user.id && !match.job?.owner_id) {
          const details = await authenticatedApi<{ cafe: { id: string; name: string }; job: { id: string; title: string } }>(`/conversation-details?application_id=${encodeURIComponent(id)}`, {}, 'GET', user.id);
          if (!current()) return;
          match.job = { ...details.job, owner_id: details.cafe.id, owner: { cafe_name: details.cafe.name } };
        }
        const cafeId = kind === 'discovery' ? match?.cafe_id : match?.job?.owner_id;
        if (!match || ![match.barista_id, cafeId].includes(user.id)) throw new Error('This conversation is no longer available. Open Messages to choose another match.');
        const other = user.id === match.barista_id ? cafeId : match.barista_id;
        if (!other) throw new Error('This matched account is no longer available.');
        setMe(user.id); setOtherUserId(other);
        setName(user.id === match.barista_id ? (kind === 'discovery' ? match.cafe?.cafe_name : match.job?.owner?.cafe_name) || 'Café' : match.barista?.display_name || 'Barista');
        scope.ready = true; setReady(true);
        channel = supabase.channel(`mobile-chat-${kind}-${id}`)
          .on('postgres_changes', { event: 'INSERT', schema: 'public', table: kind === 'discovery' ? 'discovery_messages' : 'messages', filter: `${kind === 'discovery' ? 'match_id' : 'application_id'}=eq.${id}` }, () => { void scope.reload(); })
          .subscribe();
        await scope.reload();
      } catch (error) { if (current()) { setLoadError(messageError(error)); setLoading(false); setReady(false); } }
    }
    void boot();
    const appState = AppState.addEventListener('change', state => { if (state === 'active') void scope.reload(); });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      if (scope.userId && (event === 'SIGNED_OUT' || (session && session.user.id !== scope.userId))) {
        scope.live = false; scope.guard.invalidate(); setMessages([]); setReady(false); setMe(''); router.replace('/login');
      }
    });
    return () => { scope.live = false; scope.guard.invalidate(); appState.remove(); subscription.unsubscribe(); if (channel) void supabase.removeChannel(channel); };
  }, [id, kind, routeKey, attempt]));

  const scope = active.current, sameRoute = stateKey === routeKey;
  const draftKey = sameRoute && me ? `${me}:${routeKey}` : '';
  const draft = messageDrafts.snapshot(draftKey);
  function setBody(body: string) { if (draftKey) messageDrafts.edit(draftKey, body); }
  async function send() {
    const target = active.current;
    if (!target?.live || !target.ready || target.key !== routeKey || !target.userId) return;
    const key = `${target.userId}:${target.key}`, original = messageDrafts.snapshot(key).body;
    if (!isMessageAllowed(original)) { setLoadError('Please remove threatening, hateful, or abusive language and try again.'); return; }
    const message = await messageDrafts.send(key, (text, clientMessageId) => deliverMessage(supabase, authenticatedApi, { kind: target.kind, id: target.id, senderId: target.userId, body: text, clientMessageId }));
    if (message && active.current === target && target.live) {
      target.guard.invalidate(); setLoading(false); setRefreshing(false); setLoadError(''); setMessages(rows => mergeMessages(rows, [message]));
      void target.reload();
    }
  }
  function retry() { if (scope?.live && scope.ready) void scope.reload(); else setAttempt(value => value + 1); }
  return { loading: !sameRoute || loading, refreshing, ready: sameRoute && ready, messages: sameRoute ? messages : [], me, otherUserId, name, body: draft.body, sending: draft.sending, error: draft.error || loadError || readError, setBody, send, retry };
}
