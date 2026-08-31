import { supabase } from './supabase';

const unsafeMessage = /\b(?:kill\s+you|rape|n[i1]gg(?:er|a)|f[a@]ggot|k[i1]ke)\b/i;

export function isMessageAllowed(value: string) {
  const text = String(value || '').trim();
  return text.length > 0 && text.length <= 2000 && !unsafeMessage.test(text);
}

export async function blockUser(blockedId: string) {
  const { data: auth } = await supabase.auth.getUser();
  const blockerId = auth.user?.id;
  if (!blockerId || !blockedId || blockerId === blockedId) throw new Error('This account cannot be blocked.');
  const { error } = await supabase.from('user_blocks').insert({ blocker_id: blockerId, blocked_id: blockedId });
  if (error && error.code !== '23505') throw error;
}

export async function reportUser(input: {
  reportedId: string;
  conversationId: string;
  conversationKind: 'discovery' | 'application';
  reason: 'harassment' | 'spam_or_scam';
  details?: string;
}) {
  const { data: auth } = await supabase.auth.getUser();
  const reporterId = auth.user?.id;
  if (!reporterId || !input.reportedId || reporterId === input.reportedId) throw new Error('This report cannot be submitted.');
  const { error } = await supabase.from('user_reports').insert({
    reporter_id: reporterId,
    reported_id: input.reportedId,
    conversation_id: input.conversationId,
    conversation_kind: input.conversationKind,
    reason: input.reason,
    details: String(input.details || '').slice(0, 2000) || null,
  });
  if (error) throw error;
}
