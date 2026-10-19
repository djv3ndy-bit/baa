import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

// Explicit local WASM runtime only. No hosted connection, package download,
// install hook, or repository dependency mutation is performed by this test.
const runtimeRoot = process.env.BJM_QA_PG17_RUNTIME_ROOT;
const cafe = '00000000-0000-4000-8000-000000000001';
const other = '00000000-0000-4000-8000-000000000002';
const barista = '00000000-0000-4000-8000-000000000003';
const product = 'baristamatch_cafe_pro';
const oldEnd = '2001-01-01T00:00:00.000Z';
const newEnd = '2099-01-01T00:00:00.000Z';
const source = relative => readFileSync(new URL(`../../${relative}`, import.meta.url), 'utf8');
const ledgerSql = source('review/native-billing-ledger.sql');
const wrapperSql = source('server/native-billing/sql/google_qa_resubscribe.sql');
const signature = 'public.native_billing_apply_google_qa_resubscribe(uuid,uuid,text,text,text,text,text,timestamptz,timestamptz,boolean,bigint,text,bigint,timestamptz,timestamptz,text)';
const scopeIds = [...wrapperSql.matchAll(/custom_environment_id='([^']+)'/g)].map(match => match[1]);

test('isolated PostgreSQL17 Google QA resubscribe contract', {
  skip: !runtimeRoot && 'NOT EXECUTED: supply an existing integrity-verified PGlite0.3.7 runtime via BJM_QA_PG17_RUNTIME_ROOT',
}, async t => {
  const pkg = JSON.parse(readFileSync(resolve(runtimeRoot, 'package.json'), 'utf8'));
  assert.equal(pkg.name, '@electric-sql/pglite');
  assert.equal(pkg.version, '0.3.7', 'Do not substitute PG18 proof for target-major acceptance');
  const { PGlite } = await import(pathToFileURL(resolve(runtimeRoot, 'dist/index.js')).href);
  const db = new PGlite();
  const query = (sql, params = []) => db.query(sql, params);
  const scalar = async (sql, params = []) => Object.values((await query(sql, params)).rows[0])[0];
  let binding, otherBinding;
  const call = async (overrides = {}) => {
    const p = { user: cafe, binding, id: 'new-token', product, plan: 'monthly-us', transaction: 'new-order',
      status: 'active', end: newEnd, grace: null, renews: true, revision: 0,
      predecessor: 'old-token', oldRevision: 1, oldEnd, providerEnd: oldEnd,
      providerState: 'SUBSCRIPTION_STATE_EXPIRED', ...overrides };
    return scalar(`select public.native_billing_apply_google_qa_resubscribe(${Object.keys(p).map((_, i) => '$' + (i + 1)).join(',')})`, Object.values(p));
  };
  const read = id => scalar("select public.native_billing_read('google','Sandbox',$1)", [id]);
  const applyGeneric = (id, user = cafe, accountBinding = binding, revision = 0) => scalar(
    "select public.native_billing_apply($1,$2,'google','Sandbox',$3,$4,$5,'active',$6,null,true,$7,null)",
    [user, accountBinding, id, product, id + '-order', newEnd, revision]);
  const seed = () => scalar("select public.native_billing_apply($1,$2,'google','Sandbox','old-token',$3,'old-order','expired',$4,null,false,0,null)", [cafe, binding, product, oldEnd]);
  async function denied(operation, pattern = /QA |predecessor|another account|permission denied/i) {
    await db.exec('savepoint expected_rejection');
    try { await assert.rejects(operation(), pattern); }
    finally { await db.exec('rollback to savepoint expected_rejection; release savepoint expected_rejection'); }
  }
  async function isolated(name, fn) {
    await t.test(name, async () => {
      await db.exec('begin');
      try { await seed(); await fn(); }
      finally { await db.exec('rollback'); }
    });
  }

  try {
    const engine = await scalar('select version()');
    assert.match(engine, /^PostgreSQL 17\./);
    assert.equal(Math.floor(Number(await scalar("select current_setting('server_version_num')")) / 10000), 17);
    assert.equal(await scalar('select current_user'), 'postgres');
    assert.ok(scopeIds.length >= 2 && new Set(scopeIds).size === 1, 'Creation and runtime scope pins must agree');
    t.diagnostic(JSON.stringify({ package: pkg.version, engine, sqlSha256: createHash('sha256').update(wrapperSql).digest('hex'), concurrencyProof: false }));
    await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
      create schema auth; create table auth.users(id uuid primary key);
      create table public.profiles(id uuid primary key,role text,suspended_at timestamptz);
      insert into auth.users values('${cafe}'),('${other}'),('${barista}');
      insert into public.profiles values('${cafe}','cafe_owner_manager',null),('${other}','cafe_owner_manager',null),('${barista}','barista',null);`);
    await db.exec(ledgerSql);
    binding = await scalar('select public.native_billing_account($1)', [cafe]);
    otherBinding = await scalar('select public.native_billing_account($1)', [other]);
    await db.exec(`create table private.native_billing_configuration(singleton boolean primary key check(singleton),environment text not null);
      insert into private.native_billing_configuration values(true,'Sandbox');
      create table private.android_reviewer_configuration(singleton boolean primary key check(singleton),project_ref text,api_base_url text,package_name text,environment text,custom_environment_id text,enabled boolean not null default false);
      insert into private.android_reviewer_configuration(singleton,project_ref,api_base_url,package_name,environment,custom_environment_id)
      values(true,'ojvjlvojvozvhktbclcg','https://android-testing.baristajobmatch.com/api','com.baristajobmatch.app','Sandbox','${scopeIds[0]}');`);
    const originalFunctions = await query("select p.oid::regprocedure::text identity,pg_get_functiondef(p.oid) definition,p.proacl::text acl from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('native_billing_apply','native_billing_read','native_billing_owner') order by 1");
    await db.exec(wrapperSql);

    await isolated('adds only the service RPC while preserving original apply/read/owner definitions and ACLs', async () => {
      const after = await query("select p.oid::regprocedure::text identity,pg_get_functiondef(p.oid) definition,p.proacl::text acl from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('native_billing_apply','native_billing_read','native_billing_owner') order by 1");
      assert.deepEqual(after.rows, originalFunctions.rows);
      assert.equal(await scalar("select count(*)::int from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='native_billing_apply_google_qa_resubscribe'"), 1);
      const configuration = await scalar('select proconfig from pg_proc where oid=$1::regprocedure', [signature]);
      assert.deepEqual(configuration, ['search_path=""', 'lock_timeout=3s'], 'Each RPC invocation must inherit the bounded lock wait and empty search path');
      assert.equal(await scalar('select enabled from private.android_reviewer_configuration'), false);
    });
    await isolated('service role links only the owned expired Sandbox predecessor and grants only that café', async () => {
      await db.exec('set local role service_role');
      assert.equal(await call(), 'applied');
      await db.exec('reset role');
      const old = await read('old-token'), current = await read('new-token');
      assert.equal(old.status, 'revoked'); assert.equal(old.revision, 2);
      assert.equal(old.superseded_by, createHash('sha256').update('new-token').digest('hex'));
      assert.equal(current.user_id, cafe); assert.equal(current.environment, 'Sandbox');
      assert.equal(await scalar("select public.native_billing_access($1,'Sandbox')", [cafe]), true);
      assert.equal(await scalar("select public.native_billing_access($1,'Production')", [cafe]), false);
      assert.equal(await scalar("select public.native_billing_access($1,'Sandbox')", [other]), false);
    });
    await isolated('same-successor retry is idempotent only with the refreshed predecessor revision', async () => {
      assert.equal(await call(), 'applied');
      const old = await read('old-token');
      assert.equal(await call({ revision: 1 }), 'retry');
      assert.equal(await call({ revision: 1, oldRevision: old.revision }), 'duplicate');
      assert.equal((await read('new-token')).revision, 1);
      assert.equal((await read('old-token')).revision, old.revision);
    });
    await isolated('a delayed generic restore cannot reactivate the superseded predecessor', async () => {
      await call(); const old = await read('old-token');
      assert.equal(await applyGeneric('old-token', cafe, binding, old.revision), 'superseded');
      assert.equal((await read('old-token')).status, 'revoked');
    });
    await isolated('missing predecessor cannot be silently replaced by a new tombstone', async () => {
      await query("delete from private.native_billing_subscriptions where provider_subscription_id='old-token'");
      await denied(() => call());
      assert.equal(await read('old-token'), null); assert.equal(await read('new-token'), null);
    });
    await isolated('a foreign predecessor or mismatched binding never transfers ownership', async () => {
      await denied(() => call({ user: other, binding: otherBinding }));
      await denied(() => call({ binding: otherBinding }));
      assert.equal((await read('old-token')).user_id, cafe); assert.equal(await read('new-token'), null);
    });
    await isolated('an existing foreign current token causes complete rollback without revoking the predecessor', async () => {
      await applyGeneric('new-token', other, otherBinding);
      await denied(() => call({ revision: 1 }));
      assert.equal((await read('old-token')).status, 'expired');
      assert.equal((await read('new-token')).user_id, other);
    });
    await isolated('positive revision without an original finite period is insufficient', async () => {
      await query("update private.native_billing_subscriptions set revision=1,current_period_end=null where provider_subscription_id='old-token'");
      await denied(() => call()); assert.equal(await read('new-token'), null);
    });
    await isolated('zero-revision and pending sentinels cannot become ownership evidence', async () => {
      for (const change of ['revision=0', "status='pending'"]) {
        await db.exec('savepoint invalid_old');
        await db.exec("update private.native_billing_subscriptions set " + change + " where provider_subscription_id='old-token'");
        await denied(() => call()); assert.equal(await read('new-token'), null);
        await db.exec('rollback to savepoint invalid_old; release savepoint invalid_old');
      }
    });
    await isolated('unknown product/provider/environment predecessor rows cannot qualify', async () => {
      for (const change of ["product_id='foreign_product'", "provider='apple'", "environment='Production'"]) {
        await db.exec('savepoint invalid_catalog');
        await db.exec("update private.native_billing_subscriptions set " + change + " where provider_subscription_id='old-token'");
        await denied(() => call()); assert.equal(await read('new-token'), null);
        await db.exec('rollback to savepoint invalid_catalog; release savepoint invalid_catalog');
      }
    });
    await isolated('competing successor or independently revoked predecessor is rejected', async () => {
      for (const change of ["superseded_by='" + 'b'.repeat(64) + "'", "status='revoked'"]) {
        await db.exec('savepoint invalid_successor');
        await db.exec("update private.native_billing_subscriptions set " + change + " where provider_subscription_id='old-token'");
        await denied(() => call()); assert.equal(await read('new-token'), null);
        await db.exec('rollback to savepoint invalid_successor; release savepoint invalid_successor');
      }
    });
    await isolated('an already-superseded current token does not mutate the predecessor', async () => {
      await applyGeneric('new-token');
      await db.exec("update private.native_billing_subscriptions set superseded_by='" + 'c'.repeat(64) + "' where provider_subscription_id='new-token'");
      assert.equal(await call({ revision: 1 }), 'superseded');
      assert.equal((await read('old-token')).status, 'expired');
    });
    await isolated('stale predecessor revision or exact period returns retry with no current-token insert', async () => {
      assert.equal(await call({ oldRevision: 2 }), 'retry');
      assert.equal(await call({ oldEnd: '2000-01-01T00:00:00.000Z' }), 'retry');
      assert.equal(await read('new-token'), null); assert.equal((await read('old-token')).revision, 1);
    });
    await isolated('stale current revision returns retry before predecessor supersession', async () => {
      await applyGeneric('new-token');
      assert.equal(await call(), 'retry');
      assert.equal((await read('old-token')).status, 'expired');
    });
    await isolated('rejects self-reference, wrong catalog, malformed predecessor evidence and nonexpired provider states', async () => {
      for (const invalid of [{ predecessor: 'new-token' }, { product: 'wrong' }, { plan: 'wrong' },
        { predecessor: null }, { oldRevision: 0 }, { oldEnd: null }, { providerEnd: null },
        { providerEnd: newEnd }, { providerEnd: 'infinity' }, { oldEnd: 'infinity' },
        { providerEnd: '1969-01-01T00:00:00Z' }, { providerState: 'SUBSCRIPTION_STATE_CANCELED' },
        { providerState: 'SUBSCRIPTION_STATE_ACTIVE' }, { providerState: null }]) await denied(() => call(invalid));
      assert.equal(await read('new-token'), null);
    });
    await isolated('future, infinite or epoch-invalid original periods cannot qualify', async () => {
      for (const period of [newEnd, 'infinity', '-infinity', '1969-01-01T00:00:00Z']) {
        await db.exec('savepoint invalid_period');
        await query("update private.native_billing_subscriptions set current_period_end=$1 where provider_subscription_id='old-token'", [period]);
        await denied(() => call()); assert.equal(await read('new-token'), null);
        await db.exec('rollback to savepoint invalid_period; release savepoint invalid_period');
      }
    });
    await isolated('Auth deletion, profile deletion, suspension and barista role reject retained billing ownership', async () => {
      for (const change of ["delete from auth.users where id='" + cafe + "'", "delete from public.profiles where id='" + cafe + "'",
        "update public.profiles set suspended_at=now() where id='" + cafe + "'", "update public.profiles set role='barista' where id='" + cafe + "'"]) {
        await db.exec('savepoint inactive_owner'); await db.exec(change);
        await denied(() => call()); assert.equal(await read('new-token'), null);
        await db.exec('rollback to savepoint inactive_owner; release savepoint inactive_owner');
      }
    });
    await isolated('runtime Sandbox and exact existing QA identity gates cannot be bypassed by reviewer status', async () => {
      assert.equal(await scalar('select enabled from private.android_reviewer_configuration'), false);
      assert.equal(await call(), 'applied');
      for (const change of ["update private.native_billing_configuration set environment='Production'",
        "update private.android_reviewer_configuration set project_ref='other'",
        "update private.android_reviewer_configuration set api_base_url='https://example.invalid/api'",
        "update private.android_reviewer_configuration set package_name='com.example.other'",
        "update private.android_reviewer_configuration set environment='Production'",
        "update private.android_reviewer_configuration set custom_environment_id='env_wrong'"]) {
        await db.exec('savepoint invalid_scope'); await db.exec(change);
        await denied(() => call({ id: 'other-new-token', oldRevision: 2 }));
        assert.equal(await read('other-new-token'), null);
        await db.exec('rollback to savepoint invalid_scope; release savepoint invalid_scope');
      }
    });
    await isolated('anonymous and authenticated callers cannot invoke the additive service-only wrapper', async () => {
      for (const role of ['anon', 'authenticated']) {
        assert.equal(await scalar('select has_function_privilege($1,$2,\'EXECUTE\')', [role, signature]), false);
        await db.exec('set local role ' + role); await denied(() => call(), /permission denied/); await db.exec('reset role');
      }
      assert.equal(await scalar("select has_function_privilege('service_role',$1,'EXECUTE')", [signature]), true);
      assert.equal(await read('new-token'), null);
    });
    await isolated('a second migration application refuses replacement rather than changing the live contract', async () => {
      await assert.rejects(db.exec(wrapperSql), /already exists/);
    });
  } finally { await db.close(); }
});
