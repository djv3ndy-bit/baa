import { supabase } from '@/lib/supabase';
import { authenticatedApi } from '@/lib/api';

export type DiscoveryRole = 'barista' | 'cafe_owner_manager';

export async function sendDiscoveryInterest(senderId: string, targetId: string, role: DiscoveryRole) {
  const { error } = await supabase
    .from('discovery_interests')
    .upsert({ sender_id: senderId, target_id: targetId }, { onConflict: 'sender_id,target_id' });
  if (error) throw error;

  const { data: reciprocal, error: reciprocalError } = await supabase
    .from('discovery_interests')
    .select('id')
    .eq('sender_id', targetId)
    .eq('target_id', senderId)
    .maybeSingle();
  if (reciprocalError) throw reciprocalError;
  if (!reciprocal) {
    authenticatedApi('/push-event', { type: 'interest', target_id: targetId }).catch(error => console.warn('Interest notification failed', error?.message || error));
    return { matched: false };
  }

  const baristaId = role === 'barista' ? senderId : targetId;
  const cafeId = role === 'cafe_owner_manager' ? senderId : targetId;
  const { data: match, error: matchError } = await supabase
    .from('discovery_matches')
    .upsert({ barista_id: baristaId, cafe_id: cafeId }, { onConflict: 'barista_id,cafe_id' })
    .select('id')
    .single();
  if (matchError) throw matchError;
  authenticatedApi('/push-event', { type: 'interest', target_id: targetId }).catch(error => console.warn('Match notification failed', error?.message || error));
  return { matched: true, matchId: match.id as string };
}
