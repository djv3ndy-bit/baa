import postgres from 'postgres';

const OPERATIONS = new Set(['create_flow', 'consume_flow', 'create_code', 'exchange_code', 'refresh', 'verify', 'revoke']);
const HASH = /^[a-f0-9]{64}$/;
const unavailable = () => new Error('Office reporting storage is unavailable');

/** This accepts only the dedicated Office login, never a customer/admin URL.
 * The password stays in this server closure. All SQL text below is constant;
 * unsafe() receives separate protocol parameters, not interpolated SQL.
 */
export function chatDatabaseConfiguration(env = process.env) {
  try {
    if (env.SUPABASE_SECRET_KEY?.trim() || env.SUPABASE_SERVICE_ROLE_KEY?.trim()) throw unavailable();
    const project = new URL(String(env.SUPABASE_URL || '').trim());
    if (project.protocol !== 'https:' || project.username || project.password || project.port || project.pathname !== '/' || project.search || project.hash ||
        !/^[a-z0-9]{20}\.supabase\.co$/.test(project.hostname)) throw unavailable();
    const expectedHost = String(env.BJM_CHAT_DATABASE_HOST || '').trim();
    if (!/^aws-[0-9]+-[a-z0-9-]+\.pooler\.supabase\.com$/.test(expectedHost)) throw unavailable();
    const url = new URL(String(env.BJM_CHAT_DATABASE_URL || '').trim());
    const user = decodeURIComponent(url.username);
    const password = decodeURIComponent(url.password);
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hostname !== expectedHost || url.port !== '6543' || url.pathname !== '/postgres' ||
        url.hash || (url.search && url.search !== '?sslmode=verify-full') ||
        user !== `bjm_office_gateway_login.${project.hostname.split('.')[0]}` || !/^[A-Za-z0-9_-]{43,128}$/.test(password)) throw unavailable();
    const ca = String(env.BJM_CHAT_DATABASE_CA_PEM || '').trim();
    if (ca && (ca.length > 32768 || !ca.includes('-----BEGIN CERTIFICATE-----') || !ca.includes('-----END CERTIFICATE-----') || ca.includes('PRIVATE KEY'))) throw unavailable();
    // Explicit options override URL/environment defaults; no plaintext fallback.
    return {
      host: expectedHost, port: 6543, database: 'postgres', username: user, password,
      ssl: { rejectUnauthorized: true, ...(ca ? { ca } : {}) },
      max: 1, prepare: false, connect_timeout: 5, idle_timeout: 20, max_lifetime: 60,
      fetch_types: false, debug: false, onnotice: () => {},
      connection: { application_name: 'bjm-ai-office-chat' },
    };
  } catch { throw unavailable(); }
}

function boundedObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw unavailable();
  let json;
  try { json = JSON.stringify(value); } catch { throw unavailable(); }
  if (Buffer.byteLength(json) > 32768) throw unavailable();
  return json;
}
function oneResult(rows) {
  if (!Array.isArray(rows) || rows.length !== 1 || !Object.hasOwn(rows[0], 'result')) throw unavailable();
  const result = rows[0].result;
  if (result !== null && (!result || typeof result !== 'object' || Array.isArray(result))) throw unavailable();
  if (Buffer.byteLength(JSON.stringify(result)) > 32768) throw unavailable();
  return result;
}

export function createChatStore(env = process.env, options = {}) {
  const config = chatDatabaseConfiguration(env);
  const client = (options.sqlFactory || postgres)(config);
  let closed = false;
  const store = async (operation, args) => {
    if (closed || !OPERATIONS.has(operation)) throw unavailable();
    const json = boundedObject(args);
    try {
      // A null result can deliberately COMMIT refresh-family revocation.
      // Never surround this call with a rollback-on-invalid-grant transaction.
      return oneResult(await client.unsafe('select bjm_office_gateway.auth_dispatch($1::text, $2::jsonb) as result', [operation, json]));
    } catch { throw unavailable(); }
  };
  store.snapshot = async (accessHash, clientId, resource) => {
    if (closed || !HASH.test(accessHash) || typeof clientId !== 'string' || !clientId || clientId.length > 256 || typeof resource !== 'string' || resource.length > 2048) throw unavailable();
    try {
      return oneResult(await client.unsafe('select bjm_office_gateway.read_snapshot($1::text, $2::text, $3::text) as result', [accessHash, clientId, resource]));
    } catch { throw unavailable(); }
  };
  store.close = async () => {
    if (closed) return;
    closed = true;
    try { await client.end({ timeout: 1 }); } catch {}
  };
  return store;
}
