import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, afterEach, before, beforeEach, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';

const migration = readFileSync(new URL('../../supabase/migrations/20261021133639_add_durable_public_form_budgets.sql', import.meta.url), 'utf8');
const key = value => value.toString(16).padStart(64, '0');
const bucket = (value, maxRequests = 2, windowSeconds = 3600) => ({
  bucket_key: key(value), max_requests: maxRequests, window_seconds: windowSeconds,
});
let db;
const query = (sql, parameters = []) => db.query(sql, parameters);
const consume = async buckets => (await query('select public.consume_public_form_budget($1::jsonb) as result', [JSON.stringify(buckets)])).rows[0].result;
const counters = async () => (await query('select bucket_key,request_count from private.public_form_budgets order by bucket_key')).rows;

before(async () => {
  db = new PGlite();
  await db.exec('create role anon; create role authenticated; create role service_role bypassrls;');
  await db.exec(migration);
});
beforeEach(() => db.exec('begin'));
afterEach(() => db.exec('rollback'));
after(() => db.close());

test('real migration is repeatable, private RLS is default-deny, and only the service role can execute', async () => {
  await db.exec(migration);
  const metadata = (await query(`
    select c.relrowsecurity as rls,
      has_table_privilege('anon', c.oid, 'select,insert,update,delete,truncate') as anon_table,
      has_table_privilege('authenticated', c.oid, 'select,insert,update,delete,truncate') as auth_table,
      has_table_privilege('service_role', c.oid, 'select,insert,update,delete,truncate') as service_table
    from pg_class c where c.oid='private.public_form_budgets'::regclass
  `)).rows[0];
  assert.deepEqual(metadata, { rls: true, anon_table: false, auth_table: false, service_table: false });
  const privileges = (await query(`
    select has_function_privilege('anon','public.consume_public_form_budget(jsonb)','execute') as anon,
      has_function_privilege('authenticated','public.consume_public_form_budget(jsonb)','execute') as authenticated,
      has_function_privilege('service_role','public.consume_public_form_budget(jsonb)','execute') as service,
      p.prosecdef as definer,p.proconfig as config
    from pg_proc p where p.oid='public.consume_public_form_budget(jsonb)'::regprocedure
  `)).rows[0];
  assert.deepEqual(privileges, { anon: false, authenticated: false, service: true, definer: true, config: ['search_path=""', 'lock_timeout=1s'] });
  assert.equal((await query("select count(*)::int as count from pg_policies where schemaname='private' and tablename='public_form_budgets'")).rows[0].count, 0);
  for (const role of ['anon', 'authenticated']) {
    await db.exec(`savepoint denied; set local role ${role};`);
    await assert.rejects(consume([bucket(1)]), /permission denied/);
    await db.exec('rollback to savepoint denied; release savepoint denied;');
  }
  await db.exec('set local role service_role');
  assert.deepEqual(await consume([bucket(1)]), { allowed: true, retry_after_seconds: 0 });
});

test('the Nth request succeeds and every later request waits without increasing the count', async () => {
  const budgets = [bucket(1, 3), bucket(2, 5, 86400), bucket(3, 4, 600)];
  for (let attempt = 0; attempt < 3; attempt++) assert.deepEqual(await consume(budgets), { allowed: true, retry_after_seconds: 0 });
  for (let attempt = 0; attempt < 3; attempt++) {
    const result = await consume(budgets);
    assert.equal(result.allowed, false);
    assert.ok(Number.isInteger(result.retry_after_seconds) && result.retry_after_seconds >= 1 && result.retry_after_seconds <= 3600);
  }
  assert.deepEqual(await counters(), [1, 2, 3].map(value => ({ bucket_key: key(value), request_count: 3 })));
});

test('denial consumes none of the existing budgets and creates no fresh email counters', async () => {
  assert.equal((await consume([bucket(1, 1), bucket(2, 10)])).allowed, true);
  const before = await counters();
  assert.equal((await consume([bucket(2, 10), bucket(3, 10), bucket(1, 1)])).allowed, false);
  assert.deepEqual(await counters(), before);
  assert.equal((await consume([bucket(3, 10)])).allowed, true);
  assert.deepEqual((await counters()).at(-1), { bucket_key: key(3), request_count: 1 });
});

test('maximum Retry-After covers every exhausted window', async () => {
  assert.equal((await consume([bucket(1, 1), bucket(2, 1)])).allowed, true);
  await query("update private.public_form_budgets set window_started_at=clock_timestamp()-interval '1 second',expires_at=clock_timestamp()+make_interval(secs => case when bucket_key=$1 then 30 else 90 end)", [key(1)]);
  const result = await consume([bucket(1, 1), bucket(2, 1)]);
  assert.equal(result.allowed, false);
  assert.ok(result.retry_after_seconds >= 89 && result.retry_after_seconds <= 90);
});

test('expired windows reset to one request and use an epoch-aligned durable expiry', async () => {
  await consume([bucket(1, 1, 600)]);
  await query("update private.public_form_budgets set window_started_at=clock_timestamp()-interval '11 minutes',expires_at=clock_timestamp()-interval '1 minute'");
  assert.deepEqual(await consume([bucket(1, 1, 600)]), { allowed: true, retry_after_seconds: 0 });
  const row = (await query(`
    select request_count,extract(epoch from window_started_at)::bigint % 600 as remainder,
      extract(epoch from expires_at-window_started_at)::int as duration,expires_at>clock_timestamp() as future
    from private.public_form_budgets
  `)).rows[0];
  assert.equal(row.request_count, 1);
  assert.equal(Number(row.remainder), 0);
  assert.equal(row.duration, 600);
  assert.equal(row.future, true);
});

test('bounded cleanup deletes at most 64 stale hashes and keeps current counters', async () => {
  await query(`
    insert into private.public_form_budgets(bucket_key,window_started_at,expires_at,request_count)
    select lpad(to_hex(100+value),64,'0'),clock_timestamp()-interval '3 days',clock_timestamp()-interval '2 days',1
    from generate_series(1,100) value
  `);
  await consume([bucket(1)]);
  assert.equal((await counters()).length, 37);
  assert.deepEqual((await counters())[0], { bucket_key: key(1), request_count: 1 });
  const index = (await query("select indexdef from pg_indexes where schemaname='private' and indexname='public_form_budgets_expiry_idx'")).rows[0].indexdef;
  assert.match(index, /\(expires_at, bucket_key\)/);
});

test('invalid shapes, raw identifiers, duplicate keys and unbounded budgets fail before any write', async () => {
  const invalid = [null, {}, [], [null], ['email@example.com'], [bucket(1), bucket(1)],
    Array.from({ length: 9 }, (_, value) => bucket(value)),
    [{ ...bucket(1), bucket_key: 'email@example.com' }], [{ ...bucket(1), bucket_key: 'A'.repeat(64) }],
    [{ ...bucket(1), max_requests: 0 }], [{ ...bucket(1), max_requests: -1 }], [{ ...bucket(1), max_requests: 1.5 }],
    [{ ...bucket(1), max_requests: '2' }], [{ ...bucket(1), max_requests: 10001 }],
    [{ ...bucket(1), window_seconds: 0 }], [{ ...bucket(1), window_seconds: 86401 }],
    [{ ...bucket(1), window_seconds: null }], [{ bucket_key: key(1) }], [{ ...bucket(1), raw_email: 'email@example.com' }]];
  for (const budgets of invalid) {
    await db.exec('savepoint invalid');
    await assert.rejects(consume(budgets), /Invalid public form budgets|Duplicate public form budget/);
    await db.exec('rollback to savepoint invalid; release savepoint invalid');
    assert.deepEqual(await counters(), []);
  }
});

test('contending API promises never exceed a budget, including reversed bucket order', async () => {
  // PGlite serializes one backend, so this exercises the actual SQL outcome but
  // does not replace the independent PostgreSQL multi-session race test.
  const results = await Promise.all(Array.from({ length: 30 }, (_, value) => consume(
    value % 2 ? [bucket(1, 7), bucket(2, 10)] : [bucket(2, 10), bucket(1, 7)],
  )));
  assert.equal(results.filter(result => result.allowed).length, 7);
  assert.deepEqual(await counters(), [1, 2].map(value => ({ bucket_key: key(value), request_count: 7 })));
});
