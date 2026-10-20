import type { createChatOAuthHandlers } from './chat-oauth.mjs';
export function protectedResourceMetadata(env?: Record<string, string | undefined>): {
  resource: string; authorization_servers: string[]; scopes_supported: string[]; bearer_methods_supported: string[]; resource_name: string;
};
export function requireChatOfficeOwner(req: any, res: any, options: {
  env?: Record<string, string | undefined>; oauth: ReturnType<typeof createChatOAuthHandlers>;
}): Promise<{ownerId: string; accessHash: string} | false>;
