import { Platform } from 'react-native';
import { androidAuthCallbackHandoff } from '@/lib/androidAuthCallbackHandoff';

// Router 6 discovers this exact filename, before custom-scheme path extraction.
// iOS keeps the original URL and never reads or writes the Android handoff.
export function redirectSystemPath({ path, initial }: { path: string; initial: boolean }): string {
  if (Platform.OS !== 'android') return path;
  try { return androidAuthCallbackHandoff.redirect(path, initial); }
  catch { androidAuthCallbackHandoff.clear(); return '/auth/callback?androidAuthHandoff=invalid'; }
}
