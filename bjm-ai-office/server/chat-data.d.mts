import { createOfficeProviders } from './office-data.mjs';
import type { ChatStore } from './chat-store.mjs';
export function createChatOfficeProviders(owner: {ownerId: string; accessHash: string}, options: {
  store: ChatStore; env?: Record<string, string | undefined>; fetchImpl?: typeof fetch; now?: () => number;
}): ReturnType<typeof createOfficeProviders>;
