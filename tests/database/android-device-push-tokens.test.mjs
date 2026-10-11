import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, afterEach, before, beforeEach, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';

const source = path => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
const artifact = source('server/android-push/sql/android_fcm_tokens.sql');
const a = '00000000-0000-4000-8000-000000000001';
const b = '00000000-0000-4000-8000-000000000002';
const missing = '00000000-0000-4000-8000-000000000003';
const table = 'public.android_device_push_tokens';
const nativeConfiguration = source('review/native-checkout-coordination.sql')
  .split('create table private.native_checkout_attempts')[0];
const fixture = `
  create role anon;
  create role authenticated;
  create role service_role bypassrls;
  create role unrelated_user;
  create schema auth;
  create schema private;
  grant usage on schema public, auth to anon, authenticated, service_role;
  create function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
  $$;
  create table auth.users(id uuid primary key);
  alter table auth.users enable row level security;
  insert into auth.users values ('${a}'), ('${b}');
  alter default privileges in schema public
    grant all on tables to public, anon, authenticated, service_role;
  ${source('supabase/migrations/202608290001_add_device_push_tokens.sql')}
  insert into public.device_push_tokens(expo_push_token,user_id,platform)
    values ('ExpoPushToken[unchanged]', '${a}', 'ios');
  create publication supabase_realtime for table public.device_push_tokens;
  ${nativeConfiguration}
  update private.native_billing_configuration set environment='Sandbox';
`;

let db, preserved;
const query = (sql, params = []) => db.query(sql, params);
const scalar = async (sql, params = []) => Object.values((await query(sql, params)).rows[0])[0];
async function asUser(id, role = 'authenticated') {
  await db.exec('reset role');
  await query("select set_config('request.jwt.claim.sub',$1,true)", [id || '']);
  await db.exec(`set local role ${role}`);
}
async function rejected(sql, params = [], code = '42501') {
  await db.exec('savepoint denied');
  try { await assert.rejects(query(sql, params), error => error.code === code); }
  finally { await db.exec('rollback to savepoint denied; release savepoint denied'); }
}
async function baselineSnapshot(database) {
  const statements = [
    `select defaclrole,defaclnamespace,defaclobjtype,defaclacl::text
       from pg_default_acl order by defaclrole,defaclnamespace,defaclobjtype`,
    `select oid,relname,relrowsecurity,relacl::text from pg_class
       where oid in ('public.device_push_tokens'::regclass,'auth.users'::regclass,
         'private.native_billing_configuration'::regclass) order by oid`,
    `select attrelid,attname,atttypid,attnotnull,attacl::text from pg_attribute
       where attrelid in ('public.device_push_tokens'::regclass,'auth.users'::regclass)
         and attnum>0 order by attrelid,attnum`,
    `select conrelid,conname,pg_get_constraintdef(oid) as definition from pg_constraint
       where conrelid in ('public.device_push_tokens'::regclass,'auth.users'::regclass)
       order by conrelid,conname`,
    `select * from pg_policies where tablename in ('device_push_tokens','users',
         'native_billing_configuration') order by schemaname,tablename,policyname`,
    `select pubname,schemaname,tablename from pg_publication_tables
       order by pubname,schemaname,tablename`,
    `select * from public.device_push_tokens order by expo_push_token`,
    `select * from private.native_billing_configuration`,
    `select * from auth.users order by id`,
  ];
  const result = [];
  for (const sql of statements) result.push((await database.query(sql)).rows);
  return result;
}

before(async () => {
  db = new PGlite();
  await db.exec(fixture);
  preserved = await baselineSnapshot(db);
  await db.exec(artifact);
});
beforeEach(() => db.exec('begin'));
afterEach(() => db.exec('rollback'));
after(() => db?.close());

test('existing Expo, managed Auth, Sandbox configuration, publications and default privileges are unchanged', async () => {
  assert.deepEqual(await baselineSnapshot(db), preserved);
  assert.equal(await scalar('select count(*)::int from public.android_device_push_tokens'), 0);
  const policies = (await query(`select cmd,roles,qual,with_check from pg_policies
    where schemaname='public' and tablename='android_device_push_tokens' order by cmd`)).rows;
  assert.deepEqual(policies.map(row => row.cmd), ['DELETE', 'INSERT', 'SELECT', 'UPDATE']);
  assert.ok(policies.every(row => row.roles.length === 1 && row.roles[0] === 'authenticated'));
  assert.ok(policies.every(row => /SELECT auth\.uid/.test(row.qual || row.with_check)));
  assert.ok(policies.find(row => row.cmd === 'UPDATE').with_check);
  assert.equal(await scalar(`select relrowsecurity from pg_class where oid='${table}'::regclass`), true);
  assert.equal(await scalar(`select has_function_privilege('authenticated',
    'private.android_device_push_tokens_touch()','EXECUTE')`), false);
});

test('authenticated account can register, read, upsert, disable and delete its own opaque token', async () => {
  await asUser(a);
  const token = 'opaque/a:+=.!~[]';
  await query(`insert into ${table}(fcm_token,user_id) values($1,$2)`, [token, a]);
  const row = (await query(`select * from ${table}`)).rows[0];
  assert.equal(row.fcm_token, token);
  assert.equal(row.platform, 'android');
  assert.equal(row.firebase_project_id, 'baristamatch');
  assert.equal(row.package_name, 'com.baristajobmatch.app');
  assert.equal(row.enabled, true);
  await query(`insert into ${table}(fcm_token,user_id,enabled) values($1,$2,false)
    on conflict(fcm_token) do update set user_id=excluded.user_id,enabled=excluded.enabled`, [token, a]);
  assert.equal(await scalar(`select enabled from ${table}`), false);
  assert.equal((await query(`delete from ${table} where fcm_token=$1 returning fcm_token`, [token])).rows.length, 1);
});

test('cross-account reads/writes, token takeover by upsert and ownership transfer are denied', async () => {
  await asUser(b);
  await query(`insert into ${table}(fcm_token,user_id) values('owned-by-b',$1)`, [b]);
  await asUser(a);
  assert.deepEqual((await query(`select * from ${table}`)).rows, []);
  assert.equal((await query(`update ${table} set enabled=false returning fcm_token`)).rows.length, 0);
  assert.equal((await query(`delete from ${table} returning fcm_token`)).rows.length, 0);
  await rejected(`insert into ${table}(fcm_token,user_id) values('forged-b',$1)`, [b]);
  await rejected(`insert into ${table}(fcm_token,user_id) values('owned-by-b',$1)
    on conflict(fcm_token) do update set user_id=excluded.user_id,enabled=true`, [a]);
  await query(`insert into ${table}(fcm_token,user_id) values('owned-by-a',$1)`, [a]);
  await rejected(`update ${table} set user_id=$1 where fcm_token='owned-by-a'`, [b]);
  await asUser(b);
  assert.deepEqual((await query(`select fcm_token,user_id,enabled from ${table}`)).rows,
    [{ fcm_token: 'owned-by-b', user_id: b, enabled: true }]);
});

test('null-subject, anon and roles with only PUBLIC membership cannot access tokens', async () => {
  await asUser(a);
  await query(`insert into ${table}(fcm_token,user_id) values('private-token',$1)`, [a]);
  await asUser(null);
  assert.deepEqual((await query(`select * from ${table}`)).rows, []);
  assert.equal((await query(`update ${table} set enabled=false returning fcm_token`)).rows.length, 0);
  assert.equal((await query(`delete from ${table} returning fcm_token`)).rows.length, 0);
  await rejected(`insert into ${table}(fcm_token,user_id) values('no-session',$1)`, [a]);
  for (const role of ['anon', 'unrelated_user']) {
    await asUser(a, role);
    await rejected(`select * from ${table}`);
    await rejected(`insert into ${table}(fcm_token,user_id) values('anonymous',$1)`, [a]);
    await rejected(`update ${table} set enabled=false`);
    await rejected(`delete from ${table}`);
  }
});

test('platform, Firebase project and package must remain the approved Android values', async () => {
  await asUser(a);
  const fields = [
    ['platform', 'ios'],
    ['firebase_project_id', 'unrelated-project'],
    ['package_name', 'com.unrelated.app'],
  ];
  for (const [field, value] of fields) {
    await rejected(`insert into ${table}(fcm_token,user_id,${field}) values($1,$2,$3)`,
      [`wrong-${field}`, a, value], '23514');
  }
  await query(`insert into ${table}(fcm_token,user_id) values('valid-target',$1)`, [a]);
  for (const [field, value] of fields) await rejected(`update ${table} set ${field}=$1`, [value], '23514');
});

test('opaque token validation rejects empty, whitespace, control and oversized byte strings', async () => {
  await asUser(a);
  const invalid = ['', ' leading', 'trailing ', 'line\nbreak', 'tab\there', 'control\u0001', 'delete\u007f',
    'control\u0085', 'space\u00a0', 'space\u2007', 'space\u202f', 'space\ufeff', 'x'.repeat(2049), 'é'.repeat(1025)];
  for (const token of invalid) {
    await rejected(`insert into ${table}(fcm_token,user_id) values($1,$2)`, [token, a], '23514');
  }
  for (const token of ['?', 'x'.repeat(2048), 'é'.repeat(1024)]) {
    await query(`insert into ${table}(fcm_token,user_id) values($1,$2)`, [token, a]);
  }
  assert.equal(await scalar(`select count(*)::int from ${table}`), 3);
});

test('timestamps are database-owned and preserve original creation time on update', async () => {
  await asUser(a);
  const row = (await query(`insert into ${table}(fcm_token,user_id,created_at,updated_at)
    values('timestamps',$1,'2000-01-01','2000-01-01') returning created_at,updated_at`, [a])).rows[0];
  assert.ok(new Date(row.created_at).getUTCFullYear() > 2020);
  const updated = (await query(`update ${table} set created_at='2001-01-01',updated_at='2001-01-01',enabled=false
    returning created_at,updated_at`)).rows[0];
  assert.equal(String(updated.created_at), String(row.created_at));
  assert.ok(new Date(updated.updated_at) >= new Date(row.updated_at));
});

test('trusted sender can SELECT and disable invalid tokens but cannot register/delete/transfer them', async () => {
  await asUser(a);
  await query(`insert into ${table}(fcm_token,user_id) values('sender-cleanup',$1)`, [a]);
  await asUser(null, 'service_role');
  assert.equal(await scalar(`select count(*)::int from ${table}`), 1);
  await query(`update ${table} set enabled=false,updated_at='2000-01-01' where fcm_token='sender-cleanup'`);
  assert.equal(await scalar(`select enabled from ${table}`), false);
  for (const [field, value] of [
    ['fcm_token', 'replacement'], ['user_id', b], ['platform', 'android'],
    ['firebase_project_id', 'baristamatch'], ['package_name', 'com.baristajobmatch.app'],
    ['created_at', '2000-01-01'],
  ]) await rejected(`update ${table} set ${field}=$1`, [value]);
  await rejected(`insert into ${table}(fcm_token,user_id) values('server-insert',$1)`, [a]);
  await rejected(`delete from ${table}`);
  await rejected(`truncate ${table}`);
});

test('user foreign key rejects nonexistent accounts and cascades account deletion', async () => {
  await rejected(`insert into ${table}(fcm_token,user_id) values('missing-account',$1)`, [missing], '23503');
  await asUser(a);
  await query(`insert into ${table}(fcm_token,user_id) values('cascade',$1)`, [a]);
  await db.exec('reset role');
  await query('delete from auth.users where id=$1', [a]);
  assert.equal(await scalar(`select count(*)::int from ${table}`), 0);
  await db.exec('set local enable_seqscan=off');
  const plan = JSON.stringify((await query(`explain (format json) select * from ${table} where user_id='${b}'`)).rows);
  assert.match(plan, /android_device_push_tokens_user_id_idx/);
});

test('Sandbox guard rejects missing, empty, production and non-singleton configuration before creating objects', async t => {
  for (const mutation of [
    'drop table private.native_billing_configuration',
    'delete from private.native_billing_configuration',
    "update private.native_billing_configuration set environment='Production'",
    `alter table private.native_billing_configuration drop constraint native_billing_configuration_singleton_check;
     insert into private.native_billing_configuration values(false,'Sandbox')`,
  ]) await t.test(mutation.split(' ')[0] + ': ' + mutation.slice(0,80), async () => {
    const guardDb = new PGlite();
    try {
      await guardDb.exec(fixture);
      await guardDb.exec(mutation);
      await assert.rejects(guardDb.exec(artifact), /requires (?:an existing|exactly one) Sandbox billing configuration/);
      await guardDb.exec('rollback');
      assert.equal((await guardDb.query(`select to_regclass('${table}') as object`)).rows[0].object, null);
      assert.equal((await guardDb.query(`select to_regprocedure('private.android_device_push_tokens_touch()') as object`)).rows[0].object, null);
    } finally { await guardDb.close(); }
  });
});
