import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { serializers as postgresSerializers } from '../node_modules/postgres/src/types.js';
import { chatDatabaseConfiguration, createChatStore } from '../server/chat-store.mjs';

const project = 'lmwqrxoitraofaftpwhe';
const password = 'x'.repeat(43);
const host = 'aws-0-us-east-1.pooler.supabase.com';
const env = {
  SUPABASE_URL: `https://${project}.supabase.co`, BJM_CHAT_DATABASE_HOST: host,
  BJM_CHAT_DATABASE_URL: `postgres://bjm_office_gateway_login.${project}:${password}@${host}:6543/postgres`,
};

test('report transport pins the dedicated role, verified TLS and small transaction pool', () => {
  const config = chatDatabaseConfiguration(env);
  assert.equal(config.username, `bjm_office_gateway_login.${project}`);
  assert.equal(config.ssl.rejectUnauthorized, true);
  assert.equal(config.prepare, false);
  assert.equal(config.max, 1);
  assert.equal(config.debug, false);
  assert.equal(config.connect_timeout, 5);
});
test('admin roles, other destinations and insecure URL options are rejected before network use', () => {
  for (const changed of [
    { BJM_CHAT_DATABASE_URL: env.BJM_CHAT_DATABASE_URL.replace('bjm_office_gateway_login.', 'postgres.') },
    { BJM_CHAT_DATABASE_URL: env.BJM_CHAT_DATABASE_URL.replace(host, 'attacker.example') },
    { BJM_CHAT_DATABASE_HOST: 'attacker.example' },
    { BJM_CHAT_DATABASE_URL: env.BJM_CHAT_DATABASE_URL + '?sslmode=disable' },
    { BJM_CHAT_DATABASE_URL: env.BJM_CHAT_DATABASE_URL.replace(':6543', ':5432') },
    { BJM_CHAT_DATABASE_URL: env.BJM_CHAT_DATABASE_URL.replace(password, 'short') },
    { SUPABASE_SECRET_KEY: 'fixture-secret-key' },
    { SUPABASE_SERVICE_ROLE_KEY: 'fixture-service-role' },
    { BJM_CHAT_DATABASE_CA_PEM: '-----BEGIN PRIVATE KEY----- fixture -----END PRIVATE KEY-----' },
  ]) assert.throws(() => chatDatabaseConfiguration({ ...env, ...changed }), /^Error: Office reporting storage is unavailable$/);
});
test('SQL uses only fixed entrypoints and separately bound JSON/identity values', async () => {
  const calls = [];
  const store = createChatStore(env, { sqlFactory: () => ({ unsafe: async (query, params) => { calls.push({ query, params }); return [{ result: { ok: true } }]; }, end: async () => {} }) });
  const value = { payload: "'); select * from auth.users; --" };
  await store('create_flow', value);
  await store.snapshot('a'.repeat(64), 'fixture-client', 'https://office.example/mcp');
  assert.equal(calls[0].query, 'select bjm_office_gateway.auth_dispatch($1::text, $2::text::jsonb) as result');
  assert.equal(calls[0].query.includes(value.payload), false);
  assert.deepEqual(calls[0].params, ['create_flow', JSON.stringify(value)]);
  assert.equal(calls[1].query, 'select bjm_office_gateway.read_snapshot($1::text, $2::text, $3::text) as result');
  await assert.rejects(store('arbitrary_sql', {}));
  await assert.rejects(store.snapshot('not-a-hash', 'fixture-client', 'https://office.example/mcp'));
  assert.equal(calls.length, 2);
  await store.close();
});
test('pinned Postgres.js serializers deliver bounded JSON as an object rather than a twice-encoded JSONB string', async () => {
  const db = await PGlite.create();
  let store;
  try {
    await db.exec(`create schema bjm_office_gateway;
      create function bjm_office_gateway.auth_dispatch(op text, args jsonb) returns jsonb language sql as $$
        select case when jsonb_typeof(args)='object' then args else null end
      $$;`);
    const value = { flowHash: 'a'.repeat(64), encryptedPayload: 'fixture "quoted" \\ slash\nline café' };
    const oldQuery = 'select bjm_office_gateway.auth_dispatch($1::text, $2::jsonb) as result';
    const oldDescription = await db.describeQuery(oldQuery);
    assert.deepEqual(oldDescription.queryParams.map(p => p.dataTypeID), [25, 3802]);
    // PGlite obtains real PostgreSQL parameter OIDs; the installed Postgres.js
    // serializers reproduce its Describe/Bind behavior without any network.
    assert.equal((await db.query(oldQuery, ['create_flow', JSON.stringify(value)], { serializers: postgresSerializers })).rows[0].result, null);
    store = createChatStore(env, { sqlFactory: () => ({
      unsafe: async (query, params) => {
        assert.deepEqual((await db.describeQuery(query)).queryParams.map(p => p.dataTypeID), [25, 25]);
        return (await db.query(query, params, { serializers: postgresSerializers })).rows;
      },
      end: async () => {},
    }) });
    assert.deepEqual(await store('create_flow', value), value);
  } finally {
    await store?.close();
    await db.close();
  }
});
test('invalid refresh null commits normally and database errors expose no secret or input', async () => {
  let outcome = null;
  const store = createChatStore(env, { sqlFactory: () => ({ unsafe: async () => { if (outcome instanceof Error) throw outcome; return [{ result: outcome }]; }, end: async () => {} }) });
  assert.equal(await store('refresh', { refreshHash: 'b'.repeat(64) }), null);
  outcome = new Error(`password=${password} private database details`);
  await assert.rejects(store('verify', {}), error => error.message === 'Office reporting storage is unavailable' && !error.message.includes(password) && error.cause === undefined);
  await store.close();
  await assert.rejects(store('verify', {}));
});
test('oversized or malformed store envelopes and results are stopped', async () => {
  let result = { ok: true };
  let calls = 0;
  const store = createChatStore(env, { sqlFactory: () => ({ unsafe: async () => { calls++; return [{ result }]; }, end: async () => {} }) });
  await assert.rejects(store('create_flow', { encryptedPayload: 'x'.repeat(40000) }));
  assert.equal(calls, 0);
  result = { payload: 'x'.repeat(40000) };
  await assert.rejects(store('verify', {}));
  result = 'unexpected scalar';
  await assert.rejects(store('verify', {}));
  await store.close();
});
