import { createChatStore } from './chat-store.mjs';
import { createChatOAuthHandlers, chatOAuthConfiguration } from './chat-oauth.mjs';

export function createChatRuntime(env = process.env, dependencies = {}) {
  // Validate before opening a pool. No database work or credentials at import.
  chatOAuthConfiguration(env);
  const store = dependencies.store || createChatStore(env, dependencies);
  const oauth = createChatOAuthHandlers({ env, store, fetchImpl: dependencies.fetchImpl, now: dependencies.now });
  return Object.freeze({ store, oauth });
}
let runtime;
export function getChatRuntime() { return runtime ||= createChatRuntime(); }
