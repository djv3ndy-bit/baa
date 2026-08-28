import { supabase } from './supabase';

const API_BASE = 'https://www.baristajobmatch.com/api';

export async function authenticatedApi<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token) throw new Error('Your session expired. Please log in again.');

  const response = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${session.access_token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const result = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(result.error || 'The request could not be completed. Please try again.');
  return result;
}
