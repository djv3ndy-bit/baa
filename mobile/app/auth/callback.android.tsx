import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, SafeAreaView, StyleSheet, Text, View } from 'react-native';
import { router, useFocusEffect, useLocalSearchParams, useRootNavigationState } from 'expo-router';

import { MOBILE_AUTH_CALLBACK_PREFIX } from '@/lib/authCallback';
import { ANDROID_AUTH_HANDOFF_PARAM, androidAuthCallbackHandoff } from '@/lib/androidAuthCallbackHandoff';
import { androidAuthCallbackMessage, androidAuthCallbackReference, createAndroidAuthCallback, type AndroidAuthCallbackState } from '@/lib/androidAuthCallback';
import { completeMobileAuth, getCurrentContext, requireCurrentUser } from '@/lib/session';

export default function AndroidAuthCallbackScreen() {
  const [state, setState] = useState<AndroidAuthCallbackState>({ phase: 'working' });
  const params = useLocalSearchParams();
  const handoff = typeof params[ANDROID_AUTH_HANDOFF_PARAM] === 'string' ? params[ANDROID_AUTH_HANDOFF_PARAM] as string : null;
  const navigationReady = !!useRootNavigationState()?.key;
  const routeUrlRef = useRef(handoff);
  const deliveryRef = useRef<{ ref: string; delivery: { url: string; source: 'initial' | 'current' } } | null>(null);
  const navigationReadyRef = useRef(navigationReady);
  routeUrlRef.current = handoff;
  navigationReadyRef.current = navigationReady;
  const callbackRef = useRef<ReturnType<typeof createAndroidAuthCallback> | null>(null);
  if (!callbackRef.current) callbackRef.current = createAndroidAuthCallback({
    exchange: completeMobileAuth,
    context: getCurrentContext,
    assertCurrentUser: requireCurrentUser,
    navigate: hasRole => router.replace(hasRole ? '/home' : { pathname: '/signup', params: { complete: '1' } }),
    changed: setState,
    delay: (callback, milliseconds) => { const timer = setTimeout(callback, milliseconds); return () => clearTimeout(timer); },
  });
  const callback = callbackRef.current;
  const receiveRoute = useCallback(() => {
    const input = routeUrlRef.current;
    if (input === null) { callback.receive(null); return; }
    if (deliveryRef.current?.ref !== input) {
      deliveryRef.current = { ref: input, delivery: androidAuthCallbackHandoff.take(input) ?? { url: MOBILE_AUTH_CALLBACK_PREFIX, source: 'current' } };
    }
    const delivery = deliveryRef.current.delivery;
    callback.receive(delivery.url, delivery.source);
  }, [callback]);

  useFocusEffect(useCallback(() => {
    callback.activate();
    callback.setNavigationReady(navigationReadyRef.current);
    // The official native-intent hook captured the raw URL before Router
    // discarded its fragment. Consume only this route's one-time reference.
    receiveRoute();
    return () => {
      callback.deactivate();
      if (deliveryRef.current) androidAuthCallbackHandoff.clear(deliveryRef.current.ref);
      deliveryRef.current = null;
    };
  }, [callback, receiveRoute]));
  useEffect(receiveRoute, [receiveRoute, handoff]);
  useEffect(() => { callback.setNavigationReady(navigationReady); }, [callback, navigationReady]);

  const failed = state.phase === 'failed';
  return <SafeAreaView style={styles.safe}><View style={styles.card}>
    {failed ? <>
      <Text accessibilityRole="alert" style={styles.title}>Sign-in could not finish.</Text>
      <Text style={styles.copy}>{androidAuthCallbackMessage(state)}</Text>
      <Text style={styles.reference}>Support reference: {androidAuthCallbackReference(state)}</Text>
      {state.reason !== 'callback_changed' && <Pressable accessibilityRole="button" onPress={callback.retry} style={styles.primary}><Text style={styles.primaryText}>Try again</Text></Pressable>}
      <Pressable accessibilityRole="button" onPress={() => {
        callback.deactivate();
        if (deliveryRef.current) androidAuthCallbackHandoff.clear(deliveryRef.current.ref);
        deliveryRef.current = null;
        router.replace('/login');
      }} style={styles.linkButton}><Text style={styles.linkText}>Return to login</Text></Pressable>
    </> : <>
      <ActivityIndicator color="#a95820" size="large" />
      <Text style={styles.title}>Finishing your sign-in…</Text>
      <Text style={styles.copy}>{androidAuthCallbackMessage(state)}</Text>
    </>}
  </View></SafeAreaView>;
}

const styles = StyleSheet.create({
  safe: { flex: 1, justifyContent: 'center', padding: 24, backgroundColor: '#fff4e8' },
  card: { backgroundColor: '#fff', borderRadius: 24, padding: 28, alignItems: 'center', shadowColor: '#321708', shadowOpacity: 0.1, shadowRadius: 20, shadowOffset: { width: 0, height: 8 } },
  title: { marginTop: 18, color: '#321708', fontFamily: 'serif', fontSize: 27, fontWeight: '700', textAlign: 'center' },
  copy: { marginTop: 10, marginBottom: 12, color: '#746a61', fontSize: 15, lineHeight: 22, textAlign: 'center' },
  reference: { color: '#746a61', fontSize: 12, textAlign: 'center' },
  primary: { width: '100%', marginTop: 14, borderRadius: 10, paddingVertical: 15, alignItems: 'center', backgroundColor: '#a95820' },
  primaryText: { color: '#fff', fontSize: 16, fontWeight: '800' },
  linkButton: { marginTop: 12, padding: 10 },
  linkText: { color: '#746a61', fontSize: 15, fontWeight: '700' },
});
