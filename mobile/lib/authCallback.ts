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
