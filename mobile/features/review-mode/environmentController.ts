export type AppEnvironment = Readonly<{
  review: boolean;
  supabaseUrl: string;
  publishableKey: string;
  apiBase: string;
}>;

type Storage = {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
};
export const REVIEW_MODE_KEY = 'baristamatch_review_mode_v1';

/** A process keeps one immutable environment. Switching takes effect only after a reload. */
export function createEnvironmentController(storage: Storage, configured: AppEnvironment, review: AppEnvironment, timeoutMs = 5000) {
  let current: AppEnvironment | undefined;
  let opening: Promise<AppEnvironment> | undefined;
  let switching = false;
  let restartRequired = false;

  async function bounded<T>(work: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout>;
    try {
      return await Promise.race([work, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('The saved app mode could not be confirmed. Please try again.')), timeoutMs);
      })]);
    } finally { clearTimeout(timer!); }
  }

  function get() {
    if (!current) throw new Error('Your app session is still opening. Please try again.');
    return current;
  }

  function initialize(): Promise<AppEnvironment> {
    if (current) return Promise.resolve(current);
    if (!opening) {
      opening = (async () => {
        const saved = await bounded(storage.getItem(REVIEW_MODE_KEY));
        if (saved !== null && saved !== 'review' && saved !== 'configured') {
          throw new Error('Your saved app mode could not be read. Please contact support.');
        }
        const selected = saved === 'review' ? review : configured;
        if (!selected.supabaseUrl || !selected.publishableKey || !selected.apiBase) {
          throw new Error('The app connection is not configured. Please contact support.');
        }
        current = Object.freeze({ ...selected });
        return current;
      })().catch(error => { opening = undefined; throw error; });
    }
    return opening;
  }

  async function switchMode(target: 'review' | 'configured', signedOut: () => Promise<boolean>, reload: () => Promise<void>) {
    const active = get();
    if (switching || restartRequired) throw new Error('The app is already restarting. Close and reopen it to continue.');
    if (target === 'configured' && configured.review) throw new Error('This test build has no live account connection.');
    if ((target === 'review') === active.review) return;
    switching = true;
    try {
      if (!await bounded(signedOut())) throw new Error('Sign out in Settings before changing app mode.');
      await bounded(storage.setItem(REVIEW_MODE_KEY, target));
      restartRequired = true;
      await reload();
    } finally { switching = false; }
  }

  return { initialize, get, switchMode, canReturnToLive: () => !configured.review, restartRequired: () => restartRequired };
}
