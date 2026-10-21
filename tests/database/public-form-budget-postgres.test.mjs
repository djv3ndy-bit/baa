import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { after, before, test } from 'node:test';

// Opt-in only: this suite creates synthetic objects in a disposable local DB.
// Never use a hosted Supabase URL, production tunnel, or existing application DB.
const configuredUrl = process.env.BJM_TEST_DATABASE_URL;
const enabled = Boolean(configuredUrl);
const migration = readFileSync(new URL('../../supabase/migrations/20261021133639_add_durable_public_form_budgets.sql', import.meta.url), 'utf8');
const privilegeMigration = readFileSync(new URL('../../supabase/migrations/20261021133641_revoke_unused_client_table_privileges.sql', import.meta.url), 'utf8');
let connectionEnv, initialized = false;
const key = number => number.toString(16).padStart(64, '0');
const bucket = (number, limit = 7) => ({ bucket_key: key(number), max_requests: limit, window_seconds: 86400 });
const literal = value => `'${String(value).replaceAll("'", "''")}'`;
const callSql = buckets => `select public.consume_public_form_budget(${literal(JSON.stringify(buckets))}::jsonb);`;
const asService = sql => `set role service_role; ${sql}`;

function localConnectionEnv(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Invalid disposable test database URL.'); }
  assert.ok(['postgres:', 'postgresql:'].includes(url.protocol), 'Use a PostgreSQL URL.');
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname), 'Refusing a non-local database.');
  assert.equal(url.pathname, '/bjm_security_test', 'Refusing a non-test database.');
  assert.equal(decodeURIComponent(url.username), 'postgres', 'The disposable fixture must use postgres.');
  assert.equal(url.search, '', 'Connection options cannot override the local host.');
  assert.equal(url.hash, '', 'URL fragments are unsupported.');
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^PG/i.test(name)));
  return {
    ...env,
    PGHOST: url.hostname === '[::1]' ? '::1' : '127.0.0.1',
    PGHOSTADDR: url.hostname === '[::1]' ? '::1' : '127.0.0.1',
    PGPORT: url.port || '5432', PGUSER: 'postgres',
    PGPASSWORD: decodeURIComponent(url.password), PGDATABASE: 'bjm_security_test',
    PGCONNECT_TIMEOUT: '3', PGSSLMODE: 'disable',
    PGAPPNAME: 'bjm-public-form-regression',
    PGOPTIONS: '-c statement_timeout=12000 -c lock_timeout=8000',
  };
}

function startSql(sql, onLine, { keepOpen = false } = {}) {
  const child = spawn('psql', ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1'], {
    env: connectionEnv, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '', pending = '';
  const completion = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill(); reject(new Error('Disposable PostgreSQL test timed out.')); }, 15000);
    child.on('error', error => { clearTimeout(timeout); reject(error); });
    child.stdout.on('data', data => {
      stdout += data;
      pending += data;
      if (stdout.length > 65536) { child.kill(); return reject(new Error('Unexpectedly large test output.')); }
      const lines = pending.split('\n'); pending = lines.pop();
      for (const line of lines) if (line.trim()) onLine?.(line.trim());
    });
    child.stderr.on('data', data => { stderr += data; });
    child.on('close', code => {
      clearTimeout(timeout);
      if (code !== 0) return reject(new Error(`Local psql failed (${code}): ${stderr.trim()}`));
      resolve(stdout.split('\n').map(line => line.trim()).filter(Boolean));
    });
    child.stdin.on('error', () => {});
    if (keepOpen) child.stdin.write(`${sql}\n`);
    else child.stdin.end(sql);
  });
  return { completion, child };
}
const sql = async statement => startSql(statement).completion;
const json = async statement => JSON.parse((await sql(statement))[0]);

before(async () => {
  if (!enabled) return;
  connectionEnv = localConnectionEnv(configuredUrl);
  const identity = await json(`select jsonb_build_object('database',current_database(),'role',current_user,
    'major',current_setting('server_version_num')::integer/10000,
    'tables',(select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where c.relkind in ('r','p','v','m') and n.nspname not in ('pg_catalog','information_schema') and n.nspname not like 'pg_toast%'));`);
  assert.deepEqual(identity, { database: 'bjm_security_test', role: 'postgres', major: 17, tables: 0 },
    'Use a fresh disposable PostgreSQL 17 database; existing user tables are never removed.');
  await sql(`begin;
    do $roles$ begin
      if not exists(select 1 from pg_roles where rolname='anon') then create role anon; end if;
      if not exists(select 1 from pg_roles where rolname='authenticated') then create role authenticated; end if;
      if not exists(select 1 from pg_roles where rolname='service_role') then create role service_role bypassrls; end if;
    end $roles$;
    create table public.client_privilege_probe(id integer primary key);
    grant select,insert,update,delete,truncate,references,trigger,maintain on public.client_privilege_probe to anon,authenticated;
    ${migration}
    ${privilegeMigration}
    commit;`);
  initialized = true;
});

after(async () => {
  if (!initialized) return;
  await sql(`drop function public.consume_public_form_budget(jsonb);
    drop table private.public_form_budgets;
    drop table public.client_privilege_probe;`);
});

const run = (name, body) => test(name, { skip: !enabled }, body);

test('integration connection guard rejects remote hosts, alternate databases and host-overriding options', () => {
  for (const value of [
    'postgresql://postgres:fixture@remote.example/bjm_security_test',
    'postgresql://postgres:fixture@127.0.0.1/postgres',
    'postgresql://postgres:fixture@127.0.0.1/bjm_security_test?hostaddr=192.0.2.1',
    'postgresql://another_role:fixture@127.0.0.1/bjm_security_test',
    'https://postgres:fixture@127.0.0.1/bjm_security_test',
  ]) assert.throws(() => localConnectionEnv(value));
  const env = localConnectionEnv('postgresql://postgres:fixture@localhost:5432/bjm_security_test');
  assert.equal(env.PGHOSTADDR, '127.0.0.1');
  assert.equal(env.PGDATABASE, 'bjm_security_test');
});

run('PostgreSQL 17 confirms service-only RPC, locked search_path, RLS, ownership and narrow grant revokes', async () => {
  const metadata = await json(`select jsonb_build_object(
    'owner',pg_get_userbyid(p.proowner),'definer',p.prosecdef,'config',p.proconfig,
    'anon',has_function_privilege('anon',p.oid,'execute'),
    'authenticated',has_function_privilege('authenticated',p.oid,'execute'),
    'service',has_function_privilege('service_role',p.oid,'execute'),
    'rls',(select relrowsecurity from pg_class where oid='private.public_form_budgets'::regclass),
    'client_truncate',has_table_privilege('authenticated','public.client_privilege_probe','truncate'),
    'client_select',has_table_privilege('authenticated','public.client_privilege_probe','select'))
    from pg_proc p where p.oid='public.consume_public_form_budget(jsonb)'::regprocedure;`);
  assert.deepEqual(metadata, { owner: 'postgres', definer: true, config: ['search_path=""', 'lock_timeout=1s'], anon: false,
    authenticated: false, service: true, rls: true, client_truncate: false, client_select: true });
  for (const role of ['anon', 'authenticated']) {
    await assert.rejects(sql(`set role ${role}; ${callSql([bucket(1)])}`), /permission denied/);
    await assert.rejects(sql(`set role ${role}; truncate public.client_privilege_probe;`), /permission denied/);
  }
  await assert.rejects(sql(asService('select * from private.public_form_budgets;')), /permission denied/);
});

run('32 independent sessions racing cold reversed keys admit exactly seven requests without deadlocks', async () => {
  const results = await Promise.all(Array.from({ length: 32 }, (_, index) => json(`begin;
    set local role service_role;
    ${callSql(index % 2 ? [bucket(10), bucket(11, 20)] : [bucket(11, 20), bucket(10)])}
    select pg_sleep(0.025); commit;`)));
  assert.equal(results.filter(result => result.allowed).length, 7);
  const counts = await json(`select jsonb_agg(request_count order by bucket_key) from private.public_form_budgets
    where bucket_key in (${literal(key(10))},${literal(key(11))});`);
  assert.deepEqual(counts, [7, 7]);
});

run('overlapping three-key contention preserves all-or-none counts across reversed session order', async () => {
  const pairs = [[bucket(20), bucket(21)], [bucket(21), bucket(22)], [bucket(22), bucket(20)]];
  const results = await Promise.all(Array.from({ length: 36 }, (_, index) => json(`begin;
    set local role service_role;
    ${callSql(index % 2 ? pairs[index % 3] : [...pairs[index % 3]].reverse())}
    select pg_sleep(0.01); commit;`)));
  const counts = await json(`select jsonb_agg(request_count) from private.public_form_budgets
    where bucket_key in (${[20, 21, 22].map(number => literal(key(number))).join(',')});`);
  assert.equal(counts.length, 3);
  assert.ok(counts.every(count => count <= 7));
  assert.equal(counts.reduce((sum, count) => sum + count, 0), results.filter(result => result.allowed).length * 2);
});

run('parallel denied requests neither spend other budgets nor retain fresh recipient counters', async () => {
  assert.equal((await json(asService(callSql([bucket(30, 1)])))).allowed, true);
  const results = await Promise.all(Array.from({ length: 24 }, (_, index) => json(asService(
    callSql([bucket(100 + index, 10), bucket(30, 1)]),
  ))));
  assert.ok(results.every(result => !result.allowed && result.retry_after_seconds >= 1));
  const state = await json(`select jsonb_build_object(
    'spent',(select request_count from private.public_form_budgets where bucket_key=${literal(key(30))}),
    'fresh',(select count(*) from private.public_form_budgets where bucket_key between ${literal(key(100))} and ${literal(key(123))}));`);
  assert.deepEqual(state, { spent: 1, fresh: 0 });
});

run('an expired counter resets exactly once under independent-session contention', async () => {
  await json(asService(callSql([bucket(40, 5)])));
  await sql(`update private.public_form_budgets set window_started_at=clock_timestamp()-interval '2 days',
    expires_at=clock_timestamp()-interval '1 day',request_count=5 where bucket_key=${literal(key(40))};`);
  const results = await Promise.all(Array.from({ length: 24 }, () => json(asService(callSql([bucket(40, 5)])))));
  assert.equal(results.filter(result => result.allowed).length, 5);
  assert.equal(await json(`select to_jsonb(request_count) from private.public_form_budgets where bucket_key=${literal(key(40))};`), 5);
});

run('bounded cleanup skips a row held by another session and respects the 64-row batch', async () => {
  await sql(`insert into private.public_form_budgets(bucket_key,window_started_at,expires_at,request_count)
    select lpad(to_hex(1000+value),64,'0'),clock_timestamp()-interval '3 days',clock_timestamp()-interval '2 days',1
    from generate_series(1,100) value;`);
  let markReady;
  const ready = new Promise(resolve => { markReady = resolve; });
  const holder = startSql(`begin;
    select bucket_key from private.public_form_budgets where bucket_key=${literal(key(1001))} for update;
    select '{"locked":true}';`, line => {
    if (line === '{"locked":true}') markReady();
  }, { keepOpen: true });
  await Promise.race([ready, holder.completion.then(() => { throw new Error('Holder failed to acquire row lock.'); })]);
  try {
    // A blocking cleanup implementation would fail this actual DB lock timeout.
    assert.equal((await json(`set lock_timeout='500ms'; ${asService(callSql([bucket(50)]))}`)).allowed, true);
    const state = await json(`select jsonb_build_object(
      'locked_row_survives',exists(select 1 from private.public_form_budgets where bucket_key=${literal(key(1001))}),
      'remaining_stale',(select count(*) from private.public_form_budgets where bucket_key between ${literal(key(1001))} and ${literal(key(1100))}));`);
    assert.deepEqual(state, { locked_row_survives: true, remaining_stale: 36 });
  } finally {
    holder.child.stdin.end('commit;\n');
    await holder.completion;
  }
});

run('a stalled budget lock fails closed promptly and rolls back earlier bucket creation', async () => {
  await json(asService(callSql([bucket(61)])));
  let markReady;
  const ready = new Promise(resolve => { markReady = resolve; });
  const holder = startSql(`begin;
    select bucket_key from private.public_form_budgets where bucket_key=${literal(key(61))} for update;
    select '{"locked":true}';`, line => {
    if (line === '{"locked":true}') markReady();
  }, { keepOpen: true });
  await Promise.race([ready, holder.completion.then(() => { throw new Error('Holder failed to acquire row lock.'); })]);
  try {
    await assert.rejects(json(asService(callSql([bucket(60), bucket(61)]))), /lock timeout/);
    assert.equal(await json(`select to_jsonb(count(*)) from private.public_form_budgets where bucket_key=${literal(key(60))};`), 0);
  } finally {
    holder.child.stdin.end('commit;\n');
    await holder.completion;
  }
});
