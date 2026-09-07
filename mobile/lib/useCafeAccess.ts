import { useCallback, useEffect, useRef, useState } from 'react';
import { router, useFocusEffect } from 'expo-router';
import { getCurrentContext } from './session';
import { supabase } from './supabase';

/** Price-bearing screens stay hidden until the current saved café role is known. */
export function useCafeAccess() {
  const revision = useRef(0);
  const focused = useRef(false);
  const account = useRef<string | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const check = useCallback(async () => {
    if (!focused.current) return;
    const run = ++revision.current;
    setReady(false);
    setError('');
    try {
      const context = await getCurrentContext();
      if (run !== revision.current) return;
      if (!context.user) return router.replace('/login');
      if (!context.role) return router.replace({ pathname: '/signup', params: { complete: '1' } });
      if (context.role !== 'cafe_owner_manager') return router.replace('/home');
      account.current = context.user.id;
      setReady(true);
    } catch (cause) {
      if (run === revision.current) setError(cause instanceof Error ? cause.message : 'Could not verify your café account. Please try again.');
    }
  }, []);
  useFocusEffect(useCallback(() => {
    focused.current = true;
    void check();
    return () => { focused.current = false; ++revision.current; account.current = null; setReady(false); };
  }, [check]));
  useEffect(() => {
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_OUT' || (event === 'SIGNED_IN' && session?.user.id !== account.current)) {
        ++revision.current;
        account.current = null;
        setReady(false);
        // Leave the auth callback before reading the profile/session again.
        setTimeout(() => { void check(); }, 0);
      }
    });
    return () => subscription.unsubscribe();
  }, [check]);
  return { ready, error, retry: check };
}
