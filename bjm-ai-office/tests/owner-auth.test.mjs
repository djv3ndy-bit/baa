import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const auth = fs.readFileSync(new URL('../server/auth.ts', import.meta.url), 'utf8');
const api = fs.readFileSync(new URL('../api/mcp.ts', import.meta.url), 'utf8');
const server = fs.readFileSync(new URL('../server/index.ts', import.meta.url), 'utf8');
const providers = fs.readFileSync(new URL('../server/providers.ts', import.meta.url), 'utf8');

test('MCP routes enforce owner auth before creating the MCP server', () => {
  for (const source of [api, server]) {
    const authIndex = source.indexOf('requireOwnerAuth(req, res)');
    const serverIndex = source.indexOf('createOfficeMcpServer()');
    assert.ok(authIndex >= 0);
    assert.ok(serverIndex > authIndex);
  }
});

test('owner auth fails closed and uses constant-time token comparison', () => {
  assert.match(auth, /BJM_AI_OFFICE_OWNER_TOKEN/);
  assert.match(auth, /status:\s*503/);
  assert.match(auth, /status:\s*401/);
  assert.match(auth, /timingSafeEqual/);
  assert.match(auth, /WWW-Authenticate/);
});

test('no owner token is hardcoded in source', () => {
  assert.doesNotMatch(auth, /BJM_AI_OFFICE_OWNER_TOKEN\s*=\s*['"][^'"]+/);
});

test('role metrics use the canonical profiles table', () => {
  assert.match(providers, /count\('profiles',\s*'role=eq\.cafe_owner_manager/);
  assert.match(providers, /count\('profiles',\s*'role=eq\.barista/);
  assert.doesNotMatch(providers, /count\('cafe_profiles'/);
  assert.doesNotMatch(providers, /count\('barista_profiles'/);
});
