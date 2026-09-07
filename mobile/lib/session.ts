import { supabase } from './supabase';
import { createMobileCallbackExchange } from './authCallback';
export type AppRole = 'barista' | 'cafe_owner_manager';

export function savedAppRole(value: unknown): AppRole | null {
  return value === 'barista' || value === 'cafe_owner_manager' ? value : null;
}

export async function requireCurrentUser(userId: string, client = supabase) {
  const { data, error } = await client.auth.getSession();
  if (error) throw error;
  if (data.session?.user.id !== userId) throw new Error('Your session changed. Reopen this screen before continuing.');
  return data.session.user;
}

export async function getCurrentContext(client = supabase) {
  const { data, error } = await client.auth.getSession();
  if (error) throw error;
  const user = data.session?.user ?? null;
  if (!user) return { user: null, profile: null, role: null as AppRole | null };
  const { data: profile, error: profileError } = await client.from('profiles').select('*').eq('id', user.id).maybeSingle();
  if (profileError) throw profileError;
  await requireCurrentUser(user.id, client);
  // A saved profile is authoritative. OAuth metadata never chooses an account role.
  return { user, profile, role: savedAppRole(profile?.role) };
}

export async function createExplicitProfile(userId: string, draft: {
  role: AppRole; display_name: string | null; cafe_name: string | null; location: string;
}, client = supabase) {
  const current = await getCurrentContext(client);
  if (current.user?.id !== userId) throw new Error('Your session changed. Please sign in again.');
  if (current.role) return current; // Retrying setup must never overwrite a saved account.
  if (current.profile) throw new Error('Your saved account type needs support. Please contact support@baristajobmatch.com.');
  const { error } = await client.from('profiles').insert({ ...draft, id: userId });
  if (error && error.code !== '23505') throw error;
  const saved = await getCurrentContext(client);
  if (saved.user?.id !== userId || !saved.role) throw new Error('Your profile could not be confirmed. Please try again.');
  return saved;
}

export const completeMobileAuth = createMobileCallbackExchange(async tokens => {
  const { data, error } = await supabase.auth.setSession(tokens);
  if (error || !data.user) throw new Error('The sign-in link could not be completed. Please try again.');
  return data.user;
});
