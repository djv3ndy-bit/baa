export const CHAT_SCOPE: 'office.read';
export class ChatOAuthError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string);
}
export type ChatOAuthStore = (operation: string, args: Record<string, unknown>) => Promise<unknown>;
export type ChatOAuthConfiguration = {
  issuer: string; resource: string; authorizeUrl: string; tokenUrl: string;
  revokeUrl: string; ownerCallback: string; clientId: string; redirectUri: string;
  ownerId: string; upstreamClientId: string; upstreamIssuer: string;
  publishableKey: string; flowKey: string;
};
export function chatOAuthConfiguration(env?: Record<string, string | undefined>): ChatOAuthConfiguration;
export function chatAuthorizationMetadata(env?: Record<string, string | undefined>): {
  issuer: string; authorization_endpoint: string; token_endpoint: string;
  revocation_endpoint: string; response_types_supported: string[];
  grant_types_supported: string[]; code_challenge_methods_supported: string[];
  token_endpoint_auth_methods_supported: string[];
  revocation_endpoint_auth_methods_supported: string[]; scopes_supported: string[];
  authorization_response_iss_parameter_supported: boolean;
};
export function createChatOAuthHandlers(options?: {
  env?: Record<string, string | undefined>;
  store?: ChatOAuthStore;
  fetchImpl?: typeof fetch;
  /** Returns Unix milliseconds, matching Date.now. */
  now?: () => number;
}): {
  authorize(req: any, res: any): Promise<void>;
  ownerCallback(req: any, res: any): Promise<void>;
  token(req: any, res: any): Promise<void>;
  revoke(req: any, res: any): Promise<void>;
  verifyAccessToken(token: string): Promise<{ownerId: string; accessHash: string}>;
};
