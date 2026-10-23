import test from "node:test";
import assert from "node:assert/strict";
import { createOidcVerifier, OidcAuthError, ISSUER, JWKS_URL, AUDIENCE, SUBJECT,
  WORKFLOW } from "./supabase/functions/era-runtime/oidc.mjs";
import { createHandler } from "./supabase/functions/era-runtime/receiver.mjs";

// Ephemeral offline test key only; nothing is persisted or used as a credential.
const pair = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", hash: "SHA-256",
  modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) }, true, ["sign", "verify"]);
const publicJwk = { ...await crypto.subtle.exportKey("jwk", pair.publicKey), kid: "fixture-key",
  alg: "RS256", use: "sig" };
const NOW = Date.parse("2026-10-23T16:00:00.000Z");
const seconds = NOW / 1000;
const encoder = new TextEncoder();
function encoded(value) {
  const bytes = typeof value === "string" ? encoder.encode(value) : value;
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
function claims(override = {}) {
  return { iss: ISSUER, aud: AUDIENCE, sub: SUBJECT, repository: "djv3ndy-bit/baa",
    repository_id: "1324630119", repository_owner_id: "313253306", workflow_ref: WORKFLOW,
    ref: "refs/heads/main", ref_type: "branch", exp: seconds + 300, nbf: seconds - 60,
    iat: seconds - 10, ...override };
}
async function jwt(payload = claims(), header = { alg: "RS256", typ: "JWT", kid: "fixture-key" }) {
  const input = `${encoded(typeof header === "string" ? header : JSON.stringify(header))}.` +
    encoded(typeof payload === "string" ? payload : JSON.stringify(payload));
  const signature = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, encoder.encode(input)));
  return `${input}.${encoded(signature)}`;
}
function source({ response = () => Response.json({ keys: [publicJwk] }), now = () => NOW } = {}) {
  const calls = [];
  const verify = createOidcVerifier({ now, fetcher: async (url, options) => {
    calls.push({ url, options }); return response();
  } });
  return { calls, verify };
}

test("genuine signed fixture requires exact immutable repository/workflow/audience and fixed JWKS", async () => {
  const fake = source();
  assert.equal(await fake.verify(await jwt()), true);
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0].url, JWKS_URL);
  assert.equal(fake.calls[0].options.method, "GET");
  assert.equal(fake.calls[0].options.redirect, "error");
  assert.equal(fake.calls[0].options.headers.Authorization, undefined);
  assert.equal(fake.calls[0].options.headers.Accept, "application/json");
  assert.ok(fake.calls[0].options.signal instanceof AbortSignal);
});

test("wrong audience, repo, immutable IDs, ref, workflow, issuer and legacy sub fail before fetch", async () => {
  for (const value of [
    { iss: "https://evil.example" }, { aud: "https://other.example" }, { aud: [AUDIENCE] },
    { sub: "repo:djv3ndy-bit/baa:ref:refs/heads/main" }, { repository: "attacker/baa" },
    { repository_id: "1324630120" }, { repository_owner_id: "313253307" },
    { repository_id: 1324630119 }, { ref: "refs/heads/feature" }, { ref_type: "tag" },
    { workflow_ref: "djv3ndy-bit/baa/.github/workflows/other.yml@refs/heads/main" },
    { workflow_ref: WORKFLOW.replace("@refs/heads/main", "@refs/heads/feature") },
  ]) {
    const fake = source();
    const token = await jwt(claims(value));
    await assert.rejects(() => fake.verify(token), OidcAuthError);
    assert.equal(fake.calls.length, 0);
  }
});

test("expired, future, missing, noninteger and over10minute identity times fail before fetch", async () => {
  for (const value of [{ exp: seconds }, { nbf: seconds + 31 }, { iat: seconds + 31 },
    { exp: seconds + 601, iat: seconds }, { iat: seconds - 601 }, { nbf: undefined },
    { exp: String(seconds + 10) }, { exp: seconds + 0.5 }, { iat: seconds + 400 },
    { nbf: seconds - 700 }]) {
    const fake = source();
    const token = await jwt(claims(value));
    await assert.rejects(() => fake.verify(token), OidcAuthError);
    assert.equal(fake.calls.length, 0);
  }
});

test("untrusted algorithm/key URLs/criticalheader and malformed segments fail without network", async () => {
  const good = await jwt();
  for (const token of ["", "a.b.c.d", "a.b.c", good + "=", good.replace(".", "=."),
    "a".repeat(16_385), `!${good}`]) {
    const fake = source();
    await assert.rejects(() => fake.verify(token), OidcAuthError);
    assert.equal(fake.calls.length, 0);
  }
  for (const header of [{ alg: "none" }, { alg: "HS256" }, { kid: "" }, { kid: "x".repeat(129) },
    { jku: "https://evil.example" }, { jwk: publicJwk }, { x5u: "https://evil.example" }, { crit: [] }]) {
    const fake = source();
    const token = await jwt(claims(), { alg: "RS256", typ: "JWT", kid: "fixture-key", ...header });
    await assert.rejects(() => fake.verify(token), OidcAuthError);
    assert.equal(fake.calls.length, 0);
  }
});

test("duplicate JSON claims including escaped names are rejected before JWKS", async () => {
  const body = JSON.stringify(claims());
  for (const payload of [body.replace('"iss":', '"iss":"ignored","iss":'),
    body.replace('"aud":', '"a\\u0075d":"ignored","aud":'),
    body.replace('"iat":', '"nested":{"key":1,"key":2},"iat":')]) {
    const fake = source();
    const token = await jwt(payload);
    await assert.rejects(() => fake.verify(token), OidcAuthError);
    assert.equal(fake.calls.length, 0);
  }
  const fake = source();
  const token = await jwt(claims(), '{"alg":"none","alg":"RS256","typ":"JWT","kid":"fixture-key"}');
  await assert.rejects(() => fake.verify(token), OidcAuthError);
  assert.equal(fake.calls.length, 0);
});

test("bad signature and unknown key id are rejected, cached keys avoid refetch storms", async () => {
  const fake = source();
  const good = await jwt();
  assert.equal(await fake.verify(good), true);
  const segments = good.split(".");
  const bad = new Uint8Array(256);
  segments[2] = encoded(bad);
  await assert.rejects(() => fake.verify(segments.join(".")), OidcAuthError);
  const unknown = await jwt(claims(), { alg: "RS256", typ: "JWT", kid: "unknown-key" });
  await assert.rejects(() => fake.verify(unknown), OidcAuthError);
  assert.equal(fake.calls.length, 1);
});

test("JWKS cache expires after5minutes and concurrent valid reads share one fetch", async () => {
  let current = NOW;
  const fake = source({ now: () => current });
  const token = await jwt();
  assert.deepEqual(await Promise.all([fake.verify(token), fake.verify(token)]), [true, true]);
  assert.equal(fake.calls.length, 1);
  current += 300_000;
  const fresh = await jwt(claims({ exp: seconds + 600, iat: seconds + 290, nbf: seconds + 290 }));
  assert.equal(await fake.verify(fresh), true);
  assert.equal(fake.calls.length, 2);
});

test("unavailable, oversized or ambiguous JWKS fails closed with no RPC", async () => {
  for (const response of [() => new Response("private", { status: 503 }),
    () => new Response("{}", { headers: { "Content-Type": "text/html" } }),
    () => new Response("not-json private", { headers: { "Content-Type": "application/json" } }),
    () => Response.json({ keys: [publicJwk, publicJwk] }),
    () => Response.json({ keys: [] }), () => Response.json({ keys: [{ ...publicJwk, kty: "EC" }] }),
    () => Response.json({ keys: [{ ...publicJwk, d: "private" }] }),
    () => Response.json({ keys: [{ ...publicJwk, n: "invalid-base64!" }] }),
    () => new Response(" ".repeat(65_537), { headers: { "Content-Type": "application/json" } }),
  ]) {
    const fake = source({ response });
    let calls = 0;
    const handler = createHandler({ now: () => NOW, verifyOidc: fake.verify,
      rpc: async () => { calls++; return {}; } });
    const token = await jwt();
    const result = await handler(new Request(AUDIENCE + "?since=2026-10-23T15:00:00.000Z&until=2026-10-23T16:00:00.000Z",
      { headers: { Authorization: `Bearer ${token}` } }));
    assert.equal(result.status, 503);
    assert.deepEqual(await result.json(), { error: "request_refused" });
    assert.equal(calls, 0);
  }
});

test("verified JWT is never forwarded to database; invalid JWT returns401", async () => {
  const fake = source();
  const token = await jwt();
  const captured = [];
  const handler = createHandler({ now: () => NOW, verifyOidc: fake.verify,
    rpc: async (name, params) => { captured.push({ name, params }); return { status: "invalid_window" }; } });
  const url = AUDIENCE + "?since=2026-10-23T15:00:00.000Z&until=2026-10-23T16:00:00.000Z";
  assert.equal((await handler(new Request(url, { headers: { Authorization: `Bearer ${token}` } }))).status, 400);
  assert.deepEqual(captured, [{ name: "era_runtime_summary", params: {
    p_since: "2026-10-23T15:00:00.000Z", p_until: "2026-10-23T16:00:00.000Z" } }]);
  assert.ok(!JSON.stringify(captured).includes(token));
  assert.equal((await handler(new Request(url, { headers: { Authorization: "Bearer invalid" } }))).status, 401);
});
