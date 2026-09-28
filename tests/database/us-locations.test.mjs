import test, { before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const migration = read('../../supabase/migrations/20260928231144_enable_us_marketplace_locations.sql');
const cafe = '00000000-0000-4000-8000-000000000002';
const barista = '00000000-0000-4000-8000-000000000001';
const otherCafe = '00000000-0000-4000-8000-000000000004';
const legacyJob = '10000000-0000-4000-8000-000000000003';
const states = 'AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY'.split(' ');
let db;
const insert = (state, owner = cafe, city = 'Example City', zip = '12345-1234') => db.query("insert into public.jobs(owner_id,title,location,address_line1,city,state,postal_code) values($1,'Synthetic role','draft','123 Test St',$2,$3,$4) returning id,location,state", [owner, city, state, zip]);
const asUser = async id => { await db.exec('reset role'); await db.query("select set_config('request.jwt.claim.sub',$1,true)", [id]); await db.exec('set local role authenticated'); };
async function rejected(action, pattern) {
  await db.exec('savepoint expected_failure');
  try { await assert.rejects(action(), pattern); } finally { await db.exec('rollback to savepoint expected_failure; release savepoint expected_failure'); }
}
async function preservedState() {
  const snapshot = {};
  for (const table of ['profiles', 'jobs', 'applications', 'cafe_subscriptions', 'discovery_matches', 'discovery_messages', 'notifications']) snapshot[table] = (await db.query(`select to_jsonb(t) row from public.${table} t order by to_jsonb(t)::text`)).rows;
  snapshot.policies = (await db.query("select * from pg_policies where schemaname='public' order by tablename,policyname")).rows;
  snapshot.triggers = (await db.query("select tgname,pg_get_triggerdef(oid) definition from pg_trigger where not tgisinternal order by tgname")).rows;
  snapshot.grants = (await db.query("select * from information_schema.role_table_grants where table_schema='public' order by table_name,grantee,privilege_type")).rows;
  return snapshot;
}
before(async () => {
  db = new PGlite();
  await db.exec(read('./fixture.sql'));
  await db.exec(read('../../supabase/migrations/20260907050656_repair_account_integrity_and_discovery_notifications.sql'));
  const before = await preservedState();
  await db.exec(migration);
  assert.deepEqual(await preservedState(), before, 'migration must not change records, access policies, grants or trigger wiring');
});
beforeEach(async () => { await db.exec('begin'); });
afterEach(async () => { await db.exec('rollback'); });
after(async () => { await db.close(); });

for (const state of states) test(`database accepts and canonicalizes a café job in ${state}`, async () => {
  await asUser(cafe);
  const { rows } = await insert(` ${state.toLowerCase()} `);
  assert.equal(rows[0].state, state);
  assert.equal(rows[0].location, `Example City, ${state}, 12345-1234`);
});

test('invalid/international/territory states and invalid ZIP codes remain blocked', async () => {
  await asUser(cafe);
  for (const state of ['', 'ZZ', 'ON', 'PR', 'GU', 'USA', null]) await rejected(() => insert(state), /valid U.S. state/);
  for (const zip of ['', '123', '123456', 'ABCDE', '12345-123']) await rejected(() => insert('NY', cafe, 'Brooklyn', zip), /ZIP code/);
  await rejected(() => insert('NY', cafe, ''), /city/);
});

test('baristas, anonymous users and other owners still cannot create a café job', async () => {
  await asUser(barista); await rejected(() => insert('NY', barista), /row-level security/);
  await asUser(otherCafe); await rejected(() => insert('NY'), /row-level security/);
  await db.exec('reset role; set local role anon'); await rejected(() => insert('NY'), /permission denied/);
});

test('legacy jobs retain ordinary editing and pausing but location edits need a complete address', async () => {
  await asUser(cafe);
  const { rows } = await db.query("update jobs set title='Updated legacy role',active=false where id=$1 returning location,state", [legacyJob]);
  assert.deepEqual(rows[0], { location: 'Miami', state: null });
  await rejected(() => db.query("update jobs set state='NY' where id=$1", [legacyJob]), /street address/);
  const fixed = await db.query("update jobs set state='NY',city='Brooklyn',address_line1='123 Test St',postal_code='11201' where id=$1 returning location", [legacyJob]);
  assert.equal(fixed.rows[0].location, 'Brooklyn, NY, 11201');
});

test('the validation trigger remains an unprivileged function unavailable for direct client calls', async () => {
  const { rows } = await db.query("select prosecdef,has_function_privilege('anon',oid,'execute') anon,has_function_privilege('authenticated',oid,'execute') authenticated from pg_proc where oid='public.validate_job_location()'::regprocedure");
  assert.deepEqual(rows[0], { prosecdef: false, anon: false, authenticated: false });
});
