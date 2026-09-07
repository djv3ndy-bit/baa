import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from '../mobile/node_modules/typescript/lib/typescript.js';

function load(file, mocks = {}, globals = {}) {
  const module = { exports: {} };
  const code = ts.transpileModule(readFileSync(new URL(`../mobile/lib/${file}`, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(code, { module, exports: module.exports, require: name => { if (!(name in mocks)) throw new Error(name); return mocks[name]; }, process: { env: {} }, URL, AbortController, setTimeout, clearTimeout, ...globals });
  return module.exports;
}
const session = { access_token: 'test-token', user: { id: 'account-a' } };

test('native API refuses account switches and session read failures before a request', async () => {
  let current = { data: { session }, error: null }, requests = 0;
  const api = load('api.ts', { './supabase': { supabase: { auth: { getSession: async () => current } } }, './request': { requestJson: async () => { requests++; } } });
  await assert.rejects(api.authenticatedApi('/delete-account', {}, 'POST', 'account-b'), /account changed/);
  current = { data: { session }, error: new Error('Session unavailable') };
  await assert.rejects(api.authenticatedApi('/delete-account', {}, 'POST', 'account-a'), /Session unavailable/);
  current = { data: { session: null }, error: null };
  await assert.rejects(api.authenticatedApi('/delete-account', {}, 'POST', 'account-a'), /expired/);
  assert.equal(requests, 0);
});
test('native API uses the captured account token and configured method', async () => {
  const calls = [];
  const api = load('api.ts', { './supabase': { supabase: { auth: { getSession: async () => ({ data: { session }, error: null }) } } }, './request': { requestJson: async (...args) => { calls.push(args); return { success: true }; } } });
  assert.equal((await api.authenticatedApi('/delete-account', { confirmation: 'DELETE' }, 'POST', 'account-a')).success, true);
  assert.equal(calls[0][1].headers.Authorization, 'Bearer test-token');
  assert.equal(JSON.parse(calls[0][1].body).confirmation, 'DELETE');
  await api.authenticatedApi('/billing-status', {}, 'GET', 'account-a');
  assert.equal(calls[1][1].body, undefined);
});
test('native network timeout also cancels a stalled response body', async () => {
  const { requestJson } = load('request.ts', {}, { fetch: async (_url, options) => ({ ok: true, status: 200, json: () => new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted')))) }) });
  await assert.rejects(requestJson('https://example.invalid', {}, 5), /too long/);
});
test('native API recovers from unreadable responses and preserves server error messages', async () => {
  const malformed = load('request.ts', {}, { fetch: async () => ({ ok: true, status: 200, json: async () => { throw new Error('HTML'); } }) });
  await assert.rejects(malformed.requestJson('https://example.invalid', {}), /unreadable response/);
  const denied = load('request.ts', {}, { fetch: async () => ({ ok: false, status: 403, json: async () => ({ error: 'Conversation unavailable' }) }) });
  await assert.rejects(denied.requestJson('https://example.invalid', {}), /Conversation unavailable/);
  const empty = load('request.ts', {}, { fetch: async () => ({ ok: true, status: 204 }) });
  assert.equal(await empty.requestJson('https://example.invalid', {}), undefined);
});

test('password updates bind the HTTP request to the reviewed account token', async () => {
  const calls = [];
  let current = session;
  const api = load('api.ts', { './supabase': { AUTH_API_BASE: 'https://example.invalid/auth/v1', SUPABASE_PUBLIC_KEY: 'public-test-key', supabase: { auth: { getSession: async () => { const captured = current; current = { access_token:'account-b-token',user:{id:'account-b'} }; return { data: { session: captured }, error: null }; } } } }, './request': { requestJson: async (...args) => { calls.push(args); return {}; } } });
  await api.updateAccountPassword('account-a', 'my-test-password');
  assert.equal(calls[0][0], 'https://example.invalid/auth/v1/user');
  assert.equal(calls[0][1].method, 'PUT');
  assert.equal(calls[0][1].headers.Authorization, 'Bearer test-token');
  await assert.rejects(api.updateAccountPassword('account-a','another-password'), /account changed/);
  assert.equal(calls.length, 1);
});
