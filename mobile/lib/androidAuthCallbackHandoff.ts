import { MOBILE_AUTH_CALLBACK_PREFIX, parseMobileAuthCallback } from './authCallback';

export const ANDROID_AUTH_HANDOFF_PARAM = 'androidAuthHandoff';
const ROUTE = '/auth/callback';
const INVALID_ROUTE = `${ROUTE}?${ANDROID_AUTH_HANDOFF_PARAM}=invalid`;
const TTL = 60_000;
const MAX_URL_LENGTH = 16_384;
type Delivery = { url: string; source: 'initial' | 'current' };
type Clock = { now(): number; delay(callback: () => void, milliseconds: number): () => void };

/** One volatile native-intent handoff, not an authentication or saved-session fallback.
 * Only the raw canonical URI creates a slot. A URL containing our nonsecret route
 * reference is rejected at intake, so an external reference cannot recover it. */
export function createAndroidAuthCallbackHandoff(clock: Clock) {
  let serial = 0;
  // Noncredential provenance survives consumption; a late initial URL must not
  // start an old account flow after the current callback has already finished.
  let latestCurrentRef: string | null = null;
  let pending: { ref: string; expires: number; delivery: Delivery } | null = null;
  let cancelExpiry: (() => void) | null = null;
  function clear(ref?: string) {
    if (ref !== undefined && pending?.ref !== ref) return;
    cancelExpiry?.(); cancelExpiry = null; pending = null;
  }
  function redirect(path: string, initial: boolean): string {
    const canonical = path === MOBILE_AUTH_CALLBACK_PREFIX || path.startsWith(`${MOBILE_AUTH_CALLBACK_PREFIX}?`) || path.startsWith(`${MOBILE_AUTH_CALLBACK_PREFIX}#`);
    let callbackRoute = path === ROUTE || path.startsWith(`${ROUTE}?`) || path.startsWith(`${ROUTE}#`) || path === 'auth/callback' || path.startsWith('auth/callback?');
    try {
      const url = new URL(path, 'https://native-intent.invalid');
      const normalize = (value: string) => value.replace(/\/+/g, '/').replace(/^\/|\/$/g, '');
      callbackRoute ||= normalize(url.pathname) === 'auth/callback' || normalize(url.host + url.pathname) === 'auth/callback';
    } catch { /* Malformed unrelated URLs never create a handoff. */ }
    // Reserve this key before every passthrough/provenance branch. Router can
    // decode query data in three stages (URLSearchParams, extracted values,
    // route URLSearchParams), including aliases or encoded value delimiters.
    let scan = path;
    for (let pass = 0; pass <= 3; pass++) {
      // WHATWG URL parsing removes ASCII tabs/newlines before decoding.
      scan = scan.replace(/[\t\n\r]/g, '');
      if (/(?:^|[?&#;])androidAuthHandoff(?:=|[&#;]|$)/.test(scan)) {
        clear();
        if (!initial) latestCurrentRef = 'invalid';
        return INVALID_ROUTE;
      }
      scan = scan.replace(/%([0-9a-f]{2})/gi, (_, byte: string) => String.fromCharCode(Number.parseInt(byte, 16)));
    }
    // Provenance fences apply to auth input only. An unrelated initial link
    // keeps its route and cannot consume or erase a pending current callback.
    if (initial && !canonical && !callbackRoute) return path;
    // A delayed cold-start callback cannot replace the current warm intent.
    if (initial && latestCurrentRef !== null) return `${ROUTE}?${ANDROID_AUTH_HANDOFF_PARAM}=${latestCurrentRef}`;
    if (canonical && pending?.delivery.url === path && clock.now() < pending.expires) {
      if (!initial) { pending.delivery.source = 'current'; latestCurrentRef = pending.ref; }
      return `${ROUTE}?${ANDROID_AUTH_HANDOFF_PARAM}=${pending.ref}`;
    }
    // Every new native intent supersedes an unconsumed slot. Never use an old
    // bearer for an unrelated link or an externally supplied handoff reference.
    clear();
    if (!canonical) {
      if (callbackRoute && !initial) latestCurrentRef = 'invalid';
      return callbackRoute ? INVALID_ROUTE : path;
    }
    if (!initial) latestCurrentRef = 'invalid';
    if (path.length > MAX_URL_LENGTH || /[\u0000-\u0020\u007f]/.test(path)) return INVALID_ROUTE;
    const query = path.indexOf('?');
    const hash = path.indexOf('#');
    const parameters = new URLSearchParams(path.slice(hash >= 0 ? hash + 1 : query >= 0 ? query + 1 : path.length));
    // A separate PKCE route may own code-only links. Preserve that existing
    // protocol verbatim; this handoff never exchanges a code or accepts it as tokens.
    const parsed = parseMobileAuthCallback(path);
    if (!parsed.ok && parsed.reason === 'missing_session' && parameters.has('code')) return path;
    const ref = `a${(++serial).toString(36)}`;
    if (!initial) latestCurrentRef = ref;
    pending = { ref, expires: clock.now() + TTL, delivery: { url: path, source: initial ? 'initial' : 'current' } };
    cancelExpiry = clock.delay(() => clear(ref), TTL);
    return `${ROUTE}?${ANDROID_AUTH_HANDOFF_PARAM}=${ref}`;
  }
  function take(ref: string): Delivery | null {
    if (!pending || pending.ref !== ref) return null;
    const value = pending;
    clear(ref);
    return clock.now() < value.expires ? value.delivery : null;
  }
  return { redirect, take, clear };
}

export const androidAuthCallbackHandoff = createAndroidAuthCallbackHandoff({
  now: () => Date.now(),
  delay(callback, milliseconds) { const timer = setTimeout(callback, milliseconds); return () => clearTimeout(timer); },
});
