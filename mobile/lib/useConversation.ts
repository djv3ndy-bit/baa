import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { supabase } from './supabase';
import { getCurrentContext } from './session';
import { authenticatedApi } from './api';
import { isMessageAllowed } from './safety';
import { allMessageRows, ChatMessage, ConversationKind, deliverMessage, LatestMessageRequest, markChatRead, mergeMessages, messageDrafts, messageError, withMessageDeadline } from './messaging';
import { useSectionMemory } from '../features/section-memory/useSectionMemory';
import { sectionMemory } from '../features/section-memory/store';

type DisplaySnapshot = { me: string; otherUserId: string; name: string; messages: ChatMessage[] };
type Scope = { key: string; id: string; kind: ConversationKind; userId: string; role: string; live: boolean; ready: boolean; display: DisplaySnapshot; current: () => boolean; guard: LatestMessageRequest; reload: (manual?: boolean) => Promise<void> };

export function useConversation(id: string, kind: ConversationKind) {
  const routeKey = `${kind}:${id}`;
  const cacheKey = `conversation:${routeKey}`;
  const memory = useSectionMemory<DisplaySnapshot>(cacheKey);
  const active = useRef<Scope | null>(null);
  const [attempt, setAttempt] = useState(0), [, redrawDraft] = useState(0);
  const [stateKey, setStateKey] = useState(routeKey);
  const [loading, setLoading] = useState(!memory.initial), [refreshing, setRefreshing] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>(memory.initial?.messages ?? []);
  const [me, setMe] = useState(memory.initial?.me ?? ''), [otherUserId, setOtherUserId] = useState(memory.initial?.otherUserId ?? ''), [name, setName] = useState(memory.initial?.name ?? 'Conversation');
  const [loadError, setLoadError] = useState(''), [readError, setReadError] = useState(''), [ready, setReady] = useState(false);

  useEffect(() => messageDrafts.subscribe(() => redrawDraft(value => value + 1)), []);

  useFocusEffect(useCallback(() => {
    const lease = sectionMemory.lease();
    const saved = sectionMemory.read<DisplaySnapshot>(lease, cacheKey);
    const display = saved ?? { me: '', otherUserId: '', name: 'Conversation', messages: [] };
    const scope: Scope = { key: routeKey, id, kind, userId: '', role: '', live: true, ready: false, display, current: () => false, guard: new LatestMessageRequest(), reload: async () => {} };
    active.current = scope;
    let channel: ReturnType<typeof supabase.channel> | null = null;
    const current = scope.current = () => scope.live && active.current === scope && memory.current();
    setStateKey(routeKey); setLoading(!saved); setReady(false); setRefreshing(false); setMessages(display.messages); setMe(display.me); setOtherUserId(display.otherUserId); setName(display.name); setLoadError(''); setReadError('');
    const clearDisplay = () => { scope.ready = false; memory.forget(); setMessages([]); setMe(''); setOtherUserId(''); setName('Conversation'); setReady(false); setLoading(false); setRefreshing(false); };

    scope.reload = async (manual = false) => {
      if (!current() || !scope.ready) return;
      const latest = scope.guard.begin();
      setRefreshing(manual);
      try {
        const rows = await allMessageRows<ChatMessage>(() => supabase.from(kind === 'discovery' ? 'discovery_messages' : 'messages').select('id,sender_id,body,created_at').eq(kind === 'discovery' ? 'match_id' : 'application_id', id).order('created_at').order('id'));
        if (!current() || !latest()) return;
        scope.display = { ...scope.display, messages: rows };
        memory.save(scope.userId, scope.role, scope.display);
        if (!current()) return;
        setMessages(rows); setLoadError(''); setLoading(false);
        if (AppState.currentState === 'active') {
          try { await markChatRead(supabase, kind, id); if (current() && latest()) setReadError(''); }
          catch { if (current() && latest()) setReadError('Messages loaded. Pull to refresh to update unread status.'); }
        }
      } catch (error) { if (current() && latest()) { memory.forget(); setLoadError(messageError(error, 'Messages could not load. Please try again.')); } }
      finally { if (current() && latest()) { setLoading(false); setRefreshing(false); } }
    };

    async function boot() {
      try {
        if (!current()) return;
        if (!id) throw new Error('This conversation link is incomplete. Open Messages and choose a match.');
        const { user, role } = await withMessageDeadline(getCurrentContext());
        if (!current()) return;
        if (!user) { clearDisplay(); router.replace('/login'); return; }
        if (!role) { clearDisplay(); router.replace('/signup'); return; }
        if (lease.accountId && lease.accountId !== user.id) throw new Error('Your session changed. Reopen this conversation before continuing.');
        scope.userId = user.id;
        scope.role = role;
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
        const title = user.id === match.barista_id ? (kind === 'discovery' ? match.cafe?.cafe_name : match.job?.owner?.cafe_name) || 'Café' : match.barista?.display_name || 'Barista';
        scope.display = { ...scope.display, me: user.id, otherUserId: other, name: title };
        setMe(user.id); setOtherUserId(other); setName(title);
        scope.ready = true; setReady(true);
        channel = supabase.channel(`mobile-chat-${kind}-${id}`)
          .on('postgres_changes', { event: 'INSERT', schema: 'public', table: kind === 'discovery' ? 'discovery_messages' : 'messages', filter: `${kind === 'discovery' ? 'match_id' : 'application_id'}=eq.${id}` }, () => { void scope.reload(); })
          .subscribe();
        await scope.reload();
      } catch (error) { if (current()) { clearDisplay(); setLoadError(messageError(error)); } }
    }
    void boot();
    const appState = AppState.addEventListener('change', state => { if (state === 'active') void scope.reload(); });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      // Invalidate even when the account changes before getCurrentContext resolves.
      if (event === 'SIGNED_OUT' || !memory.current() || (scope.userId && session && session.user.id !== scope.userId)) {
        scope.live = false; scope.guard.invalidate(); setMessages([]); setReady(false); setMe(''); router.replace('/login');
      }
    });
    return () => { scope.live = false; scope.guard.invalidate(); appState.remove(); subscription.unsubscribe(); if (channel) void supabase.removeChannel(channel); };
  }, [id, kind, routeKey, cacheKey, attempt, memory]));

  const scope = active.current, sameRoute = stateKey === routeKey;
  const visible = sameRoute && memory.current(), currentScope = !!scope?.current();
  // A mounted screen can remain blurred longer than the snapshot TTL. Its
  // first return render must not expose expired rows before the focus effect.
  const resting = visible && !currentScope ? sectionMemory.read<DisplaySnapshot>(sectionMemory.lease(), cacheKey) : undefined;
  const display = currentScope ? { me, otherUserId, name, messages } : resting;
  const draftKey = visible && display?.me ? `${display.me}:${routeKey}` : '';
  const draft = messageDrafts.snapshot(draftKey);
  function setBody(body: string) { if (draftKey) messageDrafts.edit(draftKey, body); }
  async function send() {
    const target = active.current;
    if (!target?.current() || !target.ready || target.key !== routeKey || !target.userId) return;
    const key = `${target.userId}:${target.key}`, original = messageDrafts.snapshot(key).body;
    if (!isMessageAllowed(original)) { setLoadError('Please remove threatening, hateful, or abusive language and try again.'); return; }
    const assertCurrent = () => { if (!target.current() || !target.ready) throw new Error('Your session changed. Reopen this conversation before sending.'); };
    const client = { auth: { getSession: async () => { const result = await supabase.auth.getSession(); assertCurrent(); return result; } }, from: (table: string) => { assertCurrent(); return supabase.from(table); } } as typeof supabase;
    const api: typeof authenticatedApi = (...args) => { assertCurrent(); return authenticatedApi(...args); };
    const message = await messageDrafts.send(key, (text, clientMessageId) => { assertCurrent(); return deliverMessage(client, api, { kind: target.kind, id: target.id, senderId: target.userId, body: text, clientMessageId }); });
    if (message && target.current()) {
      target.display = { ...target.display, messages: mergeMessages(target.display.messages, [message]) };
      memory.save(target.userId, target.role, target.display);
      if (!target.current()) return;
      target.guard.invalidate(); setLoading(false); setRefreshing(false); setLoadError(''); setMessages(target.display.messages);
      void target.reload();
    }
  }
  function retry() { if (scope?.current() && scope.ready) void scope.reload(true); else setAttempt(value => value + 1); }
  return { loading: !visible || (currentScope ? loading : !resting), refreshing: currentScope && refreshing, ready: visible && ready && currentScope && !!scope?.ready, messages: visible ? display?.messages ?? [] : [], me: visible ? display?.me ?? '' : '', otherUserId: visible ? display?.otherUserId ?? '' : '', name: visible ? display?.name ?? 'Conversation' : 'Conversation', body: draft.body, sending: draft.sending, error: draft.error || loadError || readError, setBody, send, retry };
}
