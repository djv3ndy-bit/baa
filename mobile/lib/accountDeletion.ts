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
    signOut: (options: { scope: 'local' }) => Promise<unknown>;
  },
  storage: { multiRemove: (keys: string[]) => Promise<void> },
  storageKey: string,
  deletedUserId: string,
): Promise<boolean> {
  const { data } = await auth.getSession();
  // A different account may have signed in in another window while deletion ran.
  if (data.session && data.session.user.id !== deletedUserId) return false;
  await auth.stopAutoRefresh();
  try { await auth.signOut({ scope: 'local' }); } catch { /* The deleted user may already be unauthorized. */ }
  // Supabase's local signOut can return a network error before clearing storage.
  // Clear only this project's auth keys, never other application preferences.
  await storage.multiRemove([storageKey, `${storageKey}-code-verifier`, `${storageKey}-user`]);
  return true;
}
