import { timingSafeEqual } from 'node:crypto';

const env = (name: string) => String(process.env[name] || '').trim();

function secureEqual(left: string, right: string) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export type OwnerAuthDecision =
  | { ok: true }
  | { ok: false; status: 401 | 503; message: string };

export function authorizeOwnerRequest(authorizationHeader: unknown): OwnerAuthDecision {
  const expected = env('BJM_AI_OFFICE_OWNER_TOKEN');
  if (!expected) {
    return {
      ok: false,
      status: 503,
      message: 'AI Office owner authentication is not configured.',
    };
  }

  const authorization = typeof authorizationHeader === 'string' ? authorizationHeader.trim() : '';
  const prefix = 'Bearer ';
  const presented = authorization.startsWith(prefix) ? authorization.slice(prefix.length).trim() : '';

  if (!presented || !secureEqual(presented, expected)) {
    return {
      ok: false,
      status: 401,
      message: 'Unauthorized.',
    };
  }

  return { ok: true };
}

export function requireOwnerAuth(req: any, res: any) {
  const decision = authorizeOwnerRequest(req?.headers?.authorization);
  if (decision.ok) return true;

  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (decision.status === 401) res.setHeader('WWW-Authenticate', 'Bearer realm="BJM AI Office"');
  res.status(decision.status).json({ error: decision.message });
  return false;
}
