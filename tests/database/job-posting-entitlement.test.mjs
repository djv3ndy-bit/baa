import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, afterEach, before, beforeEach, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';

const BARISTA = '00000000-0000-4000-8000-000000000001';
const LEGACY_CAFE = '00000000-0000-4000-8000-000000000002';
const ACTIVE_CAFE = '00000000-0000-4000-8000-000000000003';
const FRESH_CAFE = '00000000-0000-4000-8000-000000000004';
const TRIAL_CAFE = '00000000-0000-4000-8000-000000000005';
const EXPIRED_CAFE = '00000000-0000-4000-8000-000000000006';
const PAST_DUE_CAFE = '00000000-0000-4000-8000-000000000007';
const INVALID_ID_CAFE = '00000000-0000-4000-8000-000000000008';
const OTHER_BARISTA = '00000000-0000-4000-8000-000000000009';
const ORPHAN_SUB_CAFE = '00000000-0000-4000-8000-000000000010';
const OVERFLOW_CAFE = '00000000-0000-4000-8000-000000000011';

const LEGACY_FIRST = '10000000-0000-4000-8000-000000000001';
const LEGACY_SECOND = '10000000-0000-4000-8000-000000000002';
const ACTIVE_FIRST = '10000000-0000-4000-8000-000000000003';
const ACTIVE_SECOND = '10000000-0000-4000-8000-000000000004';

const fixture = readFileSync(
  new URL('./job-posting-entitlement-fixture.sql', import.meta.url),
  'utf8',
);
const migration = readFileSync(
  new URL('../../supabase/migrations/20260908100000_enforce_cafe_job_posting_entitlements.sql', import.meta.url),
  'utf8',
) + '\n' + readFileSync(
  new URL('../../supabase/migrations/20260908110000_consolidate_job_participant_visibility.sql', import.meta.url),
  'utf8',
);

let db;
const query = (text, params = []) => db.query(text, params);

async function asUser(id) {
  await db.exec('reset role');
  await query("select set_config('request.jwt.claim.sub', $1, true)", [id]);
  await db.exec('set local role authenticated');
}

async function asRoot() {
  await db.exec('reset role');
}

async function expectDatabaseError(
  text,
  params = [],
  expectedCode = 'PJB01',
  expectedMessage = /JOB_PRO_SUBSCRIPTION_REQUIRED/,
) {
  await db.exec('savepoint expected_database_error');
  let caught;
  try {
    await query(text, params);
  } catch (error) {
    caught = error;
  } finally {
    await db.exec(
      'rollback to savepoint expected_database_error; release savepoint expected_database_error',
    );
  }
  assert.ok(caught, 'expected the database statement to fail');
  assert.equal(caught.code, expectedCode);
  assert.match(caught.message, expectedMessage);
}

async function applyMigration() {
  await db.exec('begin');
  try {
    await db.exec(migration);
    await db.exec('commit');
  } catch (error) {
    await db.exec('rollback');
    throw error;
  }
}

before(async () => {
  db = new PGlite();
  await db.exec(fixture);
  await applyMigration();
});

beforeEach(async () => {
  await db.exec('begin');
});

afterEach(async () => {
  await db.exec('rollback');
});

after(async () => {
  await db.close();
});

test('backfill assigns the deterministic earliest job and pauses unpaid excess rows', async () => {
  const ledger = await query(`
    select cafe_id, free_job_id
    from private.cafe_job_entitlements
    order by cafe_id
  `);
  assert.deepEqual(ledger.rows, [
    { cafe_id: LEGACY_CAFE, free_job_id: LEGACY_FIRST },
    { cafe_id: ACTIVE_CAFE, free_job_id: ACTIVE_FIRST },
    { cafe_id: OVERFLOW_CAFE, free_job_id: '11000000-0000-4000-8000-000000000001' },
  ]);

  const jobs = await query(`
    select id, active
    from public.jobs
    order by id
  `);
  assert.deepEqual(jobs.rows, [
    { id: LEGACY_FIRST, active: true },
    { id: LEGACY_SECOND, active: false },
    { id: ACTIVE_FIRST, active: true },
    { id: ACTIVE_SECOND, active: true },
    { id: '11000000-0000-4000-8000-000000000001', active: true },
    { id: '11000000-0000-4000-8000-000000000002', active: true },
    { id: '11000000-0000-4000-8000-000000000003', active: true },
    { id: '11000000-0000-4000-8000-000000000004', active: false },
  ]);

  await asUser(BARISTA);
  assert.deepEqual(
    (await query('select id from public.jobs order by id')).rows.map(({ id }) => id),
    [
      LEGACY_FIRST,
      ACTIVE_FIRST,
      ACTIVE_SECOND,
      '11000000-0000-4000-8000-000000000001',
      '11000000-0000-4000-8000-000000000002',
      '11000000-0000-4000-8000-000000000003',
    ],
  );

  await asUser(LEGACY_CAFE);
  assert.deepEqual(
    (await query('select id from public.jobs where owner_id = $1 order by id', [LEGACY_CAFE])).rows.map(({ id }) => id),
    [LEGACY_FIRST, LEGACY_SECOND],
  );
});

test('one first job is free, but every distinct later row needs Stripe even as an inactive draft', async () => {
  const first = '30000000-0000-4000-8000-000000000001';
  const second = '30000000-0000-4000-8000-000000000002';

  await asUser(FRESH_CAFE);
  assert.equal((await query('select public.cafe_can_create_job() allowed')).rows[0].allowed, true);
  await query(
    "insert into public.jobs(id, owner_id, title, location) values($1, $2, 'First', 'Tampa, FL')",
    [first, FRESH_CAFE],
  );
  assert.equal((await query('select public.cafe_can_create_job() allowed')).rows[0].allowed, false);

  await expectDatabaseError(
    "insert into public.jobs(id, owner_id, title, location, active) values($1, $2, 'Second draft', 'Tampa, FL', false)",
    [second, FRESH_CAFE],
  );
  assert.equal(
    (await query('select count(*)::int count from public.jobs where owner_id = $1', [FRESH_CAFE])).rows[0].count,
    1,
  );
});

test('deleting the free job cannot reset the lifetime allowance or reuse its UUID', async () => {
  const first = '31000000-0000-4000-8000-000000000001';

  await asUser(FRESH_CAFE);
  await query(
    "insert into public.jobs(id, owner_id, title, location) values($1, $2, 'First', 'Tampa, FL')",
    [first, FRESH_CAFE],
  );
  await query('delete from public.jobs where id = $1', [first]);

  await asRoot();
  const entitlement = (
    await query(`
      select free_job_id, free_job_deleted_at is not null as deleted
      from private.cafe_job_entitlements
      where cafe_id = $1
    `, [FRESH_CAFE])
  ).rows[0];
  assert.deepEqual(entitlement, { free_job_id: first, deleted: true });

  await asUser(FRESH_CAFE);
  assert.equal((await query('select public.cafe_can_create_job() allowed')).rows[0].allowed, false);
  await expectDatabaseError(
    "insert into public.jobs(id, owner_id, title, location) values($1, $2, 'Replacement', 'Tampa, FL')",
    [first, FRESH_CAFE],
  );
});

test('active and unexpired trialing Stripe subscriptions allow later job rows', async () => {
  const trialFirst = '32000000-0000-4000-8000-000000000001';
  const trialSecond = '32000000-0000-4000-8000-000000000002';

  await asUser(TRIAL_CAFE);
  await query(
    "insert into public.jobs(id, owner_id, title, location) values($1, $2, 'Trial first', 'Miami, FL'), ($3, $2, 'Trial second', 'Miami, FL')",
    [trialFirst, TRIAL_CAFE, trialSecond],
  );
  assert.equal((await query('select public.cafe_can_create_job() allowed')).rows[0].allowed, true);

  await asUser(BARISTA);
  assert.deepEqual(
    (await query('select id from public.jobs where id in ($1, $2) order by id', [trialFirst, trialSecond])).rows.map(({ id }) => id),
    [trialFirst, trialSecond],
  );
  assert.equal(
    (await query('select count(*)::int count from public.jobs where id = $1', [ACTIVE_SECOND])).rows[0].count,
    1,
    'active status remains authoritative even if current_period_end is stale',
  );
});

test('the serialized Pro limit permits three active jobs and rejects a fourth publication', async () => {
  const third = '33000000-0000-4000-8000-000000000001';
  const fourth = '33000000-0000-4000-8000-000000000002';

  await asUser(ACTIVE_CAFE);
  await query(
    "insert into public.jobs(id, owner_id, title, location) values($1, $2, 'Paid third', 'Orlando, FL')",
    [third, ACTIVE_CAFE],
  );
  assert.equal((await query('select public.cafe_can_create_job() allowed')).rows[0].allowed, false);
  await expectDatabaseError(
    "insert into public.jobs(id, owner_id, title, location) values($1, $2, 'Paid fourth', 'Orlando, FL')",
    [fourth, ACTIVE_CAFE],
    'PJB04',
    /JOB_ACTIVE_LIMIT_REACHED/,
  );

  await query(
    "insert into public.jobs(id, owner_id, title, location, active) values($1, $2, 'Paid fourth draft', 'Orlando, FL', false)",
    [fourth, ACTIVE_CAFE],
  );
  await expectDatabaseError(
    'update public.jobs set active = true where id = $1',
    [fourth],
    'PJB04',
    /JOB_ACTIVE_LIMIT_REACHED/,
  );

  await query('update public.jobs set active = false where id = $1', [ACTIVE_SECOND]);
  await query('update public.jobs set active = true where id = $1', [fourth]);
  assert.equal(
    (await query('select count(*)::int count from public.jobs where owner_id = $1 and active', [ACTIVE_CAFE])).rows[0].count,
    3,
  );

  await asUser(BARISTA);
  assert.deepEqual(
    (await query('select id from public.jobs where owner_id = $1 order by id', [ACTIVE_CAFE])).rows.map(({ id }) => id),
    [ACTIVE_FIRST, third, fourth],
  );
});

test('a batch that races across the third-slot boundary is rejected atomically', async () => {
  await asUser(ACTIVE_CAFE);
  await expectDatabaseError(
    `insert into public.jobs(id, owner_id, title, location) values
      ('34000000-0000-4000-8000-000000000001', $1, 'Third candidate', 'Orlando, FL'),
      ('34000000-0000-4000-8000-000000000002', $1, 'Fourth candidate', 'Orlando, FL')`,
    [ACTIVE_CAFE],
    'PJB04',
    /JOB_ACTIVE_LIMIT_REACHED/,
  );

  assert.equal(
    (await query('select count(*)::int count from public.jobs where owner_id = $1 and active', [ACTIVE_CAFE])).rows[0].count,
    2,
  );
  assert.equal(
    (await query("select count(*)::int count from public.jobs where id::text like '34000000-%'")).rows[0].count,
    0,
  );
  assert.match(
    (await query("select pg_get_functiondef('private.enforce_job_posting_entitlement()'::regprocedure) definition")).rows[0].definition,
    /FOR UPDATE/i,
  );
});

test('complimentary access, expired trials, delinquency, malformed IDs, and orphan subscriptions never unlock a second job', async () => {
  const cases = [
    [FRESH_CAFE, '40000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000002'],
    [EXPIRED_CAFE, '40000000-0000-4000-8000-000000000003', '40000000-0000-4000-8000-000000000004'],
    [PAST_DUE_CAFE, '40000000-0000-4000-8000-000000000005', '40000000-0000-4000-8000-000000000006'],
    [INVALID_ID_CAFE, '40000000-0000-4000-8000-000000000007', '40000000-0000-4000-8000-000000000008'],
    [ORPHAN_SUB_CAFE, '40000000-0000-4000-8000-000000000009', '40000000-0000-4000-8000-000000000010'],
  ];

  for (const [cafe, first, second] of cases) {
    await asUser(cafe);
    await query(
      "insert into public.jobs(id, owner_id, title, location) values($1, $2, 'First', 'Miami, FL')",
      [first, cafe],
    );
    await expectDatabaseError(
      "insert into public.jobs(id, owner_id, title, location) values($1, $2, 'Second', 'Miami, FL')",
      [second, cafe],
    );
    assert.equal((await query('select public.cafe_can_create_job() allowed')).rows[0].allowed, false);
  }
});

test('paid-only jobs disappear dynamically on subscription loss while owners retain their rows', async () => {
  const application = '70000000-0000-4000-8000-000000000001';

  await asUser(BARISTA);
  assert.equal(
    (await query('select count(*)::int count from public.jobs where id = $1', [ACTIVE_SECOND])).rows[0].count,
    1,
  );

  await asRoot();
  await query(
    "insert into public.applications(id, job_id, barista_id, status) values($1, $2, $3, 'interested')",
    [application, ACTIVE_SECOND, BARISTA],
  );
  await query("update public.cafe_subscriptions set status = 'canceled' where user_id = $1", [ACTIVE_CAFE]);

  await asUser(OTHER_BARISTA);
  assert.equal(
    (await query('select count(*)::int count from public.jobs where id = $1', [ACTIVE_SECOND])).rows[0].count,
    0,
  );

  await expectDatabaseError(
    "insert into public.applications(job_id, barista_id, status) values($1, $2, 'interested')",
    [ACTIVE_SECOND, OTHER_BARISTA],
    '42501',
    /row-level security/,
  );

  await asUser(BARISTA);
  assert.equal(
    (await query('select count(*)::int count from public.jobs where id = $1', [ACTIVE_SECOND])).rows[0].count,
    1,
    'an existing applicant retains the related paused job row',
  );
  assert.equal(
    (await query('select count(*)::int count from public.jobs where id = $1', [ACTIVE_FIRST])).rows[0].count,
    1,
  );

  await asUser(ACTIVE_CAFE);
  assert.equal(
    (await query('select active from public.jobs where id = $1', [ACTIVE_SECOND])).rows[0].active,
    false,
  );
  assert.equal(
    (await query('select public.cafe_has_hiring_access($1) allowed', [ACTIVE_CAFE])).rows[0].allowed,
    false,
  );
  await query("update public.applications set status = 'matched' where id = $1", [application]);
  await query(
    "insert into public.messages(application_id, sender_id, body) values($1, $2, 'Owner follow-up after lapse')",
    [application, ACTIVE_CAFE],
  );
  await expectDatabaseError('update public.jobs set active = true where id = $1', [ACTIVE_SECOND]);

  await asUser(BARISTA);
  await query(
    "insert into public.messages(application_id, sender_id, body) values($1, $2, 'Applicant reply after lapse')",
    [application, BARISTA],
  );
  assert.equal(
    (await query('select count(*)::int count from public.messages where application_id = $1', [application])).rows[0].count,
    2,
  );

  await asRoot();
  await query("update public.cafe_subscriptions set status = 'active' where user_id = $1", [ACTIVE_CAFE]);
  await asUser(ACTIVE_CAFE);
  await query('update public.jobs set active = true where id = $1', [ACTIVE_SECOND]);
  await asUser(BARISTA);
  assert.equal(
    (await query('select count(*)::int count from public.jobs where id = $1', [ACTIVE_SECOND])).rows[0].count,
    1,
  );
});

test('the original free job remains editable, pausable, and reopenable without Stripe', async () => {
  await asUser(LEGACY_CAFE);
  await query("update public.jobs set title = 'Edited free job', active = false where id = $1", [LEGACY_FIRST]);
  const reopened = await query('update public.jobs set active = true where id = $1 returning title, active', [LEGACY_FIRST]);
  assert.deepEqual(reopened.rows[0], { title: 'Edited free job', active: true });
  assert.equal((await query('select public.cafe_has_hiring_access($1) allowed', [LEGACY_CAFE])).rows[0].allowed, true);
});

test('owner pause repair stays self-only, security-invoker, and keeps complimentary first-job hiring access', async () => {
  const metadata = (
    await query(`
      select prosecdef
      from pg_proc
      where oid = 'public.cafe_has_hiring_access(uuid)'::regprocedure
    `)
  ).rows[0];
  assert.equal(metadata.prosecdef, false);
  assert.equal(
    (await query(`
      select count(*)::int count
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'cafe_subscriptions'
        and column_name = 'owner_paused_at'
    `)).rows[0].count,
    1,
  );
  assert.equal(
    (await query("select has_column_privilege('service_role', 'public.jobs', 'city', 'select') allowed")).rows[0].allowed,
    true,
  );

  await asUser(LEGACY_CAFE);
  assert.equal((await query('select public.cafe_has_hiring_access($1) allowed', [LEGACY_CAFE])).rows[0].allowed, true);
  assert.equal((await query('select public.cafe_has_hiring_access($1) allowed', [ACTIVE_CAFE])).rows[0].allowed, false);

  await asRoot();
  await query('update public.cafe_subscriptions set owner_paused_at = now() where user_id = $1', [LEGACY_CAFE]);
  await asUser(LEGACY_CAFE);
  assert.equal((await query('select public.cafe_has_hiring_access($1) allowed', [LEGACY_CAFE])).rows[0].allowed, false);

  await asUser(BARISTA);
  assert.equal((await query('select public.cafe_has_hiring_access($1) allowed', [BARISTA])).rows[0].allowed, true);
});

test('subscription deletion and profile cascade remain safe because the pause trigger never handles DELETE', async () => {
  const triggerEvents = await query(`
    select event_manipulation
    from information_schema.triggers
    where event_object_schema = 'public'
      and event_object_table = 'cafe_subscriptions'
      and trigger_name = 'pause_jobs_without_paid_entitlement'
    order by event_manipulation
  `);
  assert.deepEqual(triggerEvents.rows, [
    { event_manipulation: 'INSERT' },
    { event_manipulation: 'UPDATE' },
  ]);

  await asRoot();
  await query('delete from public.profiles where id = $1', [ACTIVE_CAFE]);
  assert.equal(
    (await query('select count(*)::int count from public.cafe_subscriptions where user_id = $1', [ACTIVE_CAFE])).rows[0].count,
    0,
  );
  assert.equal(
    (await query('select count(*)::int count from public.jobs where owner_id = $1', [ACTIVE_CAFE])).rows[0].count,
    0,
  );
  assert.equal(
    (await query('select count(*)::int count from private.cafe_job_entitlements where cafe_id = $1', [ACTIVE_CAFE])).rows[0].count,
    0,
  );
});

test('a failed multi-row insert rolls back both jobs and the lifetime ledger atomically', async () => {
  await asUser(FRESH_CAFE);
  await expectDatabaseError(
    `insert into public.jobs(id, owner_id, title, location) values
      ('50000000-0000-4000-8000-000000000001', $1, 'First', 'Miami, FL'),
      ('50000000-0000-4000-8000-000000000002', $1, 'Second', 'Miami, FL')`,
    [FRESH_CAFE],
  );

  await asRoot();
  assert.equal(
    (await query('select count(*)::int count from public.jobs where owner_id = $1', [FRESH_CAFE])).rows[0].count,
    0,
  );
  assert.equal(
    (await query('select count(*)::int count from private.cafe_job_entitlements where cafe_id = $1', [FRESH_CAFE])).rows[0].count,
    0,
  );

  await asUser(FRESH_CAFE);
  await query(
    "insert into public.jobs(id, owner_id, title, location) values('50000000-0000-4000-8000-000000000003', $1, 'First retry', 'Miami, FL')",
    [FRESH_CAFE],
  );
});

test('job identity cannot be rewritten to bypass the durable free-job assignment', async () => {
  await asUser(LEGACY_CAFE);
  await expectDatabaseError(
    "update public.jobs set id = '60000000-0000-4000-8000-000000000001' where id = $1",
    [LEGACY_FIRST],
    'PJB02',
    /JOB_IDENTITY_IMMUTABLE/,
  );
  await expectDatabaseError(
    'update public.jobs set owner_id = $1 where id = $2',
    [ACTIVE_CAFE, LEGACY_FIRST],
    'PJB02',
    /JOB_IDENTITY_IMMUTABLE/,
  );
});

test('private ledger and trigger helpers stay inaccessible to browser roles', async () => {
  const privileges = (
    await query(`
      select
        has_table_privilege('authenticated', 'private.cafe_job_entitlements', 'select') as ledger_select,
        has_table_privilege('authenticated', 'private.cafe_job_entitlements', 'insert') as ledger_insert,
        has_table_privilege('anon', 'private.cafe_job_entitlements', 'select') as anon_ledger_select,
        has_function_privilege('authenticated', 'private.cafe_has_paid_job_entitlement(uuid)', 'execute') as paid_helper,
        has_function_privilege('authenticated', 'private.job_caller_is_application_participant(uuid,uuid)', 'execute') as participant_helper,
        has_function_privilege('authenticated', 'private.enforce_job_posting_entitlement()', 'execute') as write_helper,
        has_function_privilege('authenticated', 'private.record_free_job_deletion()', 'execute') as delete_helper,
        has_function_privilege('authenticated', 'private.pause_jobs_without_paid_entitlement()', 'execute') as pause_helper,
        has_function_privilege('authenticated', 'private.job_has_publication_entitlement(uuid,uuid)', 'execute') as rls_helper,
        has_function_privilege('authenticated', 'public.cafe_can_create_job()', 'execute') as preflight,
        has_function_privilege('anon', 'public.cafe_can_create_job()', 'execute') as anon_preflight
    `)
  ).rows[0];
  assert.deepEqual(privileges, {
    ledger_select: false,
    ledger_insert: false,
    anon_ledger_select: false,
    paid_helper: false,
    participant_helper: true,
    write_helper: false,
    delete_helper: false,
    pause_helper: false,
    rls_helper: true,
    preflight: true,
    anon_preflight: false,
  });

  const jobPrivileges = (
    await query(`
      select
        has_table_privilege('authenticated', 'public.jobs', 'truncate') as authenticated_truncate,
        has_table_privilege('authenticated', 'public.jobs', 'trigger') as authenticated_trigger,
        has_table_privilege('authenticated', 'public.jobs', 'references') as authenticated_references,
        has_table_privilege('anon', 'public.jobs', 'truncate') as anon_truncate,
        has_table_privilege('anon', 'public.jobs', 'trigger') as anon_trigger,
        has_table_privilege('anon', 'public.jobs', 'references') as anon_references
    `)
  ).rows[0];
  assert.deepEqual(jobPrivileges, {
    authenticated_truncate: false,
    authenticated_trigger: false,
    authenticated_references: false,
    anon_truncate: false,
    anon_trigger: false,
    anon_references: false,
  });

  await asUser(FRESH_CAFE);
  await expectDatabaseError(
    'select * from private.cafe_job_entitlements',
    [],
    '42501',
    /permission denied/,
  );
  await expectDatabaseError(
    "update public.cafe_subscriptions set status = 'active', stripe_subscription_id = 'sub_forged' where user_id = $1",
    [FRESH_CAFE],
    '42501',
    /permission denied/,
  );
});

test('migration is repeatable without reassigning free jobs or duplicating policy and triggers', async () => {
  const before = await query(`
    select cafe_id, free_job_id, free_job_deleted_at
    from private.cafe_job_entitlements
    order by cafe_id
  `);
  await asRoot();
  await db.exec(migration);
  const after = await query(`
    select cafe_id, free_job_id, free_job_deleted_at
    from private.cafe_job_entitlements
    order by cafe_id
  `);
  assert.deepEqual(after.rows, before.rows);

  assert.equal(
    (await query(`
      select count(*)::int count
      from pg_policies
      where schemaname = 'public'
        and tablename = 'jobs'
        and policyname = 'Members need publication entitlement for paid jobs'
        and permissive = 'RESTRICTIVE'
    `)).rows[0].count,
    1,
  );
  assert.equal(
    (await query(`
      select count(*)::int count
      from pg_policies
      where schemaname = 'public'
        and tablename = 'jobs'
        and cmd = 'SELECT'
        and permissive = 'PERMISSIVE'
    `)).rows[0].count,
    1,
  );
  assert.equal(
    (await query(`
      select count(*)::int count
      from pg_policies
      where schemaname = 'public'
        and tablename = 'jobs'
        and policyname = 'Application participants can view their jobs'
    `)).rows[0].count,
    0,
  );
  assert.equal(
    (await query(`
      select count(*)::int count
      from pg_trigger
      where tgrelid = 'public.jobs'::regclass
        and not tgisinternal
        and tgname in ('enforce_job_posting_entitlement', 'record_free_job_deletion')
    `)).rows[0].count,
    2,
  );
});
