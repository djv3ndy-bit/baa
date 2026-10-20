type Request = { identifier: string; content: { data?: unknown } };
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

function notificationRequest(value: unknown): Request | null {
  try {
    if (!record(value) || typeof value.identifier !== 'string' || !value.identifier || !record(value.content)) return null;
    return value as Request;
  } catch { return null; }
}

/** A partial native history record cannot establish Android notification ownership. */
export function androidNotificationRequestFromResponse(value: unknown): Request | null {
  try { return record(value) && record(value.notification) ? notificationRequest(value.notification.request) : null; }
  catch { return null; }
}

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

export function androidNotificationRecipient(value: unknown): string | null {
  const request = notificationRequest(value);
  if (!request) return null;
  try {
    const data = request.content.data;
    const fromData = record(data) && typeof data.recipientUserId === 'string' ? data.recipientUserId : null;
    const fromTag = taggedRecipient(request.identifier);
    if (fromData && fromTag && fromData !== fromTag) return null;
    return fromData || fromTag;
  } catch { return null; }
}

/** Remove only alerts tagged to the departing Android account, never all alerts. */
export async function clearAndroidAccountNotifications(owner: string, deps: {
  scheduled: () => Promise<unknown[]>;
  presented: () => Promise<unknown[]>;
  cancel: (identifier: string) => Promise<void>;
  dismiss: (identifier: string) => Promise<void>;
  lastResponse: () => Promise<unknown>;
  clearLastResponse: () => Promise<void>;
  responseVersion: () => number;
  retire: (identifier: string) => void;
}) {
  const owned = (request: unknown): request is Request => androidNotificationRecipient(request) === owner;
  async function removeOwned(list: () => Promise<unknown[]>, remove: (identifier: string) => Promise<void>) {
    for (const request of await list()) {
      if (!owned(request)) continue;
      // A scheduled ID can be reused, or a tray item replaced, while native
      // enumeration is pending. Preserve an ID now belonging to another user.
      if (!(await list()).some(current => owned(current) && current.identifier === request.identifier)) continue;
      deps.retire(request.identifier);
      await remove(request.identifier);
    }
  }
  async function clearResponse() {
    const version = deps.responseVersion();
    const request = androidNotificationRequestFromResponse(await deps.lastResponse());
    if (request && owned(request)) {
      deps.retire(request.identifier);
      // Do not clear a newer response received while the native lookup waited.
      if (version !== deps.responseVersion()) return;
      const latest = androidNotificationRequestFromResponse(await deps.lastResponse());
      if (version === deps.responseVersion() && latest && owned(latest)
        && latest.identifier === request.identifier) await deps.clearLastResponse();
    }
  }
  // One unavailable native list must not prevent the other best-effort cleanup.
  // Surface failure afterward, so the controller retains its retry handle.
  const results = await Promise.allSettled([
    removeOwned(deps.scheduled, deps.cancel),
    removeOwned(async () => (await deps.presented()).map(item => record(item) ? item.request : null), deps.dismiss),
    clearResponse(),
  ]);
  for (const result of results) if (result.status === 'rejected') throw result.reason;
}
