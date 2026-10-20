import { parseMobileAuthCallback } from './authCallback';

type Context = { user: { id: string } | null; role: 'barista' | 'cafe_owner_manager' | null };
type Failure = 'missing_callback' | 'provider_error' | 'missing_session' | 'exchange' | 'account' | 'session_changed' | 'navigation' | 'callback_changed' | 'timeout';
export type AndroidAuthCallbackState = { phase: 'working' | 'waiting_navigation' } | { phase: 'failed'; reason: Failure };
type Dependencies = {
  exchange(url: string): Promise<{ id: string }>;
  context(): Promise<Context>;
  assertCurrentUser(userId: string): Promise<unknown>;
  navigate(hasRole: boolean): void;
  changed(state: AndroidAuthCallbackState): void;
  delay(callback: () => void, milliseconds: number): () => void;
};

export function androidAuthCallbackMessage(state: AndroidAuthCallbackState): string {
  if (state.phase !== 'failed') return 'Keep this screen open for a moment.';
  switch (state.reason) {
    case 'missing_callback':
    case 'missing_session': return 'The sign-in link is incomplete. Return to login and start sign-in again.';
    case 'provider_error': return 'The sign-in link was rejected or has expired. Return to login and try again.';
    case 'session_changed': return 'Your signed-in account changed or could not be confirmed. Return to login before continuing.';
    case 'account': return 'Your account could not be loaded. Check your connection and try again.';
    case 'navigation': return 'Your account is ready, but this screen could not open it. Try again.';
    case 'callback_changed': return 'A different sign-in link arrived before this attempt finished. Return to login and start sign-in again.';
    case 'timeout': return 'Sign-in is taking too long. Check your connection and try again. If this continues, close and reopen BaristaMatch.';
    case 'exchange': return 'The sign-in could not be confirmed. Try again, or return to login for a new sign-in link.';
  }
}

export function androidAuthCallbackReference(state: AndroidAuthCallbackState): string | null {
  if (state.phase !== 'failed') return null;
  // Fixed support references identify the failed stage without provider text,
  // callback URLs, account identifiers or session credentials.
  return ({ missing_callback: 'A01', provider_error: 'A02', missing_session: 'A03', exchange: 'A04', account: 'A05', session_changed: 'A06', navigation: 'A07', callback_changed: 'A08', timeout: 'A09' } as const)[state.reason];
}

/** Android owns one accepted callback for the focused screen. Router parameter
 * updates never cancel that exchange. No saved-session fallback completes an
 * absent or invalid callback, and every navigation checks the exchanged user. */
export function createAndroidAuthCallback(deps: Dependencies) {
  let active = false, ready = false, generation = 0;
  let accepted: string | null = null;
  let acceptedSource: 'current' | 'initial' | null = null;
  let currentIntent = false;
  let blocked = false;
  let processing = false, navigating = false, navigated = false;
  let prepared: { userId: string; hasRole: boolean } | null = null;
  let cancelDelay: (() => void) | null = null;

  const current = (stamp: number) => active && stamp === generation;
  function stopDelay() { cancelDelay?.(); cancelDelay = null; }
  function fail(reason: Failure, stamp = generation) {
    if (!current(stamp)) return;
    stopDelay();
    prepared = null;
    deps.changed({ phase: 'failed', reason });
  }
  function waitForCallback() {
    stopDelay();
    const stamp = generation;
    cancelDelay = deps.delay(() => {
      if (current(stamp) && !accepted && !processing && !navigated) fail('missing_callback', stamp);
    }, 8000);
  }
  async function navigate() {
    if (!active || !ready || !prepared || navigating || navigated) return;
    const stamp = generation, intent = prepared;
    navigating = true;
    try {
      await deps.assertCurrentUser(intent.userId);
      if (!current(stamp) || prepared !== intent || navigated) return;
      if (!ready) { deps.changed({ phase: 'waiting_navigation' }); return; }
      try { deps.navigate(intent.hasRole); }
      catch { fail('navigation', stamp); return; }
      navigated = true;
      prepared = null;
      stopDelay();
    } catch { fail('session_changed', stamp); }
    finally { if (current(stamp)) navigating = false; }
  }
  async function process(url: string) {
    const stamp = generation;
    processing = true;
    stopDelay();
    // Bound the entire accepted attempt, including Auth response bodies,
    // storage locks, profile loading and waiting for the navigator. Transport
    // header deadlines alone cannot bound every one of those operations.
    cancelDelay = deps.delay(() => {
      if (!current(stamp) || navigated) return;
      generation++; processing = false; navigating = false;
      fail('timeout');
    }, 60000);
    deps.changed({ phase: 'working' });
    let user: { id: string };
    try { user = await deps.exchange(url); }
    catch { if (current(stamp)) processing = false; fail('exchange', stamp); return; }
    if (!current(stamp)) return;
    let context: Context;
    try { context = await deps.context(); }
    catch { if (current(stamp)) processing = false; fail('account', stamp); return; }
    if (!current(stamp)) return;
    processing = false;
    if (!user.id || context.user?.id !== user.id) { fail('session_changed', stamp); return; }
    prepared = { userId: user.id, hasRole: context.role !== null };
    if (!ready) deps.changed({ phase: 'waiting_navigation' });
    void navigate();
  }
  function receive(url: string | null, source: 'current' | 'initial' = 'current') {
    if (!active || !url || navigated || blocked) return;
    if (source === 'initial' && currentIntent) return;
    const parsed = parseMobileAuthCallback(url);
    // A current rejected/incomplete callback still outranks a stale cold-start
    // URL. A new live callback may recover it; an initial URL may not.
    if ((parsed.ok || parsed.reason !== 'invalid_callback') && source === 'current') {
      currentIntent = true;
      if (accepted && acceptedSource === 'initial') {
        const previous = parseMobileAuthCallback(accepted);
        if (parsed.ok && previous.ok && parsed.accessToken === previous.accessToken && parsed.refreshToken === previous.refreshToken) acceptedSource = 'current';
        else {
          // Initial URLs can be stale on a warm Android process. If the actual
          // current intent disagrees, never route the old user or concurrently
          // exchange another account. Require a fresh explicit sign-in instead.
          generation++; processing = false; navigating = false; prepared = null;
          accepted = null; acceptedSource = null; blocked = true;
          fail('callback_changed');
          return;
        }
      }
    }
    // A stale initial URL or parameter update cannot replace an accepted flow.
    if (accepted) return;
    if (!parsed.ok) {
      if (parsed.reason !== 'invalid_callback') fail(parsed.reason);
      return;
    }
    accepted = url;
    acceptedSource = source;
    void process(url);
  }
  function activate() {
    if (active) return;
    active = true; generation++; currentIntent = false; blocked = false;
    processing = false; navigating = false; navigated = false; prepared = null;
    deps.changed({ phase: 'working' });
    waitForCallback();
  }
  function deactivate() {
    active = false; generation++;
    processing = false; navigating = false; prepared = null; accepted = null; acceptedSource = null; currentIntent = false; blocked = false;
    stopDelay();
  }
  function setNavigationReady(value: boolean) {
    ready = value;
    if (ready) void navigate();
  }
  function retry() {
    if (!active || processing || navigating || navigated || blocked) return;
    prepared = null;
    if (accepted) void process(accepted);
    else { deps.changed({ phase: 'working' }); waitForCallback(); }
  }
  return { activate, deactivate, receive, setNavigationReady, retry };
}
