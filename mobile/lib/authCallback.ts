export const MOBILE_AUTH_CALLBACK_PREFIX = 'baristamatch://auth/callback';
export const MOBILE_AUTH_WEB_BRIDGE = 'https://www.baristajobmatch.com/mobile-auth-callback.html';

export type MobileAuthCallbackResult =
  | {
      ok: true;
      accessToken: string;
      refreshToken: string;
    }
  | {
      ok: false;
      reason: 'invalid_callback' | 'provider_error' | 'missing_session';
    };

function isCanonicalCallback(url: string) {
  return (
    url === MOBILE_AUTH_CALLBACK_PREFIX ||
    url.startsWith(`${MOBILE_AUTH_CALLBACK_PREFIX}?`) ||
    url.startsWith(`${MOBILE_AUTH_CALLBACK_PREFIX}#`)
  );
}

function callbackParameters(url: string) {
  const hashIndex = url.indexOf('#');
  if (hashIndex >= 0) return new URLSearchParams(url.slice(hashIndex + 1));

  const queryIndex = url.indexOf('?');
  return new URLSearchParams(queryIndex >= 0 ? url.slice(queryIndex + 1) : '');
}

/**
 * Parse only the registered BaristaMatch callback URL.
 *
 * Raw provider messages and tokens must never be logged or shown to the user.
 */
export function parseMobileAuthCallback(url: string | null): MobileAuthCallbackResult {
  if (!url || !isCanonicalCallback(url)) {
    return { ok: false, reason: 'invalid_callback' };
  }

  const params = callbackParameters(url);
  if (params.get('error') || params.get('error_code') || params.get('error_description')) {
    return { ok: false, reason: 'provider_error' };
  }

  const accessToken = params.get('access_token');
  const refreshToken = params.get('refresh_token');
  if (!accessToken || !refreshToken) {
    return { ok: false, reason: 'missing_session' };
  }

  return { ok: true, accessToken, refreshToken };
}

// Expo can deliver the same callback to both the browser result and the deep-link
// route. Share the in-flight exchange so a one-use refresh token is not replayed.
export function createMobileCallbackExchange<T>(exchange: (tokens: { access_token: string; refresh_token: string }) => Promise<T>) {
  let pending: { token: string; promise: Promise<T> } | null = null;
  let completed: { token: string; result: T } | null = null;
  return (url: string | null): Promise<T> => {
    const parsed = parseMobileAuthCallback(url);
    if (!parsed.ok) return Promise.reject(new Error('The sign-in link is incomplete or expired. Please try again.'));
    if (pending) return pending.token === parsed.accessToken ? pending.promise : Promise.reject(new Error('Another sign-in is finishing. Please try again.'));
    if (completed?.token === parsed.accessToken) return Promise.resolve(completed.result);
    const promise = exchange({ access_token: parsed.accessToken, refresh_token: parsed.refreshToken }).then(result => {
      completed = { token: parsed.accessToken, result };
      return result;
    }).finally(() => { pending = null; });
    pending = { token: parsed.accessToken, promise };
    return promise;
  };
}

// Expo Router preserves URL fragments under the '#' search parameter. Reading
// the current route also handles warm email links delivered before this screen mounts.
export function mobileCallbackUrlFromParams(params: Record<string, unknown>): string | null {
  if (typeof params['#'] === 'string' && params['#']) return `${MOBILE_AUTH_CALLBACK_PREFIX}#${params['#']}`;
  if (params.error || params.error_code || params.error_description) return `${MOBILE_AUTH_CALLBACK_PREFIX}?error=provider_error`;
  if (typeof params.access_token !== 'string' || typeof params.refresh_token !== 'string') return null;
  return `${MOBILE_AUTH_CALLBACK_PREFIX}?${new URLSearchParams({ access_token: params.access_token, refresh_token: params.refresh_token })}`;
}
