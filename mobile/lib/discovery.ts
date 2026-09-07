import { supabase } from '@/lib/supabase';
import { authenticatedApi } from '@/lib/api';

export type DiscoveryRole = 'barista' | 'cafe_owner_manager';

export async function sendDiscoveryInterest(senderId: string, targetId: string, role: DiscoveryRole) {
  const { data: { session }, error: sessionError } = await supabase.auth.getSession();
  if (sessionError) throw sessionError;
  if (!session || session.user.id !== senderId) throw new Error('Your signed-in account changed. Refresh and try again.');
  // Insert-and-read also works when a previous attempt succeeded before its response was lost.
  const { error } = await supabase.from('discovery_interests').insert({ sender_id: senderId, target_id: targetId });
  if (error && error.code !== '23505') throw error;
  const { data: reciprocal, error: reciprocalError } = await supabase.from('discovery_interests').select('id').eq('sender_id', targetId).eq('target_id', senderId).maybeSingle();
  if (reciprocalError) throw reciprocalError;
  if (!reciprocal) {
    authenticatedApi('/push-event', { type: 'interest', target_id: targetId }, 'POST', senderId).catch(() => {});
    return { matched: false };
  }
  const baristaId = role === 'barista' ? senderId : targetId, cafeId = role === 'cafe_owner_manager' ? senderId : targetId;
  const { error: matchError } = await supabase.from('discovery_matches').insert({ barista_id: baristaId, cafe_id: cafeId });
  if (matchError && matchError.code !== '23505') throw matchError;
  const { data: match, error: readError } = await supabase.from('discovery_matches').select('id').eq('barista_id', baristaId).eq('cafe_id', cafeId).single();
  if (readError) throw readError;
  if (!match) throw new Error('The match could not be confirmed. Please refresh and try again.');
  authenticatedApi('/push-event', { type: 'interest', target_id: targetId }, 'POST', senderId).catch(() => {});
  return { matched: true, matchId: match.id as string };
}
