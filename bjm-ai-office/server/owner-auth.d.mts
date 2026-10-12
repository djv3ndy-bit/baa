import type { IncomingMessage, ServerResponse } from 'node:http';
type Request = Pick<IncomingMessage, 'headers'> & Partial<Pick<IncomingMessage, 'rawHeaders'>>;
type Response = Pick<ServerResponse, 'setHeader'> & { status(code: number): Response; json(body: unknown): unknown };
type Options = { env?: Record<string, string | undefined>; fetchImpl?: typeof fetch; now?: () => number };
type Authorization = { ok: true; ownerId: string } | { ok: false; status: number; headers: Record<string, string>; body: { error: string } };
export function authorizeOfficeRequest(req: Request, options?: Options): Promise<Authorization>;
export function requireOfficeOwner(req: Request, res: Response): Promise<boolean>;
export function protectedResourceMetadata(env?: Record<string, string | undefined>): { resource: string; authorization_servers: string[]; scopes_supported: string[]; bearer_methods_supported: string[]; resource_name: string };
