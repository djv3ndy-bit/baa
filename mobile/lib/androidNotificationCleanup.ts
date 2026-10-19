type Request = { identifier: string; content: { data?: unknown } };
type Response = { notification: { request: Request } };

function taggedRecipient(identifier: string): string | null {
  // Expo SDK54 preserves the native tag/id as this exact foreign-notification
  // identifier when Firebase auto-displayed a background notification. Never
  // infer ownership from its generic body, title, channel or default FCM tag.
  if (identifier.length > 256) return null;
  const foreign = /^expo-notifications:\/\/foreign_notifications\?tag=([^&]+)&id=0$/.exec(identifier);
  if (!foreign) return null;
  let tag: string;
  try { tag = decodeURIComponent(foreign[1]); } catch { return null; }
  const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
  return new RegExp(`^bjm-v1:(${uuid}):${uuid}$`).exec(tag)?.[1] || null;
}

export function androidNotificationRecipient(request: Request): string | null {
  const data = request.content.data;
  const fromData = data && typeof data === 'object' && 'recipientUserId' in data
    && typeof data.recipientUserId === 'string' ? data.recipientUserId : null;
  const fromTag = taggedRecipient(request.identifier);
  if (fromData && fromTag && fromData !== fromTag) return null;
  return fromData || fromTag;
}

/** Remove only alerts tagged to the departing Android account, never all alerts. */
export async function clearAndroidAccountNotifications(owner: string, deps: {
  scheduled: () => Promise<Request[]>;
  presented: () => Promise<{ request: Request }[]>;
  cancel: (identifier: string) => Promise<void>;
  dismiss: (identifier: string) => Promise<void>;
  lastResponse: () => Promise<Response | null>;
  clearLastResponse: () => Promise<void>;
  responseVersion: () => number;
  retire: (identifier: string) => void;
}) {
  const owned = (request: Request) => androidNotificationRecipient(request) === owner;
  async function removeOwned(list: () => Promise<Request[]>, remove: (identifier: string) => Promise<void>) {
    for (const request of await list()) {
      if (!owned(request)) continue;
      // A scheduled ID can be reused, or a tray item replaced, while native
      // enumeration is pending. Preserve an ID now belonging to another user.
      if (!(await list()).some(current => current.identifier === request.identifier && owned(current))) continue;
      deps.retire(request.identifier);
      await remove(request.identifier);
    }
  }
  async function clearResponse() {
    const version = deps.responseVersion();
    const response = await deps.lastResponse();
    if (response && owned(response.notification.request)) {
      deps.retire(response.notification.request.identifier);
      // Do not clear a newer response received while the native lookup waited.
      if (version !== deps.responseVersion()) return;
      const latest = await deps.lastResponse();
      if (version === deps.responseVersion() && latest && owned(latest.notification.request)
        && latest.notification.request.identifier === response.notification.request.identifier) await deps.clearLastResponse();
    }
  }
  // One unavailable native list must not prevent the other best-effort cleanup.
  // Surface failure afterward, so the controller retains its retry handle.
  const results = await Promise.allSettled([
    removeOwned(deps.scheduled, deps.cancel),
    removeOwned(async () => (await deps.presented()).map(item => item.request), deps.dismiss),
    clearResponse(),
  ]);
  for (const result of results) if (result.status === 'rejected') throw result.reason;
}
