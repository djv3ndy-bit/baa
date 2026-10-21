import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, afterEach, before, beforeEach, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';

const migration = readFileSync(new URL('../../supabase/migrations/20261021133641_revoke_unused_client_table_privileges.sql', import.meta.url), 'utf8');
const policySql = "select tablename,policyname,permissive,roles,cmd,qual,with_check from pg_policies order by schemaname,tablename,policyname";
let db, policiesBefore;
const query = (sql, parameters = []) => db.query(sql, parameters);

before(async () => {
  db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    alter default privileges for role postgres in schema public grant all on tables to anon,authenticated,service_role;
    create table public.messages(id integer primary key,owner_id integer not null,body text);
    alter table public.messages enable row level security;
    create policy own_messages on public.messages to authenticated
      using (owner_id = current_setting('test.owner_id',true)::integer)
      with check (owner_id = current_setting('test.owner_id',true)::integer);
    create function public.example_client_rpc() returns integer language sql as $$select 7$$;
    revoke all on function public.example_client_rpc() from public,anon;
    grant execute on function public.example_client_rpc() to authenticated;
    insert into public.messages values (1,1,'mine'),(2,2,'theirs');
  `);
  policiesBefore = (await query(policySql)).rows;
  await db.exec(migration);
});
beforeEach(() => db.exec('begin'));
afterEach(() => db.exec('rollback'));
after(() => db.close());

test('migration removes whole-table powers and preserves CRUD, service maintenance, policies and client RPC grants', async () => {
  for (const role of ['anon', 'authenticated']) {
    for (const privilege of ['TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN']) {
      assert.equal((await query("select has_table_privilege($1,'public.messages',$2) as allowed", [role, privilege])).rows[0].allowed, false);
    }
    for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
      assert.equal((await query("select has_table_privilege($1,'public.messages',$2) as allowed", [role, privilege])).rows[0].allowed, true);
    }
  }
  for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN']) {
    assert.equal((await query("select has_table_privilege('service_role','public.messages',$1) as allowed", [privilege])).rows[0].allowed, true);
  }
  assert.deepEqual((await query(policySql)).rows, policiesBefore);
  assert.deepEqual((await query(`select has_function_privilege('anon','public.example_client_rpc()','execute') as anon,
    has_function_privilege('authenticated','public.example_client_rpc()','execute') as authenticated`)).rows[0], { anon: false, authenticated: true });
  await db.exec(migration);
  assert.deepEqual((await query(policySql)).rows, policiesBefore);
});

test('new postgres tables inherit only the pre-existing CRUD rights for client roles', async () => {
  await db.exec('create table public.future_table(id integer);');
  for (const role of ['anon', 'authenticated']) {
    for (const privilege of ['TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN']) {
      assert.equal((await query("select has_table_privilege($1,'public.future_table',$2) as allowed", [role, privilege])).rows[0].allowed, false);
    }
    assert.equal((await query("select has_table_privilege($1,'public.future_table','SELECT') as allowed", [role])).rows[0].allowed, true);
  }
});

test('actual anonymous/authenticated TRUNCATE is denied while own row CRUD and authorization still work', async () => {
  for (const role of ['anon', 'authenticated']) {
    await db.exec(`savepoint denied; set local role ${role};`);
    await assert.rejects(db.exec('truncate public.messages'), /permission denied/);
    await db.exec('rollback to savepoint denied; release savepoint denied');
  }
  await db.exec("set local test.owner_id='1'; set local role authenticated;");
  assert.deepEqual((await query('select body from public.messages')).rows, [{ body: 'mine' }]);
  assert.equal((await query("update public.messages set body='updated' where id=1 returning id")).rows.length, 1);
  assert.equal((await query("update public.messages set body='forged' where id=2 returning id")).rows.length, 0);
  await query("insert into public.messages values (3,1,'new')");
  assert.equal((await query('delete from public.messages where id=3 returning id')).rows.length, 1);
  assert.equal((await query('select public.example_client_rpc() as result')).rows[0].result, 7);
});
