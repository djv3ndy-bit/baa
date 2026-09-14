/** A stalled store read must not leave subscription controls spinning forever.
 * Timing out never means a purchase was canceled or access should be removed. */
export async function storeResponse<T>(request: Promise<T>, timeoutMs = 20_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([request, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('The store did not respond. Please try again.')), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}
