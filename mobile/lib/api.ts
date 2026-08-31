import { supabase } from './supabase';

const API_BASE = (process.env.EXPO_PUBLIC_API_BASE_URL || 'https://www.baristajobmatch.com/api').replace(/\/$/, '');

export async function authenticatedApi<T>(path: string, body: Record<string, unknown>, method: 'GET'|'POST' = 'POST'): Promise<T> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token) throw new Error('Your session expired. Please log in again.');

  const response = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${session.access_token}`,
      'Content-Type': 'application/json',
    },
    ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
  });
  const result = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(result.error || 'The request could not be completed. Please try again.');
  return result;
}
