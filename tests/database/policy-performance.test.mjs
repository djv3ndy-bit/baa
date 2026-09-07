import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, afterEach, before, beforeEach, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';

const a = '00000000-0000-4000-8000-000000000001', b = '00000000-0000-4000-8000-000000000002';
const migration = readFileSync(new URL('../../supabase/migrations/20260907061824_optimize_account_policy_auth_checks.sql', import.meta.url), 'utf8');
const policiesQuery = "select tablename,policyname,permissive,roles,cmd,qual,with_check from pg_policies where schemaname='public' order by tablename,policyname";
const grantsQuery = "select table_name,column_name,grantee,privilege_type from information_schema.column_privileges where table_schema='public' order by table_name,column_name,grantee,privilege_type";
let db, policiesBefore, grantsBefore;
const query = (sql, params = []) => db.query(sql, params);
async function asUser(id, role = 'authenticated') {
  await db.exec('reset role');
  await query("select set_config('request.jwt.claim.sub',$1,true)", [id || '']);
  await db.exec(`set local role ${role}`);
}
async function rejected(sql, params = []) {
  await db.exec('savepoint denied');
  try { await assert.rejects(query(sql, params), /permission denied|row-level security/); }
  finally { await db.exec('rollback to savepoint denied; release savepoint denied'); }
}
const normalize = value => value == null ? value : value.replace(/\(\s*SELECT auth\.uid\(\) AS uid\s*\)/g, 'auth.uid()');
const normalizedPolicy = row => ({ ...row, qual: normalize(row.qual), with_check: normalize(row.with_check) });

before(async () => {
  db = new PGlite();
  await db.exec(readFileSync(new URL('./policy-performance-fixture.sql', import.meta.url), 'utf8'));
  policiesBefore = (await query(policiesQuery)).rows;
  grantsBefore = (await query(grantsQuery)).rows;
  await db.exec(`begin; ${migration} commit;`);
});
beforeEach(() => db.exec('begin'));
afterEach(() => db.exec('rollback'));
after(() => db.close());

test('all policy predicates, roles, commands, permissive mode and grants remain semantically identical', async () => {
  const after = (await query(policiesQuery)).rows;
  assert.deepEqual(after.map(normalizedPolicy), policiesBefore.map(normalizedPolicy));
  assert.deepEqual((await query(grantsQuery)).rows, grantsBefore);
  const changed = after.filter((row, index) => JSON.stringify(row) !== JSON.stringify(policiesBefore[index]));
  assert.equal(changed.length, 8);
  const billing = row => row.tablename === 'cafe_subscriptions' && row.cmd !== 'SELECT';
  assert.deepEqual(after.filter(billing), policiesBefore.filter(billing));
});

test('migration is repeatable and only adds the sender foreign-key index', async () => {
  await db.exec(migration);
  const indexes = (await query("select indexname,indexdef from pg_indexes where tablename='discovery_messages' order by indexname")).rows;
  assert.deepEqual(indexes.map(row => row.indexname), ['discovery_messages_match_created_idx', 'discovery_messages_pkey', 'discovery_messages_sender_id_idx']);
  assert.match(indexes.at(-1).indexdef, /\(sender_id\)$/);
});

test('own notifications can be read and acknowledged; other recipient rows and identity edits remain inaccessible', async () => {
  await asUser(a);
  assert.deepEqual((await query('select recipient_id from notifications')).rows, [{ recipient_id: a }]);
  assert.equal((await query('update notifications set read_at=now() returning id')).rows.length, 1);
  assert.equal((await query('update notifications set read_at=now() where recipient_id=$1 returning id', [b])).rows.length, 0);
  await rejected('update notifications set recipient_id=$1', [b]);
  await rejected("insert into notifications(recipient_id,body) values($1,'forged')", [a]);
});

test('notification preferences preserve own create/update access and prevent cross-account reassignment', async () => {
  await db.exec('delete from notification_preferences');
  await asUser(a);
  await query('insert into notification_preferences(user_id,enabled) values($1,false)', [a]);
  await rejected('insert into notification_preferences(user_id) values($1)', [b]);
  await query('update notification_preferences set enabled=true where user_id=$1', [a]);
  await rejected('update notification_preferences set user_id=$1 where user_id=$2', [b, a]);
  await asUser(b);
  assert.equal((await query('select * from notification_preferences')).rows.length, 0);
  assert.equal((await query('update notification_preferences set enabled=false returning user_id')).rows.length, 0);
});

test('job swipes remain scoped on select/insert/update; the existing DELETE grant is not widened', async () => {
  await asUser(a);
  assert.deepEqual((await query('select user_id from job_swipes')).rows, [{ user_id: a }]);
  await query("insert into job_swipes(user_id,direction) values($1,'left')", [a]);
  await rejected("insert into job_swipes(user_id,direction) values($1,'left')", [b]);
  assert.equal((await query("update job_swipes set direction='left' where user_id=$1 returning id", [b])).rows.length, 0);
  await rejected('update job_swipes set user_id=$1 where user_id=$2', [b, a]);
  await rejected('delete from job_swipes where user_id=$1', [a]);
});

test('own subscriptions remain readable and existing café-only complimentary write predicates stay enforced', async () => {
  await asUser(a);
  assert.deepEqual((await query('select user_id from cafe_subscriptions')).rows, [{ user_id: a }]);
  assert.equal((await query('update cafe_subscriptions set complimentary_access=true where user_id=$1 returning user_id', [a])).rows.length, 0);
  await asUser(b);
  assert.equal((await query('update cafe_subscriptions set complimentary_access=true where user_id=$1 returning user_id', [b])).rows.length, 1);
  await rejected('update cafe_subscriptions set complimentary_access=false where user_id=$1', [b]);
});

test('product event inserts accept only the authenticated user and add no read or update access', async () => {
  await asUser(a);
  await query("insert into product_events(user_id,event_name) values($1,'synthetic')", [a]);
  await rejected("insert into product_events(user_id,event_name) values($1,'forged')", [b]);
  await rejected('select * from product_events');
  await rejected("update product_events set event_name='changed'");
});

test('anonymous and null-subject sessions gain no access; identity is recomputed for each new statement', async () => {
  await asUser(null, 'anon');
  for (const table of ['notifications', 'notification_preferences', 'job_swipes', 'cafe_subscriptions', 'product_events']) await rejected(`select * from ${table}`);
  await asUser(null);
  for (const table of ['notifications', 'notification_preferences', 'job_swipes', 'cafe_subscriptions']) assert.equal((await query(`select * from ${table}`)).rows.length, 0);
  await rejected("insert into product_events(user_id,event_name) values($1,'no-session')", [a]);
  await asUser(a); assert.equal((await query('select recipient_id from notifications')).rows[0].recipient_id, a);
  await asUser(b); assert.equal((await query('select recipient_id from notifications')).rows[0].recipient_id, b);
});

test('Postgres plans an InitPlan for the cached recipient check', async () => {
  await asUser(a);
  const plan = JSON.stringify((await query('explain (format json) select * from notifications')).rows);
  assert.match(plan, /InitPlan/);
  assert.match(plan, /recipient_id = (?:\$\d|\(InitPlan \d\)\.col1)/);
});

test('sender index supports lookup and preserves message deletion with the profile foreign key', async () => {
  await query('insert into discovery_matches(id) values($1)', [a]);
  await query('insert into discovery_messages(match_id,sender_id) values($1,$2)', [a, a]);
  await db.exec('set local enable_seqscan=off');
  const plan = JSON.stringify((await query('explain (format json) select id from discovery_messages where sender_id=$1', [a])).rows);
  assert.match(plan, /discovery_messages_sender_id_idx/);
  await query('delete from profiles where id=$1', [a]);
  assert.equal((await query('select * from discovery_messages')).rows.length, 0);
});
