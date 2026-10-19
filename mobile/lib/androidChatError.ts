const CONNECTION_LOST = 'Connection lost. Check this conversation before trying again.';
const INBOX_CONNECTION_LOST = 'Connection lost. Check your connection and try again.';

// PostgREST can wrap a failed fetch in a plain object, so the shared formatter
// receives its string message rather than a TypeError instance. Keep this
// Android presentation fix narrow; delivery and retry state remain unchanged.
export function androidChatErrorMessage(message: string, context: 'conversation' | 'inbox' | 'settings' = 'conversation'): string {
  const wrappedNetworkFailure = /^TypeError:\s*(?:Network request failed|Failed to fetch)$/i.test(message.trim());
  const settingsLoadNetworkFailure = context === 'settings' && /^Network request failed$/i.test(message.trim());
  return wrappedNetworkFailure || settingsLoadNetworkFailure
    ? context === 'conversation' ? CONNECTION_LOST : INBOX_CONNECTION_LOST
    : message;
}
