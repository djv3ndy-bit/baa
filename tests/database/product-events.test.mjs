import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';

const migration = readFileSync(new URL('../../supabase/migrations/20260928121018_repair_activation_product_events.sql', import.meta.url), 'utf8');
const a = '00000000-0000-4000-8000-000000000001';
const b = '00000000-0000-4000-8000-000000000002';
// Relevant live columns, FK, grants and policy captured read-only on 2026-09-28.
// The legacy variant reproduces PR #64's missing-column failure. No live writes.
const fixture = `
  create role anon; create role authenticated; create role service_role bypassrls;
  create schema auth;
  grant usage on schema public, auth to anon, authenticated, service_role;
  create function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
  $$;
  create table auth.users(id uuid primary key);
  insert into auth.users values ('${a}'), ('${b}');
  create table public.product_events (
    id bigint generated always as identity primary key,
    user_id uuid references auth.users(id) on delete set null,
    event_name text not null,
    created_at timestamptz not null default now()
  );
  grant insert on public.product_events to authenticated;
  grant truncate, references, trigger on public.product_events to anon, authenticated, service_role;
  alter table public.product_events enable row level security;
  create policy "Members can record own product events" on public.product_events
    for insert to authenticated with check (user_id = (select auth.uid()));
`;
async function permissions(db) {
  return {
    rls: (await db.query("select relrowsecurity,relforcerowsecurity from pg_class where oid='public.product_events'::regclass")).rows,
    policies: (await db.query("select policyname,permissive,roles,cmd,qual,with_check from pg_policies where tablename='product_events'")).rows,
    grants: (await db.query("select grantee,privilege_type from information_schema.role_table_grants where table_name='product_events' order by grantee,privilege_type")).rows,
  };
}
async function asUser(db, user, role = 'authenticated') {
  await db.exec('reset role');
  await db.query("select set_config('request.jwt.claim.sub',$1,true)", [user || '']);
  await db.exec(`set local role ${role}`);
}
async function denied(db, sql, params = [], pattern = /permission denied|row-level security/) {
  await db.exec('savepoint rejection');
  await assert.rejects(db.query(sql, params), pattern);
  await db.exec('rollback to savepoint rejection; release savepoint rejection');
}

for (const existingMetadata of [false, true]) {
  test(`migration repairs ${existingMetadata ? 'live schema drift' : 'missing metadata'} without changing RLS, grants, or existing events`, async () => {
    const db = new PGlite();
    try {
      await db.exec(fixture);
      if (existingMetadata) await db.exec("alter table public.product_events add column metadata jsonb not null default '{}'::jsonb");
      await db.query("insert into product_events(user_id,event_name) values($1,'legacy_event')", [a]);
      const before = await permissions(db);
      if (!existingMetadata) await assert.rejects(db.query("insert into product_events(user_id,event_name,metadata) values($1,'job_viewed','{}')", [a]), /metadata/);
      await db.exec(`begin; ${migration} commit;`);
      await db.exec(`begin; ${migration} commit;`);
      assert.deepEqual(await permissions(db), before);
      assert.deepEqual((await db.query("select metadata from product_events where event_name='legacy_event'")).rows, [{ metadata: {} }]);
      await db.exec('begin');
      await asUser(db, a);
      for (const event of ['signup_completed', 'post_job_started', 'job_posted', 'job_viewed', 'apply_started', 'application_submitted']) {
        await db.query('insert into product_events(user_id,event_name,metadata) values($1,$2,$3)', [a, event, { surface: 'mobile', role: 'barista' }]);
      }
      // Old clients can still omit metadata; repeatable steps stay repeatable.
      await db.query("insert into product_events(user_id,event_name) values($1,'job_viewed')", [a]);
      await denied(db, "insert into product_events(user_id,event_name) values($1,'signup_completed')", [a], /product_events_signup_completed_user_idx/);
      await denied(db, "insert into product_events(user_id,event_name) values($1,'job_viewed')", [b]);
      await denied(db, 'select * from product_events');
      await denied(db, "update product_events set event_name='forged'");
      await denied(db, 'delete from product_events');
      await asUser(db, b);
      await db.query("insert into product_events(user_id,event_name) values($1,'signup_completed')", [b]);
      await asUser(db, null);
      await denied(db, "insert into product_events(user_id,event_name) values($1,'job_viewed')", [a]);
      await denied(db, "insert into product_events(user_id,event_name) values(null,'job_viewed')");
      await asUser(db, null, 'anon');
      await denied(db, "insert into product_events(user_id,event_name) values($1,'job_viewed')", [a]);
      await db.exec('reset role');
      assert.equal((await db.query("select count(*)::int as n from product_events where event_name='signup_completed'")).rows[0].n, 2);
      assert.equal((await db.query("select count(*)::int as n from product_events where event_name='job_viewed'")).rows[0].n, 2);
      await db.exec('commit');
    } finally { await db.close(); }
  });
}

test('a pre-existing duplicate completion stops migration without deleting history or widening permissions', async () => {
  const db = new PGlite();
  try {
    await db.exec(fixture);
    await db.query("insert into product_events(user_id,event_name) values($1,'signup_completed'),($1,'signup_completed')", [a]);
    const before = await permissions(db);
    await assert.rejects(db.exec(`begin; ${migration} commit;`), /could not create unique index/);
    await db.exec('rollback');
    assert.deepEqual(await permissions(db), before);
    assert.equal((await db.query('select count(*)::int as n from product_events')).rows[0].n, 2);
  } finally { await db.close(); }
});
