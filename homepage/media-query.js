/** Observe preference changes on modern browsers and older Safari. */
export function listenMediaQuery(query, handler) {
  if (typeof query?.addEventListener === 'function') {
    query.addEventListener('change', handler);
    return () => query.removeEventListener?.('change', handler);
  }
  if (typeof query?.addListener === 'function') {
    query.addListener(handler);
    return () => query.removeListener?.(handler);
  }
  // The initial .matches value still applies when change events are unavailable.
  return () => {};
}
