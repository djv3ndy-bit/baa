import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHandler, createRpc, sha256, PROJECT_ID, SUPABASE_ORIGIN,
  MAX_BODY_BYTES, MAX_EVENTS } from "./supabase/functions/era-runtime/receiver.mjs";
import { OidcAuthError } from "./supabase/functions/era-runtime/oidc.mjs";

// Fixed non-secret fixtures. Tests perform no network, provider or database call.
const INGEST = "i".repeat(43);
const READ = "r".repeat(43);
const NOW = Date.parse("2026-10-23T16:00:00.000Z");
const URL = `${SUPABASE_ORIGIN}/functions/v1/era-runtime`;
const WINDOW = { since: "2026-10-23T15:00:00.000Z", until: "2026-10-23T16:00:00.000Z" };
const encoder = new TextEncoder();
const fixture = (override = {}) => ({
  id: "1573817250283254651097202070", deploymentId: "dpl_fixture",
  source: "lambda", host: "example.vercel.app", timestamp: NOW - 1_000,
  projectId: PROJECT_ID, level: "error", environment: "production",
  message: "private-secret@example.com must-not-store", path: "/users/private?token=secret",
  proxy: { clientIp: "192.0.2.10", userAgent: ["private-user-agent"], statusCode: 500 },
  ...override,
});
function successSummary(override = {}) {
  return { schema_version: 1, project_id: PROJECT_ID, environment: "production",
    window: { ...WINDOW }, counts: { runtime_error: 1, runtime_fatal: 0, http_5xx: 0, runtime_ok: 0 },
    coverage_started_at: "2026-10-23T13:00:00.000Z", last_delivery_at: "2026-10-23T15:59:59.000Z",
    complete: true, truncated: false, ...override };
}
async function signature(bytes, token = INGEST) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(token),
    { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  return [...new Uint8Array(await crypto.subtle.sign("HMAC", key, bytes))]
    .map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
async function post(events = [fixture()], { token = INGEST, raw, headers = {}, url = URL } = {}) {
  const bytes = raw ?? encoder.encode(JSON.stringify(events));
  return new Request(url, { method: "POST", body: bytes,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json",
      "x-vercel-signature": await signature(bytes, token), ...headers } });
}
function get({ token = READ, query = new URLSearchParams(WINDOW).toString() } = {}) {
  return new Request(`${URL}?${query}`, { headers: { authorization: `Bearer ${token}` } });
}
function backend(response) {
  const calls = [];
  return { calls, rpc: async (name, parameters) => {
    calls.push({ name, parameters });
    if (parameters.p_events === null && response === undefined) {
      return { authorized: true, accepted: false, status: "invalid_batch" };
    }
    if (parameters.p_events?.length === 0 && response === undefined) {
      return { authorized: true, accepted: true, duplicate: false, inserted_events: 0 };
    }
    return response ?? { authorized: true, accepted: true, duplicate: false,
      inserted_events: parameters.p_events.length };
  } };
}
const fakeOidc = async (token) => { if (token !== READ) throw new OidcAuthError(); };
function handler(fake) { return createHandler({ rpc: fake.rpc, now: () => NOW, verifyOidc: fakeOidc }); }
async function status(request, fake = backend()) { return (await handler(fake)(request)).status; }

test("signed official-schema JSON stores only normalized digests, category and timestamp", async () => {
  const fake = backend();
  const response = await handler(fake)(await post());
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { accepted: true });
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(fake.calls.length, 2);
  assert.deepEqual(fake.calls[0].parameters.p_events, []);
  const { name, parameters } = fake.calls[1];
  assert.equal(name, "era_runtime_ingest");
  assert.equal(parameters.p_token_digest, await sha256(INGEST));
  assert.match(parameters.p_delivery_digest, /^[0-9a-f]{64}$/);
  assert.deepEqual(parameters.p_events, [{
    event_key: await sha256([PROJECT_ID, "dpl_fixture", "1573817250283254651097202070"].join("\0")),
    occurred_at: "2026-10-23T15:59:59.000Z", category: "runtime_error",
  }]);
  const forwarded = JSON.stringify(fake.calls);
  for (const privateValue of [INGEST, "private-secret", "must-not-store", "192.0.2.10",
    "private-user-agent", "/users", "dpl_fixture", "1573817250283254651097202070"]) {
    assert.ok(!forwarded.includes(privateValue));
  }
});

test("unsigned, malformed, wrong-body HMAC and malformed Bearer never reach RPC", async () => {
  for (const headers of [{ authorization: "" }, { authorization: "Bearer short" },
    { authorization: `Bearer ${INGEST},${READ}` }, { "x-vercel-signature": "" },
    { "x-vercel-signature": "0".repeat(40) }, { "x-vercel-signature": "not-hex" }]) {
    const fake = backend();
    assert.equal(await status(await post(undefined, { headers }), fake), 401);
    assert.equal(fake.calls.length, 0);
  }
  const old = await post();
  const headers = new Headers(old.headers);
  const altered = new Request(URL, { method: "POST", headers, body: JSON.stringify([fixture({ level: "fatal" })]) });
  const fake = backend();
  assert.equal(await status(altered, fake), 401);
  assert.equal(fake.calls.length, 0);
});

test("a valid HMAC is insufficient with wrong, revoked or wrong-purpose token", async () => {
  for (const request of [await post(undefined, { token: READ }), get({ token: INGEST })]) {
    assert.equal(await status(request, backend({ authorized: false })), 401);
  }
});

test("raw byte cap applies with and without Content-Length; compression refused", async () => {
  const oversized = new Uint8Array(MAX_BODY_BYTES + 1).fill(32);
  for (const headers of [{}, { "content-length": String(MAX_BODY_BYTES + 1) }]) {
    const fake = backend();
    assert.equal(await status(await post(undefined, { raw: oversized, headers }), fake), 413);
    assert.equal(fake.calls.length, 0);
  }
  const compressed = backend();
  assert.equal(await status(await post(undefined, { headers: { "content-encoding": "gzip" } }), compressed), 400);
  assert.equal(compressed.calls[1].parameters.p_events, null);
});

test("mixed wrong-project, environment, source or malformed records reject entire batch", async () => {
  for (const override of [{ projectId: "prj_other" }, { environment: "preview" },
    { environment: undefined }, { source: "build" }, { source: "static" }, { source: "external" },
    { timestamp: NOW - 86_400_001 }, { timestamp: NOW + 60_001 }, { timestamp: "bad" },
    { id: "" }, { deploymentId: "invalid\n" }, { level: "unknown" },
    { statusCode: 0 }, { statusCode: "500" }, { proxy: [] }]) {
    const fake = backend();
    assert.equal(await status(await post([fixture(), fixture(override)]), fake), 400);
    assert.equal(fake.calls.length, 2);
    assert.equal(fake.calls[1].parameters.p_events, null);
    assert.equal(fake.calls[1].parameters.p_token_digest, await sha256(INGEST));
    assert.match(fake.calls[1].parameters.p_delivery_digest, /^[0-9a-f]{64}$/);
  }
});

test("JSON shape, invalid UTF8, empty and event-count caps fail closed", async () => {
  for (const raw of [encoder.encode("{}"), encoder.encode("not JSON"), new Uint8Array([255]),
    encoder.encode("[]"), encoder.encode(JSON.stringify(new Array(MAX_EVENTS + 1).fill({})))]) {
    const fake = backend();
    assert.equal(await status(await post(undefined, { raw }), fake), 400);
    assert.equal(fake.calls.length, 2);
    assert.equal(fake.calls[1].parameters.p_events, null);
  }
});

test("categories are mutually exclusive, capture crash and proxy5xx without raw message", async () => {
  const values = [fixture({ id: "fatal", level: "fatal" }),
    fixture({ id: "crash", level: "info", statusCode: -1 }),
    fixture({ id: "error", level: "error", statusCode: 503 }),
    fixture({ id: "five", level: "info", statusCode: 500 }),
    fixture({ id: "proxy", source: "edge", level: "warning" }),
    fixture({ id: "ok", level: "info", proxy: { statusCode: -1 } })];
  const fake = backend();
  assert.equal(await status(await post(values), fake), 200);
  assert.deepEqual(fake.calls[1].parameters.p_events.map((value) => value.category),
    ["runtime_fatal", "runtime_fatal", "runtime_error", "http_5xx", "http_5xx", "runtime_ok"]);
});

test("fixed authenticated GET returns only approved strict aggregate contract", async () => {
  const fake = backend(successSummary());
  const response = await handler(fake)(get());
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), successSummary());
  assert.deepEqual(fake.calls, [{ name: "era_runtime_summary", parameters: {
    p_since: WINDOW.since, p_until: WINDOW.until,
  } }]);
});

test("GET bounds, duplicate/unknown query fields, noncanonical dates fail before RPC", async () => {
  const invalid = ["", new URLSearchParams({ ...WINDOW, extra: "x" }).toString(),
    new URLSearchParams({ ...WINDOW, since: "2026-10-23T12:00:00.000Z" }).toString(),
    new URLSearchParams({ ...WINDOW, since: "2026-10-22T15:59:59.999Z" }).toString(),
    new URLSearchParams({ ...WINDOW, until: "2026-10-23T16:01:00.001Z" }).toString(),
    new URLSearchParams({ ...WINDOW, since: WINDOW.until }).toString(),
    new URLSearchParams({ ...WINDOW, until: "2026-10-23T16:00:00+00:00" }).toString(),
    new URLSearchParams(WINDOW).toString() + "&since=" + WINDOW.since,
    new URLSearchParams({ ...WINDOW, since: "2026-02-30T15:00:00.000Z" }).toString()];
  for (const query of invalid) {
    const fake = backend();
    assert.equal(await status(get({ query }), fake), 400);
    assert.equal(fake.calls.length, 0);
  }
});

test("RPC summaries reject extra private fields and invalid aggregate types", async () => {
  for (const value of [successSummary({ raw: "private" }),
    successSummary({ counts: { ...successSummary().counts, runtime_error: -1 } }),
    successSummary({ counts: { ...successSummary().counts, runtime_error: "1" } }),
    successSummary({ complete: "true" }), successSummary({ project_id: "prj_other" }),
    successSummary({ last_delivery_at: "private" }), successSummary({ window: { ...WINDOW, secret: "private" } })]) {
    const response = await handler(backend(value))(get());
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: "request_refused" });
  }
});

test("retry after commit-response failure and replay never double count or refresh heartbeat", async () => {
  const keys = new Set();
  let heartbeat = 0;
  let loseResponse = true;
  const rpc = async (_name, parameters) => {
    if (parameters.p_events.length === 0) {
      return { authorized: true, accepted: true, duplicate: false, inserted_events: 0 };
    }
    let inserted = 0;
    for (const event of parameters.p_events) {
      if (!keys.has(event.event_key)) { keys.add(event.event_key); inserted++; }
    }
    if (inserted) heartbeat++;
    if (loseResponse) { loseResponse = false; throw new Error("private backend error"); }
    return { authorized: true, accepted: true, duplicate: inserted === 0, inserted_events: inserted };
  };
  const run = createHandler({ rpc, now: () => NOW, verifyOidc: fakeOidc });
  assert.equal((await run(await post())).status, 503);
  assert.equal((await run(await post())).status, 200);
  // Same event in a differently serialized delivery also stays deduplicated.
  assert.equal((await run(await post(undefined, { raw: encoder.encode(JSON.stringify([fixture()], null, 2)) }))).status, 200);
  assert.equal(keys.size, 1);
  assert.equal(heartbeat, 1);
});

test("repeated identical logIDs within batch deduplicate; conflicting classification refuses", async () => {
  const fake = backend();
  assert.equal(await status(await post([fixture(), fixture()]), fake), 200);
  assert.equal(fake.calls[1].parameters.p_events.length, 1);
  const conflict = backend();
  assert.equal(await status(await post([fixture(), fixture({ level: "fatal" })]), conflict), 400);
  assert.equal(conflict.calls.length, 2);
  assert.equal(conflict.calls[1].parameters.p_events, null);
});

test("authenticated malformed batch latches only through authorized SQL; no false heartbeat or raw forwarding", async () => {
  let latched = false;
  let heartbeat = 0;
  const digest = await sha256(INGEST);
  const rpc = async (_name, parameters) => {
    if (parameters.p_token_digest !== digest) return { authorized: false };
    if (parameters.p_events?.length === 0) {
      return { authorized: true, accepted: true, duplicate: false, inserted_events: 0 };
    }
    if (parameters.p_events === null) {
      latched = true;
      return { authorized: true, accepted: false, status: "invalid_batch" };
    }
    heartbeat++;
    return { authorized: true, accepted: true, duplicate: false, inserted_events: 1 };
  };
  const run = createHandler({ rpc, now: () => NOW, verifyOidc: fakeOidc });
  assert.equal((await run(await post([fixture({ projectId: "prj_other" })], { token: READ }))).status, 401);
  assert.equal(latched, false);
  assert.equal(heartbeat, 0);
  assert.equal((await run(await post([fixture({ projectId: "prj_other" })]))).status, 400);
  assert.equal(latched, true);
  assert.equal(heartbeat, 0);
  // Failed latch/storage calls are retryable, never acknowledged as a clean feed.
  assert.equal(await status(await post([], {}), { rpc: async () => { throw new Error("private"); } }), 503);
  assert.equal(await status(await post([], {}), backend({ authorized: true, accepted: true })), 503);
});

test("unknown key fails cheap fixed probe before even invalid JSON can be normalized", async () => {
  const fake = backend({ authorized: false });
  const response = await handler(fake)(await post(undefined, { raw: encoder.encode("invalid private JSON") }));
  assert.equal(response.status, 401);
  assert.equal(fake.calls.length, 1);
  assert.deepEqual(fake.calls[0].parameters.p_events, []);
  assert.ok(!JSON.stringify(fake.calls).includes("private"));
  const malformed = backend({ authorized: true, accepted: true, duplicate: false, inserted_events: 1 });
  assert.equal(await status(await post(), malformed), 503);
  assert.equal(malformed.calls.length, 1);
});

test("database failures and capacity never acknowledge silently or expose errors", async () => {
  for (const fake of [backend({ authorized: true, accepted: false, status: "capacity_exceeded" }),
    backend({ accepted: true }), { rpc: async () => { throw new Error(`private ${INGEST}`); } }]) {
    const response = await handler(fake)(await post());
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: "request_refused" });
  }
  const invalid = { rpc: async (_name, parameters) => parameters.p_events.length === 0
    ? { authorized: true, accepted: true, duplicate: false, inserted_events: 0 }
    : { authorized: true, accepted: false, status: "invalid_batch" } };
  assert.equal(await status(await post(), invalid), 400);
});

test("backend credential never follows caller URL, token or RPC name", async () => {
  const requests = [];
  const rpc = createRpc({ url: SUPABASE_ORIGIN, key: "sb_secret_fixture", fetcher: async (url, options) => {
    requests.push({ url, options });
    return Response.json({ authorized: false });
  } });
  await assert.rejects(() => rpc("another_rpc", {}));
  assert.equal(requests.length, 0);
  assert.throws(() => createRpc({ url: "https://example.com", key: "secret" }));
  await rpc("era_runtime_summary", { p_token_digest: "d".repeat(64), ...WINDOW });
  assert.equal(requests[0].url, `${SUPABASE_ORIGIN}/rest/v1/rpc/era_runtime_summary`);
  assert.equal(requests[0].options.method, "POST");
  assert.equal(requests[0].options.redirect, "error");
  assert.equal(requests[0].options.headers.apikey, "sb_secret_fixture");
  assert.equal(requests[0].options.headers.Authorization, undefined);
  assert.ok(!JSON.stringify(requests).includes(INGEST));
});

test("legacy backend key is server-only and explicit, no caller Authorization forwarding", async () => {
  let captured;
  const rpc = createRpc({ url: SUPABASE_ORIGIN, key: "legacy.fixture.key", legacy: true,
    fetcher: async (_url, options) => { captured = options; return Response.json({ authorized: false }); } });
  await rpc("era_runtime_ingest", {});
  assert.equal(captured.headers.Authorization, "Bearer legacy.fixture.key");
  assert.equal(captured.headers.apikey, "legacy.fixture.key");
});

test("backend errors, malformed body and oversized body are generic503; errorbody unread", async () => {
  let read = false;
  const rejected = createRpc({ url: SUPABASE_ORIGIN, key: "fixture", fetcher: async () => ({
    status: 503, ok: false, headers: new Headers(), body: null,
    text: () => { read = true; throw new Error("private"); },
  }) });
  const response = await createHandler({ rpc: rejected, now: () => NOW, verifyOidc: fakeOidc })(get());
  assert.equal(response.status, 503);
  assert.equal(read, false);
  for (const body of ["notjson private", " ".repeat(65_537)]) {
    const rpc = createRpc({ url: SUPABASE_ORIGIN, key: "fixture", fetcher: async () =>
      new Response(body, { headers: { "Content-Type": "application/json" } }) });
    assert.equal((await createHandler({ rpc, now: () => NOW, verifyOidc: fakeOidc })(get())).status, 503);
  }
});

test("all other methods/routes denied and isolated manifest disables only new JWT gate", async () => {
  const fake = backend();
  assert.equal(await status(new Request(URL, { method: "OPTIONS" }), fake), 405);
  assert.equal(await status(new Request(URL + "/other"), fake), 404);
  assert.equal(fake.calls.length, 0);
  const config = await readFile(new globalThis.URL("./supabase/config.toml", import.meta.url), "utf8");
  assert.match(config, /\[functions\.era-runtime\]/);
  assert.match(config, /verify_jwt = false/);
  assert.equal((config.match(/\[functions\./g) || []).length, 1);
});
