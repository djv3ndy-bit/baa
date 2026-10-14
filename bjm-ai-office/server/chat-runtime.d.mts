import type { ChatStore } from './chat-store.mjs';
import { createChatOAuthHandlers } from './chat-oauth.mjs';
export function createChatRuntime(env?: Record<string, string | undefined>, dependencies?: {
  store?: ChatStore; fetchImpl?: typeof fetch; now?: () => number; sqlFactory?: any;
}): Readonly<{store: ChatStore; oauth: ReturnType<typeof createChatOAuthHandlers>}>;
export function getChatRuntime(): ReturnType<typeof createChatRuntime>;
