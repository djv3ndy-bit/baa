/** No tokens or personal account fields belong in this short-lived UI receipt. */
export type DeletionResponse = { success?: boolean; appleRevocation?: string };
export type DeletionReceipt = { appleDisconnectRequired: boolean; localSignOutComplete: boolean; createdAt: number };
export const APPLE_DISCONNECT_HELP = 'https://support.apple.com/en-us/102571';
let receipt: DeletionReceipt | null = null;

export function getDeletionReceipt(): DeletionReceipt | null {
  return receipt && Date.now() - receipt.createdAt >= 0 && Date.now() - receipt.createdAt < 30 * 60 * 1000 ? { ...receipt } : null;
}
export function clearDeletionReceipt() { receipt = null; }

export async function finishAccountDeletion(
  request: () => Promise<DeletionResponse>,
  clearSession: () => Promise<boolean>,
): Promise<DeletionReceipt> {
  const result = await request();
  if (result?.success !== true) throw new Error('Account deletion was not confirmed. Please try again.');
  // After confirmed server deletion, a local cleanup failure must not be reported
  // as a failed deletion or trigger another destructive request.
  let localSignOutComplete = false;
  try { localSignOutComplete = await clearSession() === true; } catch { /* Show the separate cleanup warning. */ }
  receipt = {
    appleDisconnectRequired: result.appleRevocation === 'manual_required',
    localSignOutComplete,
    createdAt: Date.now(),
  };
  return { ...receipt };
}

export async function clearDeletedSession(
  auth: {
    getSession: () => Promise<{ data: { session: { user: { id: string } } | null } }>;
    stopAutoRefresh: () => void | Promise<void>;
    startAutoRefresh?: () => void | Promise<void>;
  },
  storage: { getItem: (key: string) => Promise<string | null>; multiRemove: (keys: string[]) => Promise<void> },
  storageKey: string,
  deletedUserId: string,
  withStorageLock: <T>(operation: () => Promise<T>) => Promise<T>,
): Promise<boolean> {
  const { data } = await auth.getSession();
  // A different account may have signed in in another window while deletion ran.
  if (data.session && data.session.user.id !== deletedUserId) return false;
  await auth.stopAutoRefresh();
  let cleared = false;
  try {
    // Share the SDK storage adapter's lock, including password sign-in writes.
    // Never call a current-session signOut while an account switch can occur.
    cleared = await withStorageLock(async () => {
      const raw = await storage.getItem(storageKey);
      if (raw && JSON.parse(raw)?.user?.id !== deletedUserId) return false;
      await storage.multiRemove([storageKey, `${storageKey}-code-verifier`, `${storageKey}-user`]);
      return true;
    });
    return cleared;
  } finally {
    // A new sign-in may have queued a session write after our atomic removal.
    // Restore normal refresh; an empty auth store makes no remote request.
    await auth.startAutoRefresh?.();
  }
}
