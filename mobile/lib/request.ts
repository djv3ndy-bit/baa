/** Shared Supabase transport deadline so account/profile reads cannot spin forever. */
export async function fetchWithTimeout(input: RequestInfo | URL, options: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (options.signal?.aborted) abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(abort, 30000);
  try { return await fetch(input, { ...options, signal: controller.signal }); }
  finally { clearTimeout(timeout); options.signal?.removeEventListener('abort', abort); }
}

/** Bound every app API request, including reading its response body. */
export async function requestJson<T>(url: string, options: RequestInit, timeoutMs = 20000): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    if (response.status === 204) return undefined as T;
    const result = await response.json().catch((error: unknown) => {
      if (controller.signal.aborted) throw error;
      throw new Error('The server returned an unreadable response. Please try again.');
    }) as T & { error?: string };
    if (!response.ok) throw new Error(typeof result?.error === 'string' ? result.error : 'The request could not be completed. Please try again.');
    return result;
  } catch (error) {
    if (controller.signal.aborted) throw new Error('The request took too long. Check your connection and try again.');
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
