import type { AppEnvironment } from '../features/review-mode/environmentController';

export const ANDROID_FCM_TOKEN_KEY = 'baristamatch_android_fcm_token_v1';
export type AndroidFcmOutcome = { status: 'enabled' | 'denied' | 'no-session'; canAskAgain?: boolean };
type NativeToken = { type: string; data: unknown };
type Permission = { granted: boolean; canAskAgain: boolean };
type SavedToken = { token: string; userId: string };

/** A bad explicitly enabled test configuration must never fall back to Expo. */
export function isolatedAndroidFcmEnabled(platform: string, flag: string | undefined, environment: AppEnvironment, expectedKey: string) {
  if (platform !== 'android' || flag !== 'true') return false;
  if (!environment.review || environment.apiBase !== 'https://android-testing.baristajobmatch.com/api'
    || environment.supabaseUrl !== 'https://ojvjlvojvozvhktbclcg.supabase.co'
    || !/^sb_publishable_[A-Za-z0-9_-]+$/.test(expectedKey)
    || expectedKey === 'sb_publishable_470rDNz5G4PrUD5mvMu4Eg_LPcLOM4x'
    || environment.publishableKey !== expectedKey) throw new Error('Android notifications require the isolated test build.');
  return true;
}

function nativeToken(value: NativeToken): string {
  if (value.type !== 'android' || typeof value.data !== 'string' || value.data.length < 1
    || value.data.length > 2048 || /[\s\u0000-\u001f\u007f-\u009f]/u.test(value.data)
    || /^Expo(nent)?PushToken/.test(value.data)) throw new Error('An Android notification token is unavailable.');
  try {
    if (encodeURIComponent(value.data).replace(/%[a-f0-9]{2}/gi, 'x').length > 2048) throw new Error();
  } catch { throw new Error('An Android notification token is unavailable.'); }
  return value.data;
}

export function createAndroidFcmRegistration(deps: {
  requireEnabled: () => boolean;
  userId: () => Promise<string | null>;
  storage: { getItem(key: string): Promise<string | null>; setItem(key: string, value: string): Promise<void>; removeItem(key: string): Promise<void> };
  channel: () => Promise<unknown>;
  permissions: () => Promise<Permission>;
  requestPermission: () => Promise<Permission>;
  token: () => Promise<NativeToken>;
  invalidateNativeToken: () => Promise<void>;
  save: (token: string, userId: string) => Promise<void>;
  remove: (token: string, userId: string) => Promise<void>;
  tokenListener: (callback: (token: NativeToken) => void) => () => void;
  authListener: (callback: (userId: string | null) => void) => () => void;
}) {
  let tail: Promise<unknown> = Promise.resolve(), generation = 0, activeUser: string | null = null;
  let knownUser: string | null | undefined, closing = false, resetRequired = false;
  const enqueue = <T,>(work: () => Promise<T>): Promise<T> => {
    const pending = tail.then(work, work);
    tail = pending.catch(() => {});
    return pending;
  };
  const current = async (userId: string, stamp: number) => stamp === generation && await deps.userId() === userId && stamp === generation;
  const saved = async (): Promise<SavedToken | null> => {
    const raw = await deps.storage.getItem(ANDROID_FCM_TOKEN_KEY);
    if (raw === null) return null;
    try {
      const value = JSON.parse(raw);
      if (!value || typeof value.userId !== 'string' || !value.userId) throw new Error();
      return { userId: value.userId, token: nativeToken({ type: 'android', data: value.token }) };
    } catch { resetRequired = true; return null; }
  };
  const resetNative = async () => {
    resetRequired = true;
    // Expo's Android implementation calls FirebaseMessaging.deleteToken(). The
    // old server row may outlive this session, but its token must stop delivery.
    await deps.invalidateNativeToken();
    await deps.storage.removeItem(ANDROID_FCM_TOKEN_KEY);
    resetRequired = false;
  };
  const lostAccount = async (userId: string): Promise<AndroidFcmOutcome> => {
    if (resetRequired || await deps.userId() !== userId) await resetNative();
    return { status: 'no-session' };
  };

  function register(requestPermission = false, refreshed?: NativeToken, expectedUser?: string): Promise<AndroidFcmOutcome> {
    const stamp = generation;
    return enqueue(async () => {
      if (!deps.requireEnabled()) throw new Error('Android notifications require the isolated test build.');
      if (closing || stamp !== generation) return { status: 'no-session' };
      const userId = await deps.userId();
      if (!userId) {
        // An expired/signed-out cold start can still own a native token even
        // when local storage was lost. Invalidate delivery without row access.
        if (await deps.userId() === null) await resetNative();
        return { status: 'no-session' };
      }
      if (expectedUser && expectedUser !== userId) return { status: 'no-session' };
      let previous: SavedToken | null;
      try { previous = await saved(); }
      catch (error) {
        // Unreadable storage cannot prove this native token belongs to the
        // signed-in account. Stop delivery rather than leave an old owner live.
        await resetNative();
        throw error;
      }
      if (resetRequired || (previous && previous.userId !== userId)) {
        await resetNative(); previous = null;
        if (refreshed) return { status: 'no-session' };
      }
      await deps.channel();
      let permission = await deps.permissions();
      if (!permission.granted && requestPermission && permission.canAskAgain) permission = await deps.requestPermission();
      if (!permission.granted) return { status: 'denied', canAskAgain: permission.canAskAgain };
      // A refresh callback supplies its token directly; fetching here would loop.
      const token = nativeToken(refreshed || await deps.token());
      if (!await current(userId, stamp)) return lostAccount(userId);
      if (previous?.userId === userId && previous.token !== token) {
        await deps.remove(previous.token, userId);
        if (!await current(userId, stamp)) return lostAccount(userId);
      }
      // Keep a cleanup handle before issuing a write whose response may fail.
      // Failed registration or deletion never silently discards a live token.
      try { await deps.storage.setItem(ANDROID_FCM_TOKEN_KEY, JSON.stringify({ token, userId })); }
      catch (error) {
        // Storage loss cannot leave a previous account's native token active.
        // No database write has been issued; resetRequired survives any failure.
        await resetNative();
        throw error;
      }
      if (!await current(userId, stamp)) return lostAccount(userId);
      try { await deps.save(token, userId); }
      catch (error) {
        // A restored/missing cache can hide a previous owner's server row.
        // Never transfer that row or leave its native token delivering alerts.
        // The saved handle survives if native invalidation itself fails.
        await resetNative();
        throw error;
      }
      if (!await current(userId, stamp)) return lostAccount(userId);
      activeUser = userId;
      return { status: 'enabled' };
    });
  }

  async function unregister(expectedUserId?: string) {
    // Invalidate unfinished reads and refresh callbacks before waiting for writes.
    generation++; activeUser = null; closing = true;
    try {
      await enqueue(async () => {
        if (!deps.requireEnabled()) throw new Error('Android notifications require the isolated test build.');
        const userId = await deps.userId();
        if (!userId) {
          if (await deps.userId() === null) await resetNative();
          return;
        }
        if (expectedUserId && userId !== expectedUserId) throw new Error('Your account changed. Open settings again before signing out.');
        const previous = await saved(), tokens = new Set<string>();
        if (resetRequired) { await resetNative(); return; }
        if (previous && previous.userId !== userId) { await resetNative(); return; }
        if (previous?.userId === userId) tokens.add(previous.token);
        if ((await deps.permissions()).granted) tokens.add(nativeToken(await deps.token()));
        for (const token of tokens) {
          if (await deps.userId() !== userId) throw new Error('Your account changed. Open settings again before signing out.');
          await deps.remove(token, userId);
        }
        if (await deps.userId() !== userId) throw new Error('Your account changed. Open settings again before signing out.');
        await resetNative();
      });
    } finally { closing = false; }
  }

  function confirmedDeletion(expectedUserId: string) {
    // Called only after the server confirms this account's deletion. Its FK
    // already removed owned rows; an absent Auth session is expected here.
    return enqueue(async () => {
      if (!deps.requireEnabled()) throw new Error('Android notifications require the isolated test build.');
      const userId = await deps.userId();
      if (userId && userId !== expectedUserId) return;
      const previous = await saved();
      if (previous && previous.userId !== expectedUserId) return;
      const latest = await deps.userId();
      if (latest && latest !== expectedUserId) return;
      // A skipped deletion must preserve a newly signed-in user's listener and
      // queued work. Only the confirmed owner's cleanup invalidates callbacks.
      generation++; activeUser = null; closing = true;
      try { await resetNative(); }
      finally { closing = false; }
    });
  }

  function listen() {
    if (!deps.requireEnabled()) return () => {};
    let live = true;
    const stopToken = deps.tokenListener(token => {
      const userId = activeUser;
      if (live && userId && !closing) void register(false, token, userId).catch(() => {});
    });
    const stopAuth = deps.authListener(userId => {
      if (knownUser === undefined) {
        knownUser = userId;
        if (userId === null) {
          const stamp = generation;
          void enqueue(async () => {
            if (!live || stamp !== generation || await deps.userId() !== null) return;
            if (await deps.userId() === null) await resetNative();
          }).catch(() => {});
        }
        return;
      }
      if (userId !== knownUser) {
        const hadUser = knownUser !== null;
        knownUser = userId; generation++; activeUser = null;
        if (hadUser) {
          resetRequired = true;
          void enqueue(resetNative).catch(() => {});
        }
      }
    });
    return () => { live = false; generation++; activeUser = null; stopToken(); stopAuth(); };
  }
  return { register, unregister, confirmedDeletion, listen };
}
