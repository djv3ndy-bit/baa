import { AUTH_API_BASE, SUPABASE_PUBLIC_KEY, supabase } from './supabase';
import { requestJson } from './request';

const API_BASE = (process.env.EXPO_PUBLIC_API_BASE_URL || 'https://www.baristajobmatch.com/api').replace(/\/$/, '');

export async function requireAccountSession(expectedUserId?: string) {
  const { data: { session }, error } = await supabase.auth.getSession();
  if (error) throw error;
  if (!session?.access_token) throw new Error('Your session expired. Please log in again.');
  if (expectedUserId && session.user.id !== expectedUserId) throw new Error('The signed-in account changed. Please review the request again.');
  return session;
}

export async function authenticatedApi<T>(path: string, body: Record<string, unknown>, method: 'GET'|'POST' = 'POST', expectedUserId?: string): Promise<T> {
  const session = await requireAccountSession(expectedUserId);
  return requestJson<T>(`${API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${session.access_token}`,
      'Content-Type': 'application/json',
    },
    ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
  });
}

/** Password changes must use the account the user reviewed, even if auth switches. */
export async function updateAccountPassword(expectedUserId: string, password: string) {
  const session = await requireAccountSession(expectedUserId);
  return requestJson(`${AUTH_API_BASE}/user`, {
    method: 'PUT',
    headers: { apikey: SUPABASE_PUBLIC_KEY, Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  });
}
