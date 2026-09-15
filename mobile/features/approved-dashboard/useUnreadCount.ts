import { useCallback, useState } from 'react';
import { AppState } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { supabase } from '../../lib/supabase';
import { requireCurrentUser } from '../../lib/session';
import { unreadNotifications, withMessageDeadline } from '../../lib/messaging';

export function useUnreadCount(supplied?: number) {
  const [count, setCount] = useState<number | undefined>(undefined);
  useFocusEffect(useCallback(() => {
    if (supplied !== undefined) return;
    let live = true, running = false, id = '';
    let channel: ReturnType<typeof supabase.channel> | undefined;
    async function load() {
      if (!live || running) return;
      running = true;
      try {
        const { data: { session }, error } = await withMessageDeadline(supabase.auth.getSession());
        if (error || !session) { if (live) setCount(undefined); return; }
        id = session.user.id;
        const rows = await unreadNotifications(supabase, id);
        await requireCurrentUser(id);
        if (!live) return;
        setCount(rows.filter(row => row.type === 'message').length);
        if (!channel) channel = supabase.channel(`approved-nav-${id}`)
          .on('postgres_changes', { event: '*', schema: 'public', table: 'notifications', filter: `recipient_id=eq.${id}` }, () => { void load(); })
          .on('postgres_changes', { event: '*', schema: 'public', table: 'discovery_message_notifications', filter: `recipient_id=eq.${id}` }, () => { void load(); }).subscribe();
      } catch { /* Unknown count is hidden; it is never presented as zero. */ if (live) setCount(undefined); }
      finally { running = false; }
    }
    void load();
    const foreground = AppState.addEventListener('change', state => { if (state === 'active') void load(); });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_OUT' || (id && session?.user.id !== id)) { live = false; setCount(undefined); }
    });
    return () => { live = false; setCount(undefined); foreground.remove(); subscription.unsubscribe(); if (channel) void supabase.removeChannel(channel); };
  }, [supplied]));
  return supplied ?? count;
}
