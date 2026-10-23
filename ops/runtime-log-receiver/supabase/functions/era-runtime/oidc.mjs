// GitHub public verification keys only; never requests, logs or stores a JWT.
export const ISSUER = "https://token.actions.githubusercontent.com";
export const JWKS_URL = `${ISSUER}/.well-known/jwks`;
export const AUDIENCE = "https://lmwqrxoitraofaftpwhe.supabase.co/functions/v1/era-runtime";
export const SUBJECT = "repo:djv3ndy-bit@313253306/baa@1324630119:ref:refs/heads/main";
export const WORKFLOW = "djv3ndy-bit/baa/.github/workflows/engineering-reliability-monitor.yml@refs/heads/main";
const MAX_TOKEN_BYTES = 16_384;
const MAX_JWKS_BYTES = 65_536;
const CACHE_MS = 5 * 60 * 1_000;
const CLOCK_SKEW_SECONDS = 30;
const encoder = new TextEncoder();

export class OidcAuthError extends Error {
  constructor() { super("identity_refused"); }
}

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function base64url(value, maxBytes) {
  if (typeof value !== "string" || value.length > Math.ceil(maxBytes * 4 / 3) ||
      !/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) throw new OidcAuthError();
  let decoded;
  try { decoded = atob(value.replaceAll("-", "+").replaceAll("_", "/")); }
  catch { throw new OidcAuthError(); }
  if (decoded.length > maxBytes ||
      btoa(decoded).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "") !== value) {
    throw new OidcAuthError();
  }
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
}

function strictJson(bytes) {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const value = JSON.parse(text);
    // JSON.parse otherwise accepts duplicate object keys. Scan already-valid
    // JSON tokens, decoding each key before checking (including escaped keys).
    const stack = [];
    for (let index = 0; index < text.length; index++) {
      const character = text[index];
      if (character === "{") stack.push({ object: true, key: true, keys: new Set() });
      else if (character === "[") stack.push({ object: false });
      else if (character === "}" || character === "]") stack.pop();
      else if (character === "," && stack.at(-1)?.object) stack.at(-1).key = true;
      else if (character === '"') {
        let end = index + 1;
        while (end < text.length && text[end] !== '"') {
          if (text[end] === "\\") end++;
          end++;
        }
        const frame = stack.at(-1);
        if (frame?.object && frame.key) {
          const key = JSON.parse(text.slice(index, end + 1));
          if (frame.keys.has(key)) throw new OidcAuthError();
          frame.keys.add(key);
          frame.key = false;
        }
        index = end;
      }
    }
    if (!record(value)) throw new OidcAuthError();
    return value;
  } catch { throw new OidcAuthError(); }
}

function parsedJwt(token, now) {
  if (typeof token !== "string" || token.length > MAX_TOKEN_BYTES) throw new OidcAuthError();
  const pieces = token.split(".");
  if (pieces.length !== 3) throw new OidcAuthError();
  const header = strictJson(base64url(pieces[0], 2_048));
  const claims = strictJson(base64url(pieces[1], 10_240));
  const signature = base64url(pieces[2], 512);
  if (header.alg !== "RS256" || header.typ !== "JWT" ||
      typeof header.kid !== "string" || !/^[A-Za-z0-9_.-]{1,128}$/.test(header.kid) ||
      Object.hasOwn(header, "jku") || Object.hasOwn(header, "jwk") ||
      Object.hasOwn(header, "x5u") || Object.hasOwn(header, "crit") ||
      claims.iss !== ISSUER || claims.aud !== AUDIENCE || claims.sub !== SUBJECT ||
      claims.repository !== "djv3ndy-bit/baa" || claims.repository_id !== "1324630119" ||
      claims.repository_owner_id !== "313253306" || claims.workflow_ref !== WORKFLOW ||
      claims.ref !== "refs/heads/main" || claims.ref_type !== "branch" ||
      ![claims.exp, claims.nbf, claims.iat].every((value) => Number.isSafeInteger(value) && value > 0) ||
      claims.exp <= now || claims.exp <= claims.iat || claims.exp - claims.iat > 600 ||
      claims.iat < now - 600 || claims.iat > now + CLOCK_SKEW_SECONDS ||
      claims.nbf > now + CLOCK_SKEW_SECONDS || claims.nbf >= claims.exp ||
      claims.nbf < claims.iat - 600 || signature.length < 256) throw new OidcAuthError();
  return { header, signature, signingInput: encoder.encode(`${pieces[0]}.${pieces[1]}`) };
}

async function publicKeys(fetcher) {
  const response = await fetcher(JWKS_URL, {
    method: "GET", redirect: "error", signal: AbortSignal.timeout(3_000),
    headers: { Accept: "application/json" },
  });
  if (!response.ok || !response.headers.get("content-type")?.includes("application/json") ||
      !response.body) throw new Error("identity_provider_unavailable");
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > MAX_JWKS_BYTES) throw new Error("identity_provider_unavailable");
      chunks.push(next.value);
    }
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  let data;
  try { data = strictJson(bytes); }
  catch { throw new Error("identity_provider_unavailable"); }
  if (!Array.isArray(data.keys) || data.keys.length < 1 || data.keys.length > 32) {
    throw new Error("identity_provider_unavailable");
  }
  const seen = new Set();
  const keys = new Map();
  for (const value of data.keys) {
    let modulus;
    try { modulus = base64url(value?.n, 512); }
    catch { throw new Error("identity_provider_unavailable"); }
    if (!record(value) || value.kty !== "RSA" ||
        (value.alg !== undefined && value.alg !== "RS256") ||
        (value.use !== undefined && value.use !== "sig") ||
        (value.key_ops !== undefined &&
          (!Array.isArray(value.key_ops) || value.key_ops.length !== 1 || value.key_ops[0] !== "verify")) ||
        typeof value.kid !== "string" || !/^[A-Za-z0-9_.-]{1,128}$/.test(value.kid) || seen.has(value.kid) ||
        Object.hasOwn(value, "d") || modulus.length < 256 || value.e !== "AQAB") {
      throw new Error("identity_provider_unavailable");
    }
    seen.add(value.kid);
    keys.set(value.kid, await crypto.subtle.importKey("jwk", {
      kty: "RSA", n: value.n, e: value.e, alg: "RS256", ext: true,
    }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]));
  }
  return keys;
}

export function createOidcVerifier({ fetcher = fetch, now = () => Date.now() } = {}) {
  let cached;
  let expires = 0;
  let pending;
  return async (token) => {
    const parsed = parsedJwt(token, Math.floor(now() / 1_000));
    if (!cached || now() >= expires) {
      if (!pending) pending = publicKeys(fetcher).then((keys) => {
        cached = keys;
        expires = now() + CACHE_MS;
      }).finally(() => { pending = undefined; });
      await pending;
    }
    const key = cached.get(parsed.header.kid);
    if (!key || !await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key,
      parsed.signature, parsed.signingInput)) throw new OidcAuthError();
    return true;
  };
}
