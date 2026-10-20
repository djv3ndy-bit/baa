import { CHAT_SCOPE, ChatOAuthError, chatAuthorizationMetadata, chatOAuthConfiguration } from './chat-oauth.mjs';

export function protectedResourceMetadata(env = process.env) {
  const { issuer } = chatAuthorizationMetadata(env);
  return { resource: `${issuer}/mcp`, authorization_servers: [issuer], scopes_supported: [CHAT_SCOPE],
    bearer_methods_supported: ['header'], resource_name: 'BaristaMatch private AI team reports' };
}

export async function requireChatOfficeOwner(req, res, options = {}) {
  const env = options.env || process.env;
  const reject = (status, message, issuer) => {
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (status === 401 && issuer) res.setHeader('WWW-Authenticate', `Bearer resource_metadata="${issuer}/.well-known/oauth-protected-resource", scope="${CHAT_SCOPE}", error="invalid_token"`);
    res.status(status).json({ error: message });
    return false;
  };
  let issuer;
  try { issuer = chatAuthorizationMetadata(env).issuer; }
  catch { return reject(503, 'Office is temporarily unavailable.'); }
  if (req.headers?.origin !== undefined && req.headers.origin !== issuer) return reject(403, 'Origin is not allowed.');
  const authorization = req.headers?.authorization;
  if (authorization === undefined) return reject(401, 'Authentication required.', issuer);
  const duplicates = (req.rawHeaders || []).filter((value, index) => index % 2 === 0 && String(value).toLowerCase() === 'authorization').length;
  if (duplicates > 1 || typeof authorization !== 'string' || !/^Bearer bjm_at_[A-Za-z0-9_-]{43}$/i.test(authorization)) return reject(401, 'Authentication required.', issuer);
  let config;
  try { config = chatOAuthConfiguration(env); }
  catch { return reject(503, 'Office is temporarily unavailable.'); }
  try {
    const owner = await options.oauth.verifyAccessToken(authorization.slice(7));
    if (!owner || owner.ownerId !== config.ownerId || !/^[a-f0-9]{64}$/.test(owner.accessHash)) return reject(401, 'Authentication required.', issuer);
    return { ownerId: owner.ownerId, accessHash: owner.accessHash };
  } catch (error) {
    return error instanceof ChatOAuthError && error.status === 401
      ? reject(401, 'Authentication required.', issuer) : reject(503, 'Office is temporarily unavailable.');
  }
}
