/**
 * Private Office resource-server boundary. Supabase Auth verifies the token;
 * local checks constrain that verified token to this owner, client and resource.
 * This is NOT a replacement for OAuth-specific database RLS/grants.
 */
const clean = value => typeof value === 'string' ? value.trim() : '';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_TOKEN = 8192;

// Discovery contains public identifiers only and is available before client setup.
function discoveryConfiguration(env) {
  const supabaseUrl = new URL(clean(env.SUPABASE_URL));
  const officeUrl = new URL(clean(env.BJM_OFFICE_BASE_URL));
  if (supabaseUrl.protocol !== 'https:' || officeUrl.protocol !== 'https:' ||
      supabaseUrl.username || supabaseUrl.password || officeUrl.username || officeUrl.password ||
      supabaseUrl.search || supabaseUrl.hash || officeUrl.search || officeUrl.hash ||
      supabaseUrl.pathname !== '/' || officeUrl.pathname !== '/') throw new Error('Invalid origins');
  return {
    issuer: `${supabaseUrl.origin}/auth/v1`,
    resource: `${officeUrl.origin}/mcp`,
    metadataUrl: `${officeUrl.origin}/.well-known/oauth-protected-resource`,
    origin: officeUrl.origin,
  };
}

function configuration(env) {
  const discovery = discoveryConfiguration(env);
  const ownerId = clean(env.BJM_AI_OFFICE_OWNER_USER_ID);
  const clientId = clean(env.BJM_AI_OFFICE_OAUTH_CLIENT_ID);
  const publishableKey = clean(env.SUPABASE_PUBLISHABLE_KEY);
  if (!UUID.test(ownerId) || !clientId || clientId.length > 512 ||
      !/^sb_publishable_[A-Za-z0-9_-]+$/.test(publishableKey)) throw new Error('Missing configuration');
  return {
    ...discovery, ownerId, clientId, publishableKey,
  };
}

export function protectedResourceMetadata(env = process.env) {
  const config = discoveryConfiguration(env);
  return {
    resource: config.resource,
    authorization_servers: [config.issuer],
    scopes_supported: ['openid'],
    bearer_methods_supported: ['header'],
    resource_name: 'BaristaMatch private AI Office',
  };
}

function result(status, error, config) {
  const headers = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' };
  if (status === 401 && config) {
    headers['WWW-Authenticate'] = `Bearer resource_metadata="${config.metadataUrl}", error="invalid_token", error_description="A valid owner OAuth access token is required"`;
  }
  return { ok: false, status, headers, body: { error } };
}

function decodePart(value) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Malformed JWT');
  const decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) throw new Error('Malformed JWT');
  return decoded;
}

/** Dependencies are injectable for offline tests; production uses global fetch. */
export async function authorizeOfficeRequest(req, options = {}) {
  const env = options.env || process.env;
  let discovery;
  try { discovery = discoveryConfiguration(env); } catch { return result(503, 'Office authentication is not configured'); }
  const origin = req.headers?.origin;
  if (origin !== undefined && origin !== discovery.origin) return result(403, 'Origin is not allowed');
  // A challenge enables OAuth setup only. No MCP server or provider is invoked.
  if (req.headers?.authorization === undefined) return result(401, 'Authentication required', discovery);

  let config;
  try { config = configuration(env); } catch { return result(503, 'Office authentication is not configured'); }

  // A missing switch must never expose data. This switch is NOT evidence of RLS safety.
  if (clean(env.BJM_AI_OFFICE_AUTH_ENABLED) !== 'true') return result(503, 'Office access is not activated');
  // The customer app needs its own keys. They must not be inherited by this Office.
  if (clean(env.SUPABASE_SECRET_KEY) || clean(env.SUPABASE_SERVICE_ROLE_KEY)) {
    return result(503, 'Office privileged database credentials must be removed');
  }

  const raw = req.rawHeaders || [];
  const authHeaders = raw.filter((value, index) => index % 2 === 0 && String(value).toLowerCase() === 'authorization');
  if (authHeaders.length > 1) return result(401, 'Authentication required', config);
  const authorization = req.headers?.authorization;
  if (typeof authorization !== 'string' || authorization.length > MAX_TOKEN + 7 ||
      !/^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/i.test(authorization)) {
    return result(401, 'Authentication required', config);
  }
  const token = authorization.slice(7);
  let claims;
  const now = Math.floor((options.now || Date.now)() / 1000);
  try {
    const [headerPart, payloadPart] = token.split('.');
    const header = decodePart(headerPart);
    claims = decodePart(payloadPart);
    // Parsing alone never authorizes. Supabase verifies the exact token below.
    if (!['ES256', 'RS256'].includes(header.alg) || header.crit !== undefined || header.b64 !== undefined) throw new Error('Unsupported token');
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!audiences.every(aud => typeof aud === 'string') || !audiences.includes(config.resource) ||
        claims.iss !== config.issuer || claims.client_id !== config.clientId ||
        !UUID.test(claims.sub || '') || !UUID.test(claims.session_id || '') ||
        claims.role !== 'bjm_office_reader' ||
        !Number.isSafeInteger(claims.exp) || !Number.isSafeInteger(claims.iat) ||
        claims.exp <= now || claims.iat > now + 30 || claims.exp <= claims.iat || claims.exp - claims.iat > 3600 ||
        (claims.nbf !== undefined && (!Number.isSafeInteger(claims.nbf) || claims.nbf > now + 30)) ||
        typeof claims.scope !== 'string' || !claims.scope.split(/\s+/).includes('openid')) throw new Error('Invalid claims');
  } catch { return result(401, 'Authentication required', config); }

  let response;
  try {
    response = await (options.fetchImpl || globalThis.fetch)(`${config.issuer}/user`, {
      method: 'GET', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(5000),
      headers: { apikey: config.publishableKey, Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });
  } catch { return result(503, 'Authentication service unavailable'); }
  if (response.status === 429 || response.status >= 500) return result(503, 'Authentication service unavailable');
  if (!response.ok) return result(401, 'Authentication required', config);

  let user;
  try { user = await response.json(); } catch { return result(503, 'Authentication service unavailable'); }
  if (!user || user.id !== claims.sub || !user.email_confirmed_at || user.is_anonymous ||
      user.deleted_at || (user.banned_until && (!Number.isFinite(Date.parse(user.banned_until)) || Date.parse(user.banned_until) > now * 1000))) {
    return result(401, 'Authentication required', config);
  }
  if (user.id !== config.ownerId) return result(403, 'Owner access required');
  // Never return the token or user metadata to the model, widget or logs.
  return { ok: true, ownerId: user.id };
}

export async function requireOfficeOwner(req, res) {
  const authorization = await authorizeOfficeRequest(req);
  // This credential is only passed to the request's private provider closure.
  // It must never enter a tool result, widget prop, process environment or log.
  if (authorization.ok) return { ownerId: authorization.ownerId, accessToken: req.headers.authorization.slice(7) };
  for (const [key, value] of Object.entries(authorization.headers)) res.setHeader(key, value);
  res.status(authorization.status).json(authorization.body);
  return false;
}
