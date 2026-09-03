import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Linking, Platform, Pressable, SafeAreaView, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import type { User } from '@supabase/supabase-js';

import { parseMobileAuthCallback } from '@/lib/authCallback';
import { supabase } from '@/lib/supabase';

type AppRole = 'barista' | 'cafe_owner_manager';
type ScreenState = 'checking' | 'choose-role' | 'creating-profile' | 'error';

type ProfileRole = {
  id: string;
  role: string | null;
};

const sleep = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds));

function metadataRole(user: User): AppRole | null {
  const role = user.user_metadata?.role;
  return role === 'barista' || role === 'cafe_owner_manager' ? role : null;
}

function profileName(user: User, role: AppRole) {
  const metadata = user.user_metadata || {};
  const roleName = role === 'barista' ? metadata.display_name : metadata.cafe_name;
  return String(roleName || metadata.full_name || metadata.name || '').trim();
}

async function readProfileWithRetry(userId: string): Promise<ProfileRole | null> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const { data, error } = await supabase
      .from('profiles')
      .select('id,role')
      .eq('id', userId)
      .maybeSingle();

    if (error) throw new Error('profile_lookup_failed');
    if (data) return data as ProfileRole;
    if (attempt < 2) await sleep(250 * (attempt + 1));
  }
  return null;
}

async function saveProfile(user: User, role: AppRole) {
  const isCafe = role === 'cafe_owner_manager';
  const name = profileName(user, role);
  const location = String(user.user_metadata?.location || '').trim();
  const { error } = await supabase.from('profiles').upsert(
    {
      id: user.id,
      role,
      display_name: isCafe ? null : name || null,
      cafe_name: isCafe ? name || null : null,
      location: location || null,
    },
    { onConflict: 'id' },
  );
  if (error) throw new Error('profile_save_failed');

  if (isCafe) {
    const { error: subscriptionError } = await supabase.rpc('ensure_cafe_subscription');
    if (subscriptionError) throw new Error('subscription_setup_failed');
  }
}

export default function AuthCallbackScreen() {
  const handled = useRef(false);
  const [state, setState] = useState<ScreenState>('checking');
  const [pendingUser, setPendingUser] = useState<User | null>(null);

  async function routeAuthenticatedUser(user: User) {
    const profile = await readProfileWithRetry(user.id);
    const role = profile?.role === 'barista' || profile?.role === 'cafe_owner_manager'
      ? profile.role
      : metadataRole(user);

    if (!role) {
      setPendingUser(user);
      setState('choose-role');
      return;
    }

    if (!profile || profile.role !== role) await saveProfile(user, role);
    else if (role === 'cafe_owner_manager') {
      const { error } = await supabase.rpc('ensure_cafe_subscription');
      if (error) throw new Error('subscription_setup_failed');
    }

    router.replace('/home');
  }

  async function completeCallback(url: string | null) {
    const parsed = parseMobileAuthCallback(url);
    if (!parsed.ok) {
      setState('error');
      return;
    }

    try {
      const { data, error } = await supabase.auth.setSession({
        access_token: parsed.accessToken,
        refresh_token: parsed.refreshToken,
      });
      if (error || !data.user) throw new Error('session_setup_failed');
      await routeAuthenticatedUser(data.user);
    } catch {
      setState('error');
    }
  }

  useEffect(() => {
    let active = true;
    let missingUrlTimer: ReturnType<typeof setTimeout> | null = null;

    const handleUrl = (url: string | null) => {
      if (!active || handled.current) return;
      handled.current = true;
      if (missingUrlTimer) clearTimeout(missingUrlTimer);
      void completeCallback(url);
    };

    const subscription = Linking.addEventListener('url', event => handleUrl(event.url));
    void Linking.getInitialURL().then(url => {
      if (url) handleUrl(url);
      else {
        missingUrlTimer = setTimeout(() => {
          if (active && !handled.current) {
            handled.current = true;
            setState('error');
          }
        }, 1500);
      }
    });

    return () => {
      active = false;
      if (missingUrlTimer) clearTimeout(missingUrlTimer);
      subscription.remove();
    };
  }, []);

  async function chooseRole(role: AppRole) {
    if (!pendingUser) return setState('error');
    setState('creating-profile');
    try {
      await saveProfile(pendingUser, role);
      router.replace('/home');
    } catch {
      setState('error');
    }
  }

  async function returnToLogin() {
    await supabase.auth.signOut({ scope: 'local' }).catch(() => undefined);
    router.replace('/login');
  }

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.card}>
        {state === 'checking' || state === 'creating-profile' ? (
          <>
            <ActivityIndicator color="#a95820" size="large" />
            <Text style={styles.title}>{state === 'checking' ? 'Finishing your sign-in…' : 'Preparing your account…'}</Text>
            <Text style={styles.copy}>Keep this screen open for a moment.</Text>
          </>
        ) : null}

        {state === 'choose-role' ? (
          <>
            <Text style={styles.title}>How will you use BaristaMatch?</Text>
            <Text style={styles.copy}>Choose your account type to finish signing in.</Text>
            <Pressable onPress={() => chooseRole('barista')} style={styles.primary}>
              <Text style={styles.primaryText}>I am a barista</Text>
            </Pressable>
            <Pressable onPress={() => chooseRole('cafe_owner_manager')} style={styles.secondary}>
              <Text style={styles.secondaryText}>I manage a café</Text>
            </Pressable>
            <Pressable onPress={returnToLogin} style={styles.linkButton}>
              <Text style={styles.linkText}>Cancel</Text>
            </Pressable>
          </>
        ) : null}

        {state === 'error' ? (
          <>
            <Text style={styles.title}>This sign-in link could not be completed.</Text>
            <Text style={styles.copy}>The link may be expired or already used. Return to login and request a new link.</Text>
            <Pressable onPress={returnToLogin} style={styles.primary}>
              <Text style={styles.primaryText}>Return to login</Text>
            </Pressable>
          </>
        ) : null}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, justifyContent: 'center', padding: 24, backgroundColor: '#fff4e8' },
  card: { backgroundColor: '#fff', borderRadius: 24, padding: 28, alignItems: 'center', shadowColor: '#321708', shadowOpacity: 0.1, shadowRadius: 20, shadowOffset: { width: 0, height: 8 } },
  title: { marginTop: 18, color: '#321708', fontFamily: Platform.OS === 'ios' ? 'Georgia' : 'serif', fontSize: 27, fontWeight: '700', textAlign: 'center' },
  copy: { marginTop: 10, marginBottom: 12, color: '#746a61', fontSize: 15, lineHeight: 22, textAlign: 'center' },
  primary: { width: '100%', marginTop: 14, borderRadius: 10, paddingVertical: 15, alignItems: 'center', backgroundColor: '#a95820' },
  primaryText: { color: '#fff', fontSize: 16, fontWeight: '800' },
  secondary: { width: '100%', marginTop: 10, borderRadius: 10, paddingVertical: 15, alignItems: 'center', borderWidth: 1, borderColor: '#a95820', backgroundColor: '#fff8f2' },
  secondaryText: { color: '#7b3d16', fontSize: 16, fontWeight: '800' },
  linkButton: { marginTop: 12, padding: 10 },
  linkText: { color: '#746a61', fontSize: 15, fontWeight: '700' },
});
