import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, afterEach, before, beforeEach, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';

const cafe = '00000000-0000-4000-8000-000000000002';
const otherCafe = '00000000-0000-4000-8000-000000000004';
const barista = '00000000-0000-4000-8000-000000000001';
const migration = readFileSync(new URL('../../supabase/migrations/20260902030619_remove_authenticated_security_definer_functions.sql', import.meta.url), 'utf8');
const billingEnd = migration.indexOf('drop policy if exists "Matched recipients can mark messages read"');
assert.ok(billingEnd > 0, 'The real café function and permission definitions must be available.');
const billingSql = migration.slice(0, billingEnd);
// Reuse the subscription SELECT policy captured from production, then apply its
// real statement-cached ownership update. No hiring-access function is stubbed.
const policyFixture = readFileSync(new URL('./policy-performance-fixture.sql', import.meta.url), 'utf8');
const ownershipSql = policyFixture.match(/create policy "Cafe owners can view own subscription"[^;]+;/)?.[0];
const policyMigration = readFileSync(new URL('../../supabase/migrations/20260907061824_optimize_account_policy_auth_checks.sql', import.meta.url), 'utf8');
const optimizedOwnershipSql = policyMigration.match(/alter policy "Cafe owners can view own subscription"[^;]+;/)?.[0];
assert.ok(ownershipSql && optimizedOwnershipSql, 'The actual subscription ownership policies must be loaded.');

let db;
const query = (sql, parameters = []) => db.query(sql, parameters);
async function asUser(id, role = 'authenticated') {
  await db.exec('reset role');
  await query("select set_config('request.jwt.claim.sub', $1, true)", [id || '']);
  await db.exec(`set local role ${role}`);
}
async function denied(sql, parameters = [], pattern = /permission denied|row-level security/) {
  await db.exec('savepoint denied');
  try { await assert.rejects(query(sql, parameters), pattern); }
  finally { await db.exec('rollback to savepoint denied; release savepoint denied'); }
}
const access = async id => (await query('select public.cafe_has_hiring_access($1) as allowed', [id])).rows[0].allowed;
const ensure = () => query('select user_id, complimentary_access from public.ensure_cafe_subscription()');

before(async () => {
  db = new PGlite();
  // Minimal structural schema; the production migration supplies both access
  // functions, both complimentary policies, and all permitted write columns.
  await db.exec(`
    create role anon;
    create role authenticated;
    create role service_role bypassrls;
    create schema auth;
    grant usage on schema public, auth to anon, authenticated, service_role;
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
    $$;
    create table public.profiles(id uuid primary key, role text not null);
    create table public.cafe_subscriptions(
      user_id uuid primary key references public.profiles(id),
      complimentary_access boolean not null default false,
      status text, trial_ends_at timestamptz, owner_paused_at timestamptz,
      stripe_customer_id text, stripe_subscription_id text,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
    grant select on public.profiles to authenticated;
    grant select, insert, update on public.cafe_subscriptions to authenticated;
    alter table public.cafe_subscriptions enable row level security;
    ${ownershipSql}
    ${billingSql}
    ${optimizedOwnershipSql}
    insert into public.profiles(id, role) values
      ('${cafe}', 'cafe_owner_manager'),
      ('${otherCafe}', 'cafe_owner_manager'),
      ('${barista}', 'barista');
  `);
});
beforeEach(() => db.exec('begin'));
afterEach(() => db.exec('rollback'));
after(() => db.close());

test('a newly created café has no hiring access until the real bootstrap creates its subscription', async () => {
  await asUser(cafe);
  assert.equal((await query('select * from public.cafe_subscriptions')).rows.length, 0);
  assert.equal(await access(cafe), false);
  assert.deepEqual((await ensure()).rows, [{ user_id: cafe, complimentary_access: true }]);
  assert.equal(await access(cafe), true);
  await ensure();
  assert.equal((await query('select * from public.cafe_subscriptions')).rows.length, 1, 'Repeated startup must not create duplicate subscriptions.');
});

test('hiring access evaluates real status, trial expiry, complimentary access, and the caller identity', async () => {
  const cases = [
    ['active', false, null, true],
    ['trialing', false, '2099-01-01', true],
    ['trialing', false, '2000-01-01', false],
    ['trialing', false, null, false],
    ['canceled', false, null, false],
    ['canceled', true, null, true],
  ];
  for (const [status, complimentary, ends, expected] of cases) {
    await db.exec('reset role');
    await query('insert into cafe_subscriptions(user_id,status,complimentary_access,trial_ends_at) values($1,$2,$3,$4) on conflict(user_id) do update set status=excluded.status, complimentary_access=excluded.complimentary_access, trial_ends_at=excluded.trial_ends_at', [cafe, status, complimentary, ends]);
    await asUser(cafe); assert.equal(await access(cafe), expected, `${status}, complimentary=${complimentary}, trial=${ends}`);
    await asUser(otherCafe); assert.equal(await access(cafe), false, 'Access cannot be queried using another café identity.');
  }
  await asUser(barista); assert.equal(await access(barista), true, 'The existing non-café branch remains unchanged.');
});

test('baristas, anonymous callers and sessions with no subject cannot initialize café plans', async () => {
  await asUser(barista);
  await denied('select public.ensure_cafe_subscription()', [], /Cafe account required/);
  await denied('insert into cafe_subscriptions(user_id,complimentary_access) values($1,true)', [barista]);
  await denied('insert into cafe_subscriptions(user_id,complimentary_access) values($1,true)', [cafe]);
  await asUser(null);
  await denied('select public.ensure_cafe_subscription()', [], /Cafe account required/);
  for (const subject of [null, cafe]) {
    await asUser(subject, 'anon');
    await denied('select public.ensure_cafe_subscription()');
    await denied('select public.cafe_has_hiring_access($1)', [cafe]);
    await denied('insert into cafe_subscriptions(user_id,complimentary_access) values($1,true)', [cafe]);
  }
  await db.exec('reset role');
  assert.equal((await query('select count(*)::int as count from cafe_subscriptions')).rows[0].count, 0);
});

test('café initialization, reads and updates remain scoped to the caller account', async () => {
  await asUser(cafe); await ensure();
  await denied('insert into cafe_subscriptions(user_id,complimentary_access) values($1,true)', [otherCafe]);
  await asUser(otherCafe);
  assert.equal((await query('select * from cafe_subscriptions')).rows.length, 0);
  assert.equal(await access(otherCafe), false);
  await ensure();
  assert.deepEqual((await query('select user_id from cafe_subscriptions')).rows, [{ user_id: otherCafe }]);
  assert.equal((await query('update cafe_subscriptions set complimentary_access=true where user_id=$1 returning user_id', [cafe])).rows.length, 0);
  await db.exec('reset role');
  assert.equal((await query('select count(*)::int as count from cafe_subscriptions')).rows[0].count, 2);
});

test('authenticated cafés cannot edit subscription entitlements or identity beyond the existing complimentary grant', async () => {
  await asUser(cafe); await ensure();
  for (const [column, value] of [
    ['status', 'active'], ['trial_ends_at', '2099-01-01'], ['owner_paused_at', null],
    ['stripe_customer_id', 'cus_synthetic'], ['stripe_subscription_id', 'sub_synthetic'], ['user_id', otherCafe],
  ]) {
    await denied(`update cafe_subscriptions set ${column}=$1 where user_id=$2`, [value, cafe]);
  }
  await denied("insert into cafe_subscriptions(user_id,complimentary_access,status) values($1,true,'active')", [cafe]);
  await denied('update cafe_subscriptions set complimentary_access=false where user_id=$1', [cafe]);
  await denied('delete from cafe_subscriptions where user_id=$1', [cafe]);
  assert.equal((await query('update cafe_subscriptions set complimentary_access=true,updated_at=now() where user_id=$1 returning user_id', [cafe])).rows.length, 1);
});

test('billing-pause bootstrap restores complimentary access without changing saved commercial fields', async () => {
  await query("insert into cafe_subscriptions(user_id,complimentary_access,status,trial_ends_at,owner_paused_at,stripe_customer_id,stripe_subscription_id,updated_at) values($1,false,'canceled','2000-01-01','2026-01-01','cus_synthetic','sub_synthetic','2000-01-01')", [cafe]);
  const columns = 'status,trial_ends_at::text,owner_paused_at::text,stripe_customer_id,stripe_subscription_id,created_at::text';
  const before = (await query(`select ${columns} from cafe_subscriptions where user_id=$1`, [cafe])).rows[0];
  await asUser(cafe); assert.equal(await access(cafe), false);
  await ensure();
  assert.equal(await access(cafe), true, 'The latest live paused-billing function deliberately restores complimentary access.');
  assert.deepEqual((await query(`select ${columns} from cafe_subscriptions where user_id=$1`, [cafe])).rows[0], before);
  assert.equal((await query("select updated_at > '2000-01-01'::timestamptz as refreshed from cafe_subscriptions where user_id=$1", [cafe])).rows[0].refreshed, true);
});

test('both production access functions remain security invokers instead of bypassing row policies', async () => {
  const functions = (await query("select proname,prosecdef from pg_proc where oid in ('public.ensure_cafe_subscription()'::regprocedure,'public.cafe_has_hiring_access(uuid)'::regprocedure) order by proname")).rows;
  assert.deepEqual(functions, [{ proname: 'cafe_has_hiring_access', prosecdef: false }, { proname: 'ensure_cafe_subscription', prosecdef: false }]);
});
