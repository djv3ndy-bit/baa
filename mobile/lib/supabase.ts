import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient, processLock } from '@supabase/supabase-js';
import { AppState, Platform } from 'react-native';
import { fetchWithTimeout } from './request';
import { createLockedAuthStorage } from './authStorage';
import { initializeAppEnvironment } from '../features/review-mode/environment';

export let AUTH_API_BASE: string;
export let SUPABASE_PUBLIC_KEY: string;
export let AUTH_STORAGE_KEY: string;
export let APP_API_BASE: string;
export let supabase: ReturnType<typeof createAppClient>;
const authStorage = createLockedAuthStorage(AsyncStorage);
export const withAuthStorageLock = authStorage.runExclusive;
let initialization: Promise<void> | undefined;

/** Root startup waits for the saved mode before creating any account client. */
export function initializeSupabaseEnvironment(): Promise<void> {
  if (!initialization) {
    initialization = initializeAppEnvironment().then(environment => {
      const supabaseUrl = environment.supabaseUrl;
      const supabaseKey = environment.publishableKey;
      AUTH_API_BASE = `${supabaseUrl.replace(/\/$/, '')}/auth/v1`;
      SUPABASE_PUBLIC_KEY = supabaseKey;
      APP_API_BASE = environment.apiBase;
      // Preserve Supabase's existing project-specific key, including deletion cleanup.
      AUTH_STORAGE_KEY = `sb-${new URL(supabaseUrl).hostname.split('.')[0]}-auth-token`;
      supabase = createAppClient(supabaseUrl, supabaseKey);
      if (Platform.OS !== 'web') {
        AppState.addEventListener('change', (state) => {
          if (state === 'active') supabase.auth.startAutoRefresh();
          else supabase.auth.stopAutoRefresh();
        });
      }
    }).catch(error => { initialization = undefined; throw error; });
  }
  return initialization;
}

function createAppClient(supabaseUrl: string, supabaseKey: string) {
  return createClient(supabaseUrl, supabaseKey, {
    global: { fetch: fetchWithTimeout },
    auth: {
      lock: processLock,
      storage: authStorage.storage,
      storageKey: AUTH_STORAGE_KEY,
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: false,
    },
  });
}
