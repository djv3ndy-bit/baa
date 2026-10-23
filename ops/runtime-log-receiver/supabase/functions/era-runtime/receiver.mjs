// Deliberately dependency-free. No raw log, header, token or RPC error is logged.
import { createOidcVerifier, OidcAuthError } from "./oidc.mjs";
export const PROJECT_ID = "prj_VuAxQpdhDJPeTPdanA5HjtOrylA5";
export const SUPABASE_ORIGIN = "https://lmwqrxoitraofaftpwhe.supabase.co";
export const MAX_BODY_BYTES = 1_048_576;
export const MAX_EVENTS = 5_000;
export const MAX_EVENT_AGE_MS = 24 * 60 * 60 * 1_000;
export const MAX_WINDOW_MS = 2 * 60 * 60 * 1_000;
export const MAX_FUTURE_MS = 60 * 1_000;
export const CATEGORIES = Object.freeze([
  "runtime_error", "runtime_fatal", "http_5xx", "runtime_ok",
]);
const PATHS = new Set(["/era-runtime", "/functions/v1/era-runtime"]);
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const ID = /^[A-Za-z0-9_.:-]{1,256}$/;
const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const encoder = new TextEncoder();

class Refusal extends Error {
  constructor(status) { super("request_refused"); this.status = status; }
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    },
  });
}

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, keys) {
  return record(value) && Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key));
}

function bearer(request) {
  const header = request.headers.get("authorization") || "";
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(header);
  if (!match || !TOKEN.test(match[1])) throw new Refusal(401);
  return match[1];
}

function identityBearer(request) {
  const header = request.headers.get("authorization") || "";
  const match = /^Bearer ([A-Za-z0-9_.-]{1,16384})$/.exec(header);
  if (!match) throw new Refusal(401);
  return match[1];
}

export async function sha256(value) {
  const bytes = typeof value === "string" ? encoder.encode(value) : value;
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function boundedBody(request, maxBytes = MAX_BODY_BYTES) {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null &&
      (!/^[0-9]{1,10}$/.test(contentLength) || Number(contentLength) > maxBytes)) {
    throw new Refusal(413);
  }
  if (!request.body) throw new Refusal(400);
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  let timeout;
  try {
    const expired = new Promise((_, reject) => {
      timeout = setTimeout(() => {
        void reader.cancel().catch(() => {});
        reject(new Refusal(408));
      }, 5_000);
    });
    while (true) {
      const next = await Promise.race([reader.read(), expired]);
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maxBytes) throw new Refusal(413);
      chunks.push(next.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return bytes;
  } finally {
    clearTimeout(timeout);
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function verifySignature(token, signature, bytes) {
  if (!/^[0-9a-fA-F]{40}$/.test(signature || "")) throw new Refusal(401);
  const digest = new Uint8Array(signature.match(/../g).map((pair) => parseInt(pair, 16)));
  const key = await crypto.subtle.importKey(
    "raw", encoder.encode(token), { name: "HMAC", hash: "SHA-1" }, false, ["verify"],
  );
  // Native cryptographic verification avoids a data-dependent JavaScript compare.
  if (!await crypto.subtle.verify("HMAC", key, digest, bytes)) throw new Refusal(401);
}

function timestamp(value) {
  if (typeof value !== "string" || !UTC.test(value)) throw new Refusal(400);
  const number = Date.parse(value);
  if (!Number.isFinite(number) || new Date(number).toISOString() !== value) {
    throw new Refusal(400);
  }
  return number;
}

function statusCode(value) {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || !(value === -1 || (value >= 100 && value <= 599))) {
    throw new Refusal(422);
  }
  return value;
}

async function normalizedEvents(bytes, now) {
  let payload;
  try { payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new Refusal(422); }
  if (!Array.isArray(payload) || payload.length < 1 || payload.length > MAX_EVENTS) {
    throw new Refusal(422);
  }
  const events = [];
  const seen = new Map();
  for (const value of payload) {
    if (!record(value) || value.projectId !== PROJECT_ID ||
        value.environment !== "production" || !["lambda", "edge"].includes(value.source) ||
        typeof value.id !== "string" || !ID.test(value.id) ||
        typeof value.deploymentId !== "string" || !ID.test(value.deploymentId) ||
        !["info", "warning", "error", "fatal"].includes(value.level) ||
        !Number.isSafeInteger(value.timestamp) || value.timestamp < now - MAX_EVENT_AGE_MS ||
        value.timestamp > now + MAX_FUTURE_MS ||
        (value.proxy !== undefined && !record(value.proxy))) {
      throw new Refusal(422);
    }
    const topStatus = statusCode(value.statusCode);
    const proxyStatus = statusCode(value.proxy?.statusCode);
    const category = value.level === "fatal" || topStatus === -1 || value.type === "fatal"
      ? "runtime_fatal"
      : value.level === "error" ? "runtime_error"
      : (topStatus >= 500 || proxyStatus >= 500) ? "http_5xx" : "runtime_ok";
    const event = {
      event_key: await sha256(`${PROJECT_ID}\0${value.deploymentId}\0${value.id}`),
      occurred_at: new Date(value.timestamp).toISOString(),
      category,
    };
    const previous = seen.get(event.event_key);
    if (previous && (previous.occurred_at !== event.occurred_at || previous.category !== event.category)) {
      throw new Refusal(422);
    }
    if (!previous) { events.push(event); seen.set(event.event_key, event); }
  }
  return events;
}

function summary(value, since, until) {
  const keys = ["schema_version", "project_id", "environment", "window", "counts",
    "coverage_started_at", "last_delivery_at", "complete", "truncated"];
  if (!exactKeys(value, keys) || value.schema_version !== 1 || value.project_id !== PROJECT_ID ||
      value.environment !== "production" || !exactKeys(value.window, ["since", "until"]) ||
      value.window.since !== since || value.window.until !== until ||
      !exactKeys(value.counts, CATEGORIES) ||
      !CATEGORIES.every((key) => Number.isSafeInteger(value.counts[key]) && value.counts[key] >= 0) ||
      typeof value.complete !== "boolean" || typeof value.truncated !== "boolean") {
    throw new Refusal(503);
  }
  for (const key of ["coverage_started_at", "last_delivery_at"]) {
    if (value[key] !== null) {
      try { timestamp(value[key]); } catch { throw new Refusal(503); }
    }
  }
  return value;
}

// rpc may invoke only the two fixed service-only functions. Tests inject a fake.
export function createHandler({ rpc, now = () => Date.now(), verifyOidc = createOidcVerifier({ now }) }) {
  return async function handler(request) {
    try {
      const url = new URL(request.url);
      if (!PATHS.has(url.pathname)) return json({ error: "not_found" }, 404);
      if (!["GET", "POST"].includes(request.method)) return json({ error: "method_refused" }, 405);
      const currentTime = now();
      if (request.method === "POST") {
        const token = bearer(request);
        const tokenDigest = await sha256(token);
        const bytes = await boundedBody(request);
        await verifySignature(token, request.headers.get("x-vercel-signature"), bytes);
        const deliveryDigest = await sha256(bytes);
        // An arbitrary caller can compute an HMAC with its own random token.
        // Authorize its digest before parsing/hashing up to 5,000 records. The
        // fixed empty probe is strictly non-mutating in the service-only RPC.
        const authorization = await rpc("era_runtime_ingest", {
          p_token_digest: tokenDigest, p_delivery_digest: deliveryDigest, p_events: [],
        });
        if (record(authorization) && authorization.authorized === false) throw new Refusal(401);
        if (!exactKeys(authorization, ["authorized", "accepted", "duplicate", "inserted_events"]) ||
            authorization.authorized !== true || authorization.accepted !== true ||
            typeof authorization.duplicate !== "boolean" || authorization.inserted_events !== 0) {
          throw new Refusal(503);
        }
        const invalidBatch = async () => {
          // Only a registered key can latch an authenticated malformed-delivery
          // gap. No raw fields or timestamps are forwarded on this failure path.
          const result = await rpc("era_runtime_ingest", {
            p_token_digest: tokenDigest, p_delivery_digest: deliveryDigest, p_events: null,
          });
          if (record(result) && result.authorized === false) throw new Refusal(401);
          if (record(result) && result.authorized === true && result.accepted === false &&
              result.status === "invalid_batch") throw new Refusal(400);
          throw new Refusal(503);
        };
        if (url.search ||
            request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json" ||
            ![null, "identity"].includes(request.headers.get("content-encoding"))) {
          return await invalidBatch();
        }
        let events;
        try { events = await normalizedEvents(bytes, currentTime); }
        catch (error) {
          if (error instanceof Refusal && error.status === 422) return await invalidBatch();
          throw error;
        }
        const result = await rpc("era_runtime_ingest", {
          p_token_digest: tokenDigest,
          p_delivery_digest: deliveryDigest,
          p_events: events,
        });
        if (record(result) && result.authorized === false) throw new Refusal(401);
        if (record(result) && result.authorized === true && result.accepted === false &&
            result.status === "invalid_batch") throw new Refusal(400);
        if (!exactKeys(result, ["authorized", "accepted", "duplicate", "inserted_events"]) ||
            result.authorized !== true || result.accepted !== true ||
            typeof result.duplicate !== "boolean" || !Number.isSafeInteger(result.inserted_events) ||
            result.inserted_events < 0 || result.inserted_events > events.length) {
          throw new Refusal(503);
        }
        return json({ accepted: true });
      }
      await verifyOidc(identityBearer(request));
      if ([...url.searchParams.keys()].sort().join(",") !== "since,until" ||
          url.searchParams.getAll("since").length !== 1 || url.searchParams.getAll("until").length !== 1) {
        throw new Refusal(400);
      }
      const since = url.searchParams.get("since");
      const until = url.searchParams.get("until");
      const start = timestamp(since);
      const end = timestamp(until);
      if (start >= end || end - start > MAX_WINDOW_MS || start < currentTime - MAX_EVENT_AGE_MS ||
          end > currentTime + MAX_FUTURE_MS) throw new Refusal(400);
      const result = await rpc("era_runtime_summary", {
        p_since: since, p_until: until,
      });
      if (record(result) && result.authorized === false) throw new Refusal(401);
      if (record(result) && result.status === "invalid_window") throw new Refusal(400);
      return json(summary(result, since, until));
    } catch (error) {
      return json({ error: "request_refused" }, error instanceof Refusal ? error.status :
        error instanceof OidcAuthError ? 401 : 503);
    }
  };
}

// Uses only Supabase's auto-provided backend credential, never the caller token.
export function createRpc({ url, key, legacy = false, fetcher = fetch }) {
  if (url !== SUPABASE_ORIGIN || typeof key !== "string" || !key) {
    throw new Error("backend_not_configured");
  }
  const allowed = new Set(["era_runtime_ingest", "era_runtime_summary"]);
  return async (name, parameters) => {
    if (!allowed.has(name)) throw new Error("rpc_refused");
    const response = await fetcher(`${SUPABASE_ORIGIN}/rest/v1/rpc/${name}`, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(5_000),
      headers: {
        "Content-Type": "application/json", apikey: key,
        ...(legacy ? { Authorization: `Bearer ${key}` } : {}),
      },
      body: JSON.stringify(parameters),
    });
    if ([401, 403].includes(response.status)) return { authorized: false };
    if (!response.ok || !response.headers.get("content-type")?.includes("application/json")) {
      throw new Error("backend_unavailable");
    }
    try {
      const bytes = await boundedBody(response, 65_536);
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    }
    catch { throw new Error("backend_unavailable"); }
  };
}
