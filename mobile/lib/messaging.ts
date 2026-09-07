import type { SupabaseClient } from '@supabase/supabase-js';

export type ConversationKind = 'application' | 'discovery';
export type ChatMessage = { id: string; sender_id: string; body: string; created_at: string };
export type Conversation = { id: string; kind: ConversationKind; name: string; preview: string; unread: number; updatedAt: string };
export type UnreadNotification = { id: string; type: string; application_id?: string | null; discovery_match_id?: string | null; read_at?: string | null };
type Role = 'barista' | 'cafe_owner_manager';
type QueryResult<T> = { data: T[] | null; error: { message: string } | null };

export function messageError(error: unknown, fallback = 'Check your connection and try again.') {
  if (error instanceof TypeError) return 'Connection lost. Check this conversation before trying again.';
  return error && typeof error === 'object' && 'message' in error ? String(error.message) : fallback;
}

export async function withMessageDeadline<T>(operation: PromiseLike<T>, milliseconds = 20000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('The request timed out. Check your connection and refresh before trying again.')), milliseconds);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

export async function allMessageRows<T>(query: () => { range: (from: number, to: number) => PromiseLike<QueryResult<T>> }): Promise<T[]> {
  const rows: T[] = [];
  for (let offset = 0; ;) {
    const { data, error } = await withMessageDeadline(query().range(offset, offset + 499));
    if (error) throw error;
    if (!Array.isArray(data)) throw new Error('The results could not be confirmed. Please refresh.');
    if (!data.length) return rows;
    rows.push(...data); offset += data.length;
  }
}

export async function unreadNotifications(client: SupabaseClient, userId: string): Promise<UnreadNotification[]> {
  const [legacy, discovery] = await Promise.all([
    allMessageRows<UnreadNotification>(() => client.from('notifications').select('id,type,application_id,read_at').eq('recipient_id', userId).is('read_at', null).order('created_at').order('id')),
    allMessageRows<{ id: string; discovery_match_id: string; read_at: string | null }>(() => client.from('discovery_message_notifications').select('id,discovery_match_id,read_at').eq('recipient_id', userId).is('read_at', null).order('created_at').order('id')),
  ]);
  return [...legacy, ...discovery.map(row => ({ id: `discovery:${row.id}`, type: 'message', discovery_match_id: row.discovery_match_id, read_at: row.read_at }))];
}

export function buildConversations(role: Role, legacy: any[], mutual: any[], legacyMessages: any[], mutualMessages: any[], notifications: UnreadNotification[]): Conversation[] {
  const latest = new Map<string, any>(), unread = new Map<string, number>();
  for (const [kind, rows, column] of [['application', legacyMessages, 'application_id'], ['discovery', mutualMessages, 'match_id']] as const) {
    for (const message of rows) {
      const key = `${kind}:${message[column]}`, previous = latest.get(key);
      if (!previous || message.created_at > previous.created_at) latest.set(key, message);
    }
  }
  for (const row of notifications) {
    if (row.type !== 'message' || row.read_at) continue;
    const key = row.discovery_match_id ? `discovery:${row.discovery_match_id}` : row.application_id ? `application:${row.application_id}` : '';
    if (key) unread.set(key, (unread.get(key) || 0) + 1);
  }
  const rows: Conversation[] = [];
  for (const [kind, matches] of [['application', legacy], ['discovery', mutual]] as const) {
    for (const match of matches) {
      const key = `${kind}:${match.id}`, message = latest.get(key);
      const name = role === 'barista' ? (kind === 'discovery' ? match.cafe?.cafe_name : match.job?.owner?.cafe_name) || 'Café' : match.barista?.display_name || 'Barista';
      rows.push({ id: match.id, kind, name, preview: message?.body || match.job?.title || 'Start the conversation', unread: unread.get(key) || 0, updatedAt: message?.created_at || match.created_at || '' });
    }
  }
  return rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
}

export async function loadConversations(client: SupabaseClient, userId: string, role: Role) {
  const [legacy, mutual, notifications] = await Promise.all([
    allMessageRows<any>(() => {
      const jobJoin = role === 'barista' ? 'jobs' : 'jobs!inner';
      let query = client.from('applications').select(`id,created_at,barista:profiles!applications_barista_id_fkey(display_name),job:${jobJoin}(title,owner_id,owner:profiles!jobs_owner_id_fkey(cafe_name))`).eq('status', 'matched');
      query = role === 'barista' ? query.eq('barista_id', userId) : query.eq('job.owner_id', userId);
      return query.order('created_at', { ascending: false }).order('id');
    }),
    allMessageRows<any>(() => client.from('discovery_matches').select('id,created_at,barista_id,cafe_id,barista:profiles!discovery_matches_barista_id_fkey(display_name),cafe:profiles!discovery_matches_cafe_id_fkey(cafe_name)').eq(role === 'barista' ? 'barista_id' : 'cafe_id', userId).order('created_at', { ascending: false }).order('id')),
    unreadNotifications(client, userId),
  ]);
  async function previews(table: string, column: string, ids: string[]) {
    const rows: any[] = [];
    for (let offset = 0; offset < ids.length; offset += 100) {
      rows.push(...await allMessageRows<any>(() => client.from(table).select(`${column},body,created_at,id`).in(column, ids.slice(offset, offset + 100)).order('created_at', { ascending: false }).order('id')));
    }
    return rows;
  }
  const [legacyMessages, mutualMessages] = await Promise.all([previews('messages', 'application_id', legacy.map(row => row.id)), previews('discovery_messages', 'match_id', mutual.map(row => row.id))]);
  return buildConversations(role, legacy, mutual, legacyMessages, mutualMessages, notifications);
}

export class LatestMessageRequest {
  private version = 0;
  begin() { const version = ++this.version; return () => version === this.version; }
  invalidate() { this.version++; }
}

export function mergeMessages(current: ChatMessage[], incoming: ChatMessage[]) {
  const byId = new Map(current.map(message => [message.id, message]));
  incoming.forEach(message => byId.set(message.id, message));
  return [...byId.values()].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
}

export function messageAttemptId() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, character => {
    const value = Math.floor(Math.random() * 16);
    return (character === 'x' ? value : (value & 3) | 8).toString(16);
  });
}

type Draft = { body: string; sending: boolean; error: string; attempt?: { body: string; id: string } };
export class MessageDraftStore {
  private drafts = new Map<string, Draft>();
  private listeners = new Set<() => void>();
  snapshot(key: string): Draft { return { ...(this.drafts.get(key) || { body: '', sending: false, error: '' }) }; }
  subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private update(key: string, changes: Partial<Draft>) { this.drafts.set(key, { ...this.snapshot(key), ...changes }); this.listeners.forEach(listener => listener()); }
  edit(key: string, body: string) { const previous = this.snapshot(key); this.update(key, { body, ...(body.trim() !== previous.body.trim() ? { attempt: undefined } : {}) }); }
  async send(key: string, deliver: (text: string, attemptId: string) => Promise<ChatMessage>): Promise<ChatMessage | null> {
    const draft = this.snapshot(key), text = draft.body.trim();
    if (draft.sending || !text) return null;
    const attempt = draft.attempt?.body === text ? draft.attempt : { body: text, id: messageAttemptId() };
    this.update(key, { sending: true, error: '', attempt });
    try {
      const message = await deliver(text, attempt.id);
      if (!message?.id) throw new Error('Delivery could not be confirmed. Check this conversation before trying again.');
      if (this.snapshot(key).body === draft.body) this.update(key, { body: '', attempt: undefined });
      return message;
    } catch (error) {
      this.update(key, { error: messageError(error, 'Message could not be sent. Check this conversation before trying again.') });
      return null;
    } finally { this.update(key, { sending: false }); }
  }
}

export const messageDrafts = new MessageDraftStore();

type Api = <T>(path: string, body: Record<string, unknown>, method?: 'GET' | 'POST', expectedUserId?: string) => Promise<T>;
export async function deliverMessage(client: SupabaseClient, api: Api, input: { kind: ConversationKind; id: string; senderId: string; body: string; clientMessageId: string }): Promise<ChatMessage> {
  const { kind, id, senderId, body, clientMessageId } = input;
  const { data, error } = await withMessageDeadline(client.auth.getSession());
  if (error || !data.session?.access_token) throw new Error('Your session expired. Please log in again.');
  if (data.session.user.id !== senderId) throw new Error('Your account changed. Reopen this conversation before sending.');
  if (kind === 'application') {
    const result = await withMessageDeadline(api<{ message: ChatMessage }>('/send-message', { application_id: id, body, client_message_id: clientMessageId }, 'POST', senderId));
    return result.message;
  }
  let result = await withMessageDeadline(client.from('discovery_messages').insert({ id: clientMessageId, match_id: id, sender_id: senderId, body }).select('id,sender_id,body,created_at').single());
  if (result.error?.code === '23505') {
    result = await withMessageDeadline(client.from('discovery_messages').select('id,sender_id,body,created_at').eq('id', clientMessageId).eq('match_id', id).eq('sender_id', senderId).single());
    if (!result.error && result.data?.body !== body) throw new Error('The earlier delivery could not be verified. Reopen this conversation before trying again.');
  }
  if (result.error) throw result.error;
  if (!result.data?.id) throw new Error('Delivery could not be confirmed. Check this conversation before trying again.');
  void api('/push-event', { type: 'discovery_message', match_id: id, message_id: result.data.id }, 'POST', senderId).catch(error => console.warn('Message notification failed', messageError(error)));
  return result.data as ChatMessage;
}

export async function markChatRead(client: SupabaseClient, kind: ConversationKind, id: string) {
  const { error } = await withMessageDeadline(client.rpc(kind === 'discovery' ? 'mark_discovery_conversation_read' : 'mark_conversation_read', kind === 'discovery' ? { p_match_id: id } : { p_application_id: id }));
  if (error) throw error;
}
