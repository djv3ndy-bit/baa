import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { createHash } from 'node:crypto';

const reviewSql = readFileSync(new URL('../sql/office-read-review.sql', import.meta.url), 'utf8');
const OWNER='11111111-1111-4111-8111-111111111111';
const OTHER='22222222-2222-4222-8222-222222222222';
const CLIENT='33333333-3333-4333-8333-333333333333';
const SESSION='44444444-4444-4444-8444-444444444444';
const claims = (extra={}) => ({sub:OWNER, role:'bjm_office_reader', client_id:CLIENT, session_id:SESSION,
  aud:'https://office.example/mcp',iss:'https://project.example/auth/v1',scope:'openid',is_anonymous:false,
  iat:Math.floor(Date.now()/1000),exp:Math.floor(Date.now()/1000)+600,...extra});
const fixture = `
create role anon; create role authenticated; create role service_role bypassrls;
create role authenticator noinherit; create role supabase_auth_admin noinherit;
create schema auth; create schema storage; create schema graphql_public;
create schema extensions; create schema cron;
create table extensions.pg_stat_statements(query text);
create table cron.job(id integer);
create table cron.job_run_details(id integer);
grant select on extensions.pg_stat_statements,cron.job,cron.job_run_details to public;
grant delete on cron.job_run_details to public;
grant usage on schema public, auth, storage, graphql_public to anon,authenticated,service_role;
create table auth.users(id uuid primary key,email_confirmed_at timestamptz,is_anonymous boolean,deleted_at timestamptz,banned_until timestamptz);
create table auth.sessions(id uuid primary key,user_id uuid,oauth_client_id uuid,not_after timestamptz);
create table public.profiles(id uuid primary key,role text,email text);
create table public.jobs(id uuid primary key,active boolean,private_note text);
create table public.applications(id uuid primary key,status text,private_note text);
create table public.cafe_subscriptions(id uuid primary key,status text,cancel_at_period_end boolean,complimentary_access boolean,private_customer text);
create table public.subscription_payments(id uuid primary key,status text,created_at timestamptz,private_payment text);
create table public.support_tickets(id uuid primary key,status text,created_at timestamptz,email text,description text);
create table storage.objects(id uuid primary key,owner uuid,name text);
alter table public.profiles enable row level security;
alter table public.jobs enable row level security;
alter table public.applications enable row level security;
alter table public.cafe_subscriptions enable row level security;
alter table public.subscription_payments enable row level security;
alter table public.support_tickets enable row level security;
alter table storage.objects enable row level security;
grant select,insert,update,delete on public.profiles,public.jobs,public.applications,public.cafe_subscriptions to authenticated;
grant select,insert,update,delete on storage.objects to authenticated;
create policy customer_access on public.profiles to authenticated using(true) with check(true);
create policy customer_access on public.jobs to authenticated using(true) with check(true);
create policy customer_access on public.applications to authenticated using(true) with check(true);
create policy customer_access on public.cafe_subscriptions to authenticated using(true) with check(true);
create policy customer_storage on storage.objects to authenticated using(true) with check(true);
create function public.customer_write() returns void language sql security definer as $$insert into public.jobs values(gen_random_uuid(),true,'secret');$$;
revoke all on function public.customer_write() from public;
grant execute on function public.customer_write() to authenticated;
insert into auth.users values('${OWNER}',now(),false,null,null),('${OTHER}',now(),false,null,null);
insert into auth.sessions values('${SESSION}','${OWNER}','${CLIENT}',null);
insert into auth.sessions values('${OTHER}','${OTHER}','${CLIENT}',null),
 ('55555555-5555-4555-8555-555555555555','${OWNER}','${OTHER}',null);
insert into public.profiles values('${OWNER}','cafe_owner_manager','owner@private.test'),('${OTHER}','barista','barista@private.test');
insert into public.jobs values(gen_random_uuid(),true,'private');
insert into public.applications values(gen_random_uuid(),'new','private');
insert into public.cafe_subscriptions values(gen_random_uuid(),'active',false,false,'secret'),(gen_random_uuid(),'past_due',true,false,'secret');
insert into public.subscription_payments values(gen_random_uuid(),'succeeded',now(),'secret'),(gen_random_uuid(),'failed',now(),'secret'),(gen_random_uuid(),'failed',now()-interval '40 days','secret');
insert into public.support_tickets values(gen_random_uuid(),'investigating',now(),'private@private.test','private'),(gen_random_uuid(),'fixed',now(),'private@private.test','private'),(gen_random_uuid(),'new',now()-interval '40 days','private@private.test','private');
`;
// Exact immutable caller-input-only predicate independently inspected in the
// read-only catalog on 2026-10-13. Its default PUBLIC grant is safe only while
// the implementation/signature/security settings match this fingerprint.
const reviewedHelperBody = `
  select case when p.role = 'barista' then
    nullif(btrim(coalesce(p.display_name,'')),'') is not null and
    nullif(btrim(coalesce(p.avatar_url,'')),'') is not null and
    nullif(btrim(coalesce(p.location,'')),'') is not null and
    nullif(btrim(coalesce(p.bio,'')),'') is not null and
    exists(select 1 from unnest(p.skills) skill where nullif(btrim(skill),'') is not null) and
    nullif(btrim(coalesce(p.availability,'')),'') is not null and
    nullif(btrim(coalesce(p.experience,'')),'') is not null and
    nullif(btrim(coalesce(p.pay_expectation,'')),'') is not null
  when p.role = 'cafe_owner_manager' then
    nullif(btrim(coalesce(p.cafe_name,'')),'') is not null and
    nullif(btrim(coalesce(p.avatar_url,'')),'') is not null and
    nullif(btrim(coalesce(p.location,'')),'') is not null and
    nullif(btrim(coalesce(p.bio,'')),'') is not null and
    nullif(btrim(coalesce(p.cafe_address,'')),'') is not null and
    nullif(btrim(coalesce(p.open_hours,'')),'') is not null and
    nullif(btrim(coalesce(p.shop_type,'')),'') is not null and
    exists(select 1 from unnest(p.barista_preferences) preference where nullif(btrim(preference),'') is not null)
  else false end;
`;
async function setup() {
  const db=new PGlite();
  try {
    await db.exec(fixture); await db.exec(reviewSql);
    await db.query(`insert into bjm_office_private.configuration values(true,$1,$2,$3,$4,true)`,[OWNER,CLIENT,'https://office.example/mcp','https://project.example/auth/v1']);
    return db;
  } catch(error) { await db.close(); throw error; }
}
async function asReader(db, claimValues, sql='select public.office_read_snapshot() as snapshot', outerTransaction=false) {
  if (!outerTransaction) await db.exec('begin');
  await db.query(`select set_config('request.jwt.claims',$1,false)`,[JSON.stringify(claimValues)]);
  await db.exec('savepoint office_reader_call');
  // Change SESSION user too: testing SET ROLE as a superuser would wrongly
  // retain that session user's ability to switch into every other role.
  await db.exec('set local session authorization bjm_office_reader');
  try { return await db.query(sql); } finally {
    await db.exec('rollback to savepoint office_reader_call; release savepoint office_reader_call');
    // PGlite RESET SESSION AUTHORIZATION retains the changed session name;
    // restore the original test superuser explicitly after checking denial.
    await db.exec('set session authorization postgres; reset role');
    if (!outerTransaction) await db.exec('commit');
  }
}

test('unapplied SQL enforces isolated aggregate-only direct Data API role locally', async t => {
  const db=await setup();
  try {
    await t.test('verified owner can read only aggregate counts with correct source definitions',async()=>{
      const {rows}=await asReader(db,claims()); const snapshot=rows[0].snapshot;
      assert.deepEqual(snapshot.metrics,{profiles:2,cafes:1,baristas:1,jobs:1,applications:1,subscriptions:2,payments:3});
      assert.deepEqual(snapshot.support,{total_recent:2,open:1});
      assert.deepEqual(snapshot.billing.subscriptions,{total:2,active:1,past_due:1,canceling:1});
      assert.deepEqual(snapshot.billing.payments,{recent:2,failed:1,refunded:0});
      assert.doesNotMatch(JSON.stringify(snapshot), /private|email|description|customer|owner_id|client_id|session_id/);
    });
    await t.test('reader cannot read any raw source or storage, mutate tables, or call legacy mutation RPC',async()=>{
      for(const sql of ['select * from public.profiles','select * from public.support_tickets','select * from public.subscription_payments','select * from auth.users','select * from auth.sessions','select * from bjm_office_private.live_owner_sessions','select * from storage.objects',"insert into public.jobs values(gen_random_uuid(),true,'injected')",'update public.cafe_subscriptions set cancel_at_period_end=true','delete from public.applications','select public.customer_write()','set role authenticated','set role bjm_office_aggregate']) {
        await assert.rejects(asReader(db,claims(),sql),/permission denied/);
      }
      assert.equal((await db.query('select count(*)::int as n from public.jobs')).rows[0].n,1);
    });
    await t.test('PUBLIC metadata SELECT/DELETE grants in inaccessible schemas do not grant direct access',async()=>{
      for(const sql of ['select * from extensions.pg_stat_statements','select * from cron.job','select * from cron.job_run_details','delete from cron.job_run_details']) {
        await assert.rejects(asReader(db,claims(),sql),/permission denied for schema/);
      }
      assert.equal((await asReader(db,claims())).rows[0].snapshot.metrics.profiles,2);
    });
    await t.test('reachable PUBLIC DELETE alone fails the audit without any SELECT grant',async()=>{
      await db.exec('begin');
      try{
        await db.exec('revoke select on cron.job,cron.job_run_details from public; grant usage on schema cron to bjm_office_reader');
        await assert.rejects(asReader(db,claims(),undefined,true),/inherited table or sequence privileges/);
      }finally{await db.exec('rollback');}
    });
    await t.test('numeric-OID sequence calls bypass schema lookup, so PUBLIC sequence grants always fail audit',async()=>{
      await db.exec('begin');
      try{
        await db.exec('create sequence cron.disposable_sequence; grant usage,select,update on sequence cron.disposable_sequence to public');
        const sequenceOid=(await db.query("select c.oid from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='cron' and c.relname='disposable_sequence'")).rows[0].oid;
        await assert.rejects(asReader(db,claims(),"select nextval('cron.disposable_sequence')",true),/permission denied for schema/);
        assert.equal((await asReader(db,claims(),`select nextval(${sequenceOid}::oid::regclass) as value`,true)).rows[0].value,1);
        assert.equal((await asReader(db,claims(),`select pg_sequence_last_value(${sequenceOid}::oid::regclass) as value`,true)).rows[0].value,1);
        await assert.rejects(asReader(db,claims(),undefined,true),/inherited table or sequence privileges/);
      }finally{await db.exec('rollback');}
    });
    await t.test('granting access to a schema with PUBLIC metadata SELECT or DELETE fails the audit',async()=>{
      for(const schema of ['extensions','cron']){
        await db.exec('begin');
        try{
          await db.exec(`grant usage on schema ${schema} to bjm_office_reader`);
          await assert.rejects(asReader(db,claims(),undefined,true),/inherited table or sequence privileges/);
        }finally{await db.exec('rollback');}
      }
    });
    await t.test('nonowner, wrong client/audience/issuer/role/scope and stale/invalid claims deny direct RPC',async()=>{
      const invalids=[{sub:OTHER},{client_id:OTHER},{aud:'authenticated'},{aud:null},{iss:'https://evil.example/auth/v1'},{role:'authenticated'},
        {scope:''},{is_anonymous:true},{exp:1},{exp:null},{iat:null},{exp:Math.floor(Date.now()/1000)+7200},{session_id:OTHER},
        {session_id:'55555555-5555-4555-8555-555555555555'},{nbf:Math.floor(Date.now()/1000)+600}];
      for(const invalid of invalids) await assert.rejects(asReader(db,claims(invalid)),/Office access denied/);
    });
    await t.test('disabled configuration, revoked session, wrong session client, and banned owner deny RPC',async()=>{
      for(const sql of ['update bjm_office_private.configuration set enabled=false',`update bjm_office_private.configuration set owner_id='${OTHER}'`,
        'delete from auth.sessions',`update auth.sessions set oauth_client_id='${OTHER}'`,"update auth.sessions set not_after=now()-interval '1 day'",
        "update auth.users set banned_until=now()+interval '1 day'",'update auth.users set is_anonymous=true',
        'update auth.users set email_confirmed_at=null','update auth.users set deleted_at=now()']){
        await db.exec('begin');
        try{await db.exec(sql);await assert.rejects(asReader(db,claims(),undefined,true),/Office access denied/);}finally{await db.exec('rollback');}
      }
    });
    await t.test('private view delegates only configured owner/client live session IDs and no raw Auth access',async()=>{
      await db.exec('set role bjm_office_aggregate');
      try{
        assert.deepEqual((await db.query('select * from bjm_office_private.live_owner_sessions')).rows,[{session_id:SESSION,user_id:OWNER}]);
        for(const sql of ['select * from auth.users','select * from auth.sessions']) await assert.rejects(db.query(sql),/permission denied/);
      }finally{await db.exec('reset role');}
      for(const role of ['anon','authenticated']){
        await db.exec(`set role ${role}`);
        try{await assert.rejects(db.query('select * from bjm_office_private.live_owner_sessions'),/permission denied/);}finally{await db.exec('reset role');}
      }
    });
    await t.test('view definition, owner, options, object-comment baseline, and ACL drift fail before session lookup',async()=>{
      for(const [change,expected] of [
        ['create or replace view bjm_office_private.live_owner_sessions with(security_barrier=true,security_invoker=false) as select id as session_id,user_id from auth.sessions',/view contract/],
        ['alter view bjm_office_private.live_owner_sessions owner to bjm_office_aggregate',/view contract/],
        ['alter view bjm_office_private.live_owner_sessions set(security_barrier=false)',/view contract/],
        ['alter view bjm_office_private.live_owner_sessions set(security_invoker=true)',/view contract/],
        ["comment on view bjm_office_private.live_owner_sessions is 'invalid'",/view contract/],
        ['grant select on bjm_office_private.live_owner_sessions to bjm_office_reader',/view grants/],
        ['grant select(session_id) on bjm_office_private.live_owner_sessions to authenticated',/view grants/],
        ['grant select on bjm_office_private.live_owner_sessions to bjm_office_aggregate with grant option',/view grants/],
        ['grant update on bjm_office_private.live_owner_sessions to bjm_office_aggregate',/view grants/],
        ['create rule extra_view_rule as on update to bjm_office_private.live_owner_sessions do instead nothing',/projection or rules/],
        ['grant usage on schema auth to bjm_office_aggregate',/direct Auth privileges/],
        ['grant select(id) on auth.sessions to bjm_office_aggregate',/direct Auth privileges/],
      ]){
        await db.exec('begin');
        try{await db.exec(change);await assert.rejects(asReader(db,claims(),undefined,true),expected);}finally{await db.exec('rollback');}
      }
    });
    await t.test('missing source privilege produces partial nulls, never a false zero',async()=>{
      await db.exec('begin');
      try {
        await db.exec('revoke select(status,created_at) on public.subscription_payments from bjm_office_aggregate');
        const snapshot=(await asReader(db,claims(),undefined,true)).rows[0].snapshot;
        assert.equal(snapshot.metrics.payments,null);assert.equal(snapshot.billing.payments.recent,null);assert.equal(snapshot.metrics.profiles,2);
      }finally{await db.exec('rollback');}
    });
    await t.test('new inherited PUBLIC mutation function fails closed before counts',async()=>{
      await db.exec('begin');
      try{
        await db.exec('create function public.accidental_public_write() returns void language sql security definer as $$delete from public.jobs;$$');
        await assert.rejects(asReader(db,claims(),undefined,true),/unreviewed routine/);
      }finally{await db.exec('rollback');}
    });
    await t.test('exact audited input-only helper is allowed; changed body/settings are rejected',async()=>{
      assert.equal(createHash('md5').update(reviewedHelperBody).digest('hex'),'b9f07ff05df2af5ff6c3552f382a7565');
      await db.exec(`alter table public.profiles
        add column display_name text,add column avatar_url text,add column location text,add column bio text,
        add column skills text[],add column availability text,add column experience text,add column pay_expectation text,
        add column cafe_name text,add column cafe_address text,add column open_hours text,add column shop_type text,add column barista_preferences text[];
        create function public.profile_meets_visibility_requirements(p public.profiles)
          returns boolean language sql immutable security invoker set search_path='' as $$${reviewedHelperBody}$$;`);
      assert.equal((await asReader(db,claims())).rows[0].snapshot.metrics.profiles,2);
      for(const change of [
        "create or replace function public.profile_meets_visibility_requirements(p public.profiles) returns boolean language sql immutable security invoker set search_path='' as $$select true;$$",
        'alter function public.profile_meets_visibility_requirements(public.profiles) security definer',
        'alter function public.profile_meets_visibility_requirements(public.profiles) stable',
        'alter function public.profile_meets_visibility_requirements(public.profiles) reset all',
      ]){
        await db.exec('begin');
        try{await db.exec(change);await assert.rejects(asReader(db,claims(),undefined,true),/unreviewed routine/);}finally{await db.exec('rollback');}
      }
    });
    await t.test('routine ownership drift and inherited schema CREATE fail closed',async()=>{
      for(const [change,expected] of [
        ['alter function bjm_office_private.read_snapshot() owner to postgres',/ownership/],
        ['grant create on schema public to public',/schema CREATE/],
      ]){
        await db.exec('begin');
        try{await db.exec(change);await assert.rejects(asReader(db,claims(),undefined,true),expected);}finally{await db.exec('rollback');}
      }
    });
    await t.test('new PUBLIC table grants fail closed and cannot silently widen role',async()=>{
      await db.exec('begin');
      try {await db.exec('grant select on public.profiles to public');await assert.rejects(asReader(db,claims(),undefined,true),/inherited table/);}finally{await db.exec('rollback');}
    });
    await t.test('restrictive RLS cannot silently turn a real count into zero',async()=>{
      await db.exec('begin');
      try{await db.exec('create policy surprise on public.profiles as restrictive for select to public using(false)');await assert.rejects(asReader(db,claims(),undefined,true),/restrictive RLS/);}finally{await db.exec('rollback');}
    });
    await t.test('hook modifies only exact client claims and preserves all customer payloads',async()=>{
      const input={user_id:OWNER,claims:{...claims(),role:'authenticated',aud:'authenticated',custom:'preserved'},authentication_method:'oauth_provider/authorization_code',extra:'preserved'};
      await db.exec('set role supabase_auth_admin');
      try{
        const changed=(await db.query('select bjm_office_private.office_access_token_hook($1::jsonb) as event',[JSON.stringify(input)])).rows[0].event;
        assert.deepEqual(changed,{...input,claims:{...input.claims,role:'bjm_office_reader',aud:'https://office.example/mcp'}});
        for(const customer of [{...input,claims:{...input.claims,client_id:OTHER}},{...input,claims:{sub:OWNER,role:'authenticated',aud:'authenticated'}}]){
          assert.deepEqual((await db.query('select bjm_office_private.office_access_token_hook($1::jsonb) as event',[JSON.stringify(customer)])).rows[0].event,customer);
        }
      }finally{await db.exec('reset role');}
    });
    await t.test('disabled read boundary never restores customer privileges to dedicated client',async()=>{
      await db.exec('begin');
      try{
        await db.exec('update bjm_office_private.configuration set enabled=false');
        await db.exec('set local role supabase_auth_admin');
        const event={claims:claims({role:'authenticated',aud:'authenticated'})};
        const changed=(await db.query('select bjm_office_private.office_access_token_hook($1::jsonb) as event',[JSON.stringify(event)])).rows[0].event;
        assert.equal(changed.claims.role,'bjm_office_reader');assert.equal(changed.claims.aud,'https://office.example/mcp');
      }finally{await db.exec('rollback');}
    });
    await t.test('normal customer role keeps its pre-existing mutation access',async()=>{
      await db.exec('set role authenticated');
      try{await db.exec('select public.customer_write()');}finally{await db.exec('reset role');}
      assert.equal((await db.query('select count(*)::int as n from public.jobs')).rows[0].n,2);
    });
  }finally{await db.close();}
});

test('review package refuses inherited PUBLIC routines before commit',async()=>{
  const db=new PGlite();
  try{
    await db.exec(fixture);
    await db.exec('create function public.accidental_default_execute() returns integer language sql as $$select 1;$$');
    await assert.rejects(db.exec(reviewSql),/unreviewed routine/);
    await db.exec('rollback');
    assert.equal((await db.query("select count(*)::int as n from pg_roles where rolname='bjm_office_reader'")).rows[0].n,0);
  }finally{await db.close();}
});

async function prepareNonSuperuserInstaller(db, allowAuthDelegation=false, allowSourceDelegation=false) {
  await db.exec(fixture);
  await db.exec(`
    create role migration_runner login createrole noinherit nobypassrls;
    create role migration_auditor;
    grant migration_auditor to migration_runner with set true, inherit false, admin true;
    do $$begin execute format('grant create on database %I to migration_runner',current_database()); end$$;
    grant usage,create on schema public to migration_runner with grant option;
    grant usage on schema auth to migration_runner ${allowAuthDelegation?'with grant option':''};
    grant select on auth.users,auth.sessions to migration_runner ${allowSourceDelegation?'with grant option':''};
    alter table public.profiles owner to migration_runner;
    alter table public.jobs owner to migration_runner;
    alter table public.applications owner to migration_runner;
    alter table public.cafe_subscriptions owner to migration_runner;
    alter table public.subscription_payments owner to migration_runner;
    alter table public.support_tickets owner to migration_runner;
    set session authorization migration_runner;
    set createrole_self_grant='';
  `);
  assert.equal((await db.query('select rolsuper from pg_roles where rolname=current_user')).rows[0].rolsuper,false);
}
const installerMemberships = db => db.query(`
  select pg_get_userbyid(roleid) as granted_role,pg_get_userbyid(grantor) as grantor,admin_option,inherit_option,set_option
  from pg_auth_members where member='migration_runner'::regrole order by granted_role,grantor
`);

test('non-superuser CREATEROLE install is inert before callback and removes only its temporary SET grant',async()=>{
  const db=new PGlite();
  try{
    await prepareNonSuperuserInstaller(db);
    const before=(await installerMemberships(db)).rows;
    await db.exec(reviewSql);
    const memberships=(await installerMemberships(db)).rows;
    assert.deepEqual(memberships.filter(row=>row.granted_role==='migration_auditor'),before);
    const aggregate=memberships.filter(row=>row.granted_role==='bjm_office_aggregate');
    assert.deepEqual(aggregate,[{granted_role:'bjm_office_aggregate',grantor:'postgres',admin_option:true,inherit_option:false,set_option:false}]);
    assert.equal((await db.query("select pg_has_role(current_user,'bjm_office_aggregate','SET') as can_set")).rows[0].can_set,false);
    assert.equal((await db.query('select count(*)::int as n from bjm_office_private.configuration')).rows[0].n,0);
    await assert.rejects(asReader(db,claims()),/Office access denied/);
    const customer={claims:{sub:OWNER,role:'authenticated',aud:'authenticated'},authentication_method:'password'};
    await db.exec('set role supabase_auth_admin');
    try{
      assert.deepEqual((await db.query('select bjm_office_private.office_access_token_hook($1::jsonb) as event',[JSON.stringify(customer)])).rows[0].event,customer);
    }finally{await db.exec('reset role');}
  }finally{await db.close();}
});

test('non-superuser install preserves a pre-existing same-grantor membership and all its options',async()=>{
  const db=new PGlite();
  try{
    await prepareNonSuperuserInstaller(db);
    // Simulate an existing creator-side relationship before temporary ownership
    // work. This tests restoring SET without revoking legitimate INHERIT or
    // the separate bootstrap-granted ADMIN relationship.
    const withPriorGrant=reviewSql.replace('-- Hosted postgres is CREATEROLE',
      'grant bjm_office_aggregate to current_user with set false, inherit true, admin false granted by current_user;\n-- Hosted postgres is CREATEROLE');
    await db.exec(withPriorGrant);
    assert.deepEqual((await installerMemberships(db)).rows.filter(row=>row.granted_role==='bjm_office_aggregate'&&row.grantor==='migration_runner'),
      [{granted_role:'bjm_office_aggregate',grantor:'migration_runner',admin_option:false,inherit_option:true,set_option:false}]);
    assert.equal((await db.query("select pg_has_role(current_user,'bjm_office_aggregate','SET') as can_set")).rows[0].can_set,false);
  }finally{await db.close();}
});

test('failed non-superuser install rolls back new roles and temporary membership without disturbing existing grants',async()=>{
  const db=new PGlite();
  try{
    await prepareNonSuperuserInstaller(db);
    const before=(await installerMemberships(db)).rows;
    await db.exec('create function public.unreviewed_public_routine() returns integer language sql as $$select 1;$$');
    await assert.rejects(db.exec(reviewSql),/unreviewed routine/);
    await db.exec('rollback');
    assert.equal((await db.query("select count(*)::int as n from pg_roles where rolname in ('bjm_office_reader','bjm_office_aggregate')")).rows[0].n,0);
    assert.deepEqual((await installerMemberships(db)).rows,before);
  }finally{await db.close();}
});

test('review package rejects an unreviewed applying-role/session-role switch before creating roles',async()=>{
  const db=new PGlite();
  try{
    await db.exec(fixture);
    await db.exec('create role switched_runner createrole; set role switched_runner');
    await assert.rejects(db.exec(reviewSql),/authenticated migration session role/);
    await db.exec('rollback; reset role');
    assert.equal((await db.query("select count(*)::int as n from pg_roles where rolname in ('bjm_office_reader','bjm_office_aggregate')")).rows[0].n,0);
  }finally{await db.close();}
});

test('non-superuser view install needs existing Auth reads and no schema/table grant options',async()=>{
  const db=new PGlite();
  try{
    await prepareNonSuperuserInstaller(db,false,false);
    assert.equal((await db.query("select has_schema_privilege(current_user,'auth','USAGE WITH GRANT OPTION') as can_delegate")).rows[0].can_delegate,false);
    assert.equal((await db.query("select has_table_privilege(current_user,'auth.sessions','SELECT WITH GRANT OPTION') as can_delegate")).rows[0].can_delegate,false);
    await db.exec(reviewSql);
    assert.equal((await db.query("select has_schema_privilege('bjm_office_aggregate','auth','USAGE') as raw_usage")).rows[0].raw_usage,false);
    assert.equal((await db.query("select has_any_column_privilege('bjm_office_aggregate','auth.sessions','SELECT') as raw_read")).rows[0].raw_read,false);
  }finally{await db.close();}
});

test('non-superuser view install rolls back if its trusted owner cannot read Auth sources',async()=>{
  const db=new PGlite();
  try{
    await prepareNonSuperuserInstaller(db,false,false);
    const before=(await installerMemberships(db)).rows;
    await db.exec('set session authorization postgres; revoke select on auth.sessions from migration_runner; set session authorization migration_runner');
    await assert.rejects(db.exec(reviewSql),/owner Auth read privileges changed/);
    await db.exec('rollback');
    assert.equal((await db.query("select count(*)::int as n from pg_roles where rolname in ('bjm_office_reader','bjm_office_aggregate')")).rows[0].n,0);
    assert.deepEqual((await installerMemberships(db)).rows,before);
  }finally{await db.close();}
});
